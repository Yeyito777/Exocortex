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
import type { KeyResult } from "./focus";
import { scrollBy } from "./chat";
import { activateSidebarItem, sidebarHitTest, scrollSidebar, SIDEBAR_WIDTH } from "./sidebar";
import { mouse_cursor_pointer, mouse_cursor_text, mouse_cursor_hand } from "./terminal";
import { clampCol, ensureCursorVisible } from "./historycursor";
import { editMessageItemIndexAtMouse } from "./editmessage";
import { sameSidebarItem } from "./sidebar/items";
import { focusSidebarItem } from "./sidebar/selection";

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
  const col = clampCol(viewportRow.startCol + sourceCol, lines, lineIdx);
  return { row: lineIdx, col };
}

// ── Cursor shape ──────────────────────────────────────────────────

type CursorShape = "pointer" | "text" | "hand";

/**
 * Determine the desired cursor shape for a mouse position.
 * - "text" for text-content areas (prompt, chat history)
 * - "hand" for clickable elements (sidebar conversation entries)
 * - "pointer" for non-interactive chrome (topbar, separators, statusbar, sidebar header)
 */
function cursorZone(col: number, row: number, state: RenderState): CursorShape {
  const { layout, sidebar } = state;

  // Sidebar area
  if (sidebar.open && col <= SIDEBAR_WIDTH) {
    // Hand for clickable conversation entries, pointer for chrome
    return sidebarHitTest(row, state.rows, sidebar) !== null ? "hand" : "pointer";
  }

  // Message area (chat history) → text, except for the task panel itself.
  if (row >= 3 && layout.sepAbove > 0 && row < layout.sepAbove) {
    return isInsideTaskPanel(col, row, state) ? "pointer" : "text";
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

// ── Event handler ─────────────────────────────────────────────────

export function handleMouseEvent(ev: MouseEvent, state: RenderState): KeyResult {
  // Always update cursor shape on any mouse event (motion, press, scroll)
  updateMouseCursor(ev.col, ev.row, state);

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
  if (state.sidebar.conversationActionMenu) return { type: "handled" };

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
