/**
 * Mouse event routing.
 *
 * Handles mouse clicks, scroll wheel, motion-based focus switching,
 * and X cursor shape updates. Separated from focus.ts (keyboard routing)
 * since mouse events have fundamentally different dispatch logic:
 * coordinate-based hit-testing rather than modal key interpretation.
 */

import type { MouseEvent } from "./input";
import type { RenderState } from "./state";
import { focusHistory, focusPrompt, focusSidebar } from "./state";
import { handleConversationActionMenuResult, type KeyResult } from "./focus";
import { scrollBy } from "./chat";
import {
  activateSidebarItem,
  conversationActionMenuAnchorRow,
  conversationActionMenuHitTest,
  handleConversationActionMenuMouse,
  openSelectedConversationActionMenu,
  sidebarHitTest,
  scrollSidebar,
  SIDEBAR_WIDTH,
} from "./sidebar";
import { mouse_cursor_pointer, mouse_cursor_text, mouse_cursor_hand } from "./terminal";
import { clampCol, ensureCursorVisible } from "./historycursor";
import { editMessageItemIndexAtMouse } from "./editmessage";
import { sameSidebarItem } from "./sidebar/items";
import { focusSidebarItem } from "./sidebar/selection";
import { imageAtHistoryPosition, openableTargetAtHistoryPosition } from "./historyopenable";
import { nextGrapheme } from "./textwidth";
import { stripAnsi } from "./historymotions";
import type { InlineImageTarget } from "./inlineimages";

// ── Constants ─────────────────────────────────────────────────────

const SCROLL_LINES = 3;

function isInsideTaskPanel(col: number, row: number, state: RenderState): boolean {
  const rect = state.layout.taskPanelRect;
  return !!rect
    && row >= rect.top
    && row <= rect.bottom
    && col >= rect.left
    && col <= rect.right;
}

// ── Screen-to-history coordinate mapping ──────────────────────────

/**
 * Map a screen (col, row) to a historyLines (lineIdx, col).
 * Returns null if the position is outside the message area or beyond content.
 */
function screenToHistoryPos(
  screenCol: number, screenRow: number, state: RenderState,
): { row: number; col: number } | null {
  const { layout } = state;
  const lines = state.historyLines;
  const totalLines = lines.length;

  // Must be inside the message area (rows 3 to sepAbove-1)
  if (screenRow < 3 || layout.sepAbove <= 0 || screenRow >= layout.sepAbove) return null;
  if (isInsideTaskPanel(screenCol, screenRow, state)) return null;

  const viewportRow = layout.historyViewportRows[screenRow - 3];
  if (!viewportRow) return null;
  const lineIdx = viewportRow.lineIndex;
  if (lineIdx < 0 || lineIdx >= totalLines) return null;

  // Map screen column to content column (account for sidebar offset)
  const contentCol = screenCol - layout.chatCol;
  const sourceCol = Math.max(0, contentCol - viewportRow.displayPrefixWidth);
  const plain = stripAnsi(lines[lineIdx]);
  let offset = viewportRow.startCol;
  let width = 0;
  while (offset < plain.length) {
    const [size, end] = nextGrapheme(plain, offset);
    if (width + size > sourceCol) break;
    width += size;
    offset = end;
  }
  const col = clampCol(offset, lines, lineIdx);
  return { row: lineIdx, col };
}

/** Exact hit test for images: in a strip, the click must land on a thumbnail, caption, or `› +N`. */
function imageAtScreen(col: number, row: number, state: RenderState): InlineImageTarget | null {
  const viewport = state.layout.historyViewportRows[row - 3];
  if (!viewport) return null;
  const plain = stripAnsi(state.historyLines[viewport.lineIndex] ?? "");
  const column = col - state.layout.chatCol - viewport.displayPrefixWidth;
  if (column < 0) return null;
  let width = 0;
  let offset = viewport.startCol;
  while (offset < plain.length) {
    const [size, end] = nextGrapheme(plain, offset);
    if (column < width + size) break;
    width += size;
    offset = end;
  }
  // Past the end of the row, columns continue one per cell.
  if (offset >= plain.length) offset += column - width;
  return imageAtHistoryPosition({ lineAnchors: state.historyLineAnchors }, { row: viewport.lineIndex, col: offset }, true);
}

/** Exact hit test: unlike selection, whitespace beyond a row must not clamp onto its last link. */
function linkAtScreen(col: number, row: number, state: RenderState): string | null {
  const { layout } = state;
  if (state.editMessagePrompt || state.queuePrompt || state.sidebar.conversationActionMenu) return null;
  if (row < 3 || row >= layout.sepAbove || col < layout.chatCol || col > state.cols || isInsideTaskPanel(col, row, state)) return null;
  const viewport = layout.historyViewportRows[row - 3];
  if (!viewport) return null;
  const plain = stripAnsi(state.historyLines[viewport.lineIndex] ?? "");
  const column = col - layout.chatCol - viewport.displayPrefixWidth;
  if (column < 0) return null;
  let width = 0;
  for (let offset = viewport.startCol; offset < Math.min(plain.length, viewport.endCol ?? plain.length);) {
    const [size, end] = nextGrapheme(plain, offset);
    if (column >= width && column < width + size) {
      return openableTargetAtHistoryPosition({
        lines: state.historyLines,
        wrapContinuation: state.historyWrapContinuation,
        wrapJoiners: state.historyWrapJoiners,
        copyLines: state.historyCopyLines,
        lineAnchors: state.historyLineAnchors,
      }, { row: viewport.lineIndex, col: offset });
    }
    width += size;
    offset = end;
  }
  return null;
}

/**
 * Whether a left click at this history cell opens something: a link or
 * openable path (release on the same cell) or an inline image, strip
 * thumbnail, caption or `› +N` (exact hit, so strip gaps do not count).
 * Mirrors the press handler's own hit tests so hover and click agree.
 */
function historyClickableAtScreen(col: number, row: number, state: RenderState): boolean {
  if (!screenToHistoryPos(col, row, state)) return false;
  return linkAtScreen(col, row, state) !== null || imageAtScreen(col, row, state) !== null;
}

// ── Cursor shape ──────────────────────────────────────────────────

type CursorShape = "pointer" | "text" | "hand";

/**
 * Determine the desired cursor shape for a mouse position.
 * - "hand" for anything a click acts on (sidebar entries, menu actions,
 *   edit-message picker rows, history links/paths/images)
 * - "text" for text-content areas (prompt, chat history)
 * - "pointer" for non-interactive chrome (topbar, separators, statusbar, sidebar header)
 *   and modal backdrops whose click only dismisses (image viewer, menus)
 */
export function cursorZone(col: number, row: number, state: RenderState): CursorShape {
  const { layout, sidebar } = state;

  // The image viewer covers everything; a click anywhere only closes it.
  if (state.imageModal) return "pointer";

  if (state.editMessagePrompt) {
    return editMessageItemIndexAtMouse(state, col, row) !== null ? "hand" : "pointer";
  }

  const menu = sidebar.conversationActionMenu;
  if (menu) {
    const anchorRow = conversationActionMenuAnchorRow(sidebar, menu.convId);
    const hit = conversationActionMenuHitTest(
      menu,
      anchorRow,
      SIDEBAR_WIDTH + 1,
      state.rows,
      state.cols,
      col,
      row,
    );
    // The open menu is modal: action rows are clickable, while every other
    // location is an outside-click dismissal target rather than underlying UI.
    return hit && hit !== "chrome" ? "hand" : "pointer";
  }

  // Sidebar area
  if (sidebar.open && col <= SIDEBAR_WIDTH) {
    // Hand for clickable conversation entries, pointer for chrome
    return sidebarHitTest(row, state.rows, sidebar) !== null ? "hand" : "pointer";
  }

  // Message area (chat history) → text, except for the task panel itself.
  // The queue prompt swallows clicks, so nothing under it is clickable.
  if (row >= 3 && layout.sepAbove > 0 && row < layout.sepAbove) {
    if (isInsideTaskPanel(col, row, state)) return "pointer";
    return !state.queuePrompt && historyClickableAtScreen(col, row, state) ? "hand" : "text";
  }

  // Prompt input area → text
  if (layout.firstInputRow > 0 && row >= layout.firstInputRow && row < layout.sepBelow) return "text";

  // Everything else (topbar, separators, status line) → pointer
  return "pointer";
}

const CURSOR_ESCAPE: Record<CursorShape, string> = {
  text: mouse_cursor_text,
  pointer: mouse_cursor_pointer,
  hand: mouse_cursor_hand,
};

/** Update the X cursor shape via OSC 777 if the zone changed. */
function updateMouseCursor(col: number, row: number, state: RenderState): void {
  const zone = cursorZone(col, row, state);
  if (zone !== state.mouseCursor) {
    state.mouseCursor = zone;
    process.stdout.write(CURSOR_ESCAPE[zone]);
  }
}

/** Remember the pointer cell and update its shape, even for input an overlay swallows. */
export function trackMouseCursor(ev: Pick<MouseEvent, "col" | "row">, state: RenderState): void {
  state.mousePosition = { col: ev.col, row: ev.row };
  updateMouseCursor(ev.col, ev.row, state);
}

/** Re-evaluate the shape at the last pointer cell once a render moved content or overlays under it. */
export function refreshMouseCursor(state: RenderState): void {
  const position = state.mousePosition;
  if (position) updateMouseCursor(position.col, position.row, state);
}

// ── Event handler ─────────────────────────────────────────────────

export function handleMouseEvent(ev: MouseEvent, state: RenderState): KeyResult {
  if (ev.action === "press" || (ev.action === "motion" && state.mouseLinkPress
      && (ev.col !== state.mouseLinkPress.col || ev.row !== state.mouseLinkPress.row))) state.mouseLinkPress = null;
  if (ev.action === "press" || (ev.action === "motion" && state.mouseImagePress
      && (ev.col !== state.mouseImagePress.col || ev.row !== state.mouseImagePress.row))) state.mouseImagePress = null;
  // Always update cursor shape on any mouse event (motion, press, scroll)
  trackMouseCursor(ev, state);

  // Modal overlays intercept mouse events.  The edit-message modal is clickable:
  // clicking a visible item selects it and confirms, matching Enter on that row.
  if (state.editMessagePrompt) {
    if (ev.button === 0 && ev.action === "press") {
      const itemIndex = editMessageItemIndexAtMouse(state, ev.col, ev.row);
      if (itemIndex !== null) {
        state.editMessagePrompt.selection = itemIndex;
        return { type: "edit_message_confirm" };
      }
    }
    return { type: "handled" };
  }
  if (state.queuePrompt) return { type: "handled" };
  if (state.sidebar.conversationActionMenu) {
    const menu = state.sidebar.conversationActionMenu;
    const result = handleConversationActionMenuMouse(
      menu,
      ev,
      conversationActionMenuAnchorRow(state.sidebar, menu.convId),
      SIDEBAR_WIDTH + 1,
      state.rows,
      state.cols,
    );
    return handleConversationActionMenuResult(result, state);
  }

  const { col, row, button, action } = ev;
  const { layout, sidebar } = state;
  const sidebarOpen = sidebar.open;
  const inSidebar = sidebarOpen && col <= SIDEBAR_WIDTH;

  // ── Focus follows mouse ─────────────────────────────────────────
  if (inSidebar && state.panelFocus !== "sidebar") {
    focusSidebar(state);
  } else if (!inSidebar && state.panelFocus === "sidebar") {
    state.panelFocus = "chat";
  }

  // Sidebar selection follows the pointer. This makes keyboard actions such
  // as `;` apply to the conversation currently under the mouse without loading
  // it; clicking still performs the existing activation behavior below.
  if (inSidebar && action === "motion") {
    const hovered = sidebarHitTest(row, state.rows, sidebar);
    if (hovered && !sameSidebarItem(sidebar.selectedItem, hovered)) {
      focusSidebarItem(sidebar, hovered);
    }
  }

  // ── Drag (motion with left button held) — extend visual selection ──
  if (action === "motion" && button === 0) {
    if (state.vim.mode === "visual" && state.chatFocus === "history") {
      const pos = screenToHistoryPos(col, row, state);
      if (pos) {
        state.historyCursor = pos;
        ensureCursorVisible(state);
      }
    }
    return { type: "handled" };
  }

  // Motion events — focus + cursor shape already handled, nothing else to do
  if (action === "motion") return { type: "handled" };

  // ── Scroll wheel ────────────────────────────────────────────────
  if (button === 64 || button === 65) {
    if (action !== "press") return { type: "handled" };
    const delta = button === 64 ? SCROLL_LINES : -SCROLL_LINES;

    if (inSidebar) {
      scrollSidebar(sidebar, button === 64 ? -1 : 1);
      return { type: "handled" };
    }

    // Chat message area or anywhere else: scroll messages
    scrollBy(state, delta);
    return { type: "handled" };
  }

  // ── Right click (button 2) ──────────────────────────────────────
  if (button === 2 && action === "press" && inSidebar) {
    // Select the item under the click without activating it, then open the same
    // conversation-actions menu as the keyboard `;` shortcut.
    const item = sidebarHitTest(row, state.rows, sidebar);
    if (item) {
      focusSidebarItem(sidebar, item);
      openSelectedConversationActionMenu(sidebar);
    }
    return { type: "handled" };
  }

  // ── Left click (button 0) ───────────────────────────────────────
  if (button === 0 && action === "press") {
    if (inSidebar) {
      // Click on a sidebar item — focus already set above.
      const item = sidebarHitTest(row, state.rows, sidebar);
      if (item) {
        const result = activateSidebarItem(sidebar, item);
        if (result.type === "select") return { type: "load_conversation", convId: result.convId };
        if (result.type === "open_folder_instructions") return { type: "open_folder_instructions", folderId: result.folderId };
        return { type: "handled" };
      }
      return { type: "handled" };
    }

    // Click in message area → start visual selection at clicked position
    const pos = screenToHistoryPos(col, row, state);
    if (pos) {
      const target = linkAtScreen(col, row, state);
      state.mouseLinkPress = target ? { col, row, target } : null;
      const image = imageAtScreen(col, row, state);
      state.mouseImagePress = image ? { col, row, image } : null;
      focusHistory(state);
      state.vim.mode = "visual";
      state.historyCursor = pos;
      state.historyVisualAnchor = { ...pos };
      ensureCursorVisible(state);
      return { type: "handled" };
    }

    // Click in prompt area → focus prompt
    if (layout.firstInputRow > 0 && row >= layout.firstInputRow && row < layout.sepBelow) {
      focusPrompt(state);
      return { type: "handled" };
    }
  }

  // ── Left button release — finalize visual selection ─────────────
  if (button === 0 && action === "release") {
    const pressedLink = state.mouseLinkPress;
    state.mouseLinkPress = null;
    if (pressedLink && pressedLink.col === col && pressedLink.row === row
        && linkAtScreen(col, row, state) === pressedLink.target) {
      state.vim.mode = "normal";
      return { type: "open_target", target: pressedLink.target };
    }
    const pressedImage = state.mouseImagePress;
    state.mouseImagePress = null;
    if (pressedImage && pressedImage.col === col && pressedImage.row === row) {
      state.vim.mode = "normal";
      return { type: "open_image", target: pressedImage.image };
    }
    if (state.vim.mode === "visual" && state.chatFocus === "history") {
      // Update cursor to release position
      const pos = screenToHistoryPos(col, row, state);
      if (pos) state.historyCursor = pos;

      // If anchor == cursor (just a click, no drag), exit visual mode
      if (state.historyCursor.row === state.historyVisualAnchor.row
          && state.historyCursor.col === state.historyVisualAnchor.col) {
        state.vim.mode = "normal";
        return { type: "handled" };
      }

      // Selection stays visible — user can yank with y or dismiss with Escape,
      // just like keyboard visual mode. Copy is not automatic.
      return { type: "handled" };
    }
  }

  return { type: "handled" };
}
