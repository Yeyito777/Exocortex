/**
 * Vim result interpreter.
 *
 * Takes a key event, runs it through the vim engine, and applies the
 * resulting state mutations (buffer edits, cursor moves, mode changes,
 * undo/redo, clipboard, visual anchoring). Returns a KeyResult for
 * the caller (focus.ts) or null if vim didn't consume the key.
 *
 * Separated from focus.ts because this is purely about interpreting
 * VimResult → RenderState, whereas focus.ts is about routing keys
 * to the right handler based on panel focus.
 */

import type { KeyEvent } from "./input";
import type { RenderState } from "./state";
import { focusPrompt } from "./state";
import type { Action } from "./keybinds";
import type { KeyResult } from "./focus";
import {
  scrollUp, scrollDown,
  scrollLineUp, scrollLineDown,
  scrollHalfUp, scrollHalfDown,
  scrollPageUp, scrollPageDown,
  scrollToTop, scrollToBottom,
} from "./chat";
import { handleSidebarAction, type SidebarKeyResult } from "./sidebar";
import { processKey, copyToClipboard, pasteFromClipboard, type VimContext } from "./vim";
import { clampNormal } from "./vim/buffer";
import { pushUndo, markInsertEntry, commitInsertSession, undo as undoFn, redo as redoFn } from "./undo";
import {
  ensureCursorVisible,
  handleHistoryFind as historyFindHandler,
  handleHistoryTextObject as historyTextObjectHandler,
  handleHistoryCursorAction,
  scrollHalfPageWithCursor, scrollFullPageWithCursor, scrollLineWithStickyCursor,
} from "./historycursor";
import { handleMessageTextObject } from "./vim/message";

// ── Vim context resolver ──────────────────────────────────────────

export function getVimContext(state: RenderState): VimContext {
  if (state.panelFocus === "sidebar") return "sidebar";
  return state.chatFocus === "prompt" ? "prompt" : "history";
}

// ── Vim key processing ────────────────────────────────────────────

/**
 * Run the key through the vim engine.
 * Returns a KeyResult if vim consumed the key, or null for passthrough.
 */
export function processVimKey(key: KeyEvent, state: RenderState): KeyResult | null {
  const context = getVimContext(state);

  // History-specific find handling: f/F/;/, operate on history lines, not prompt buffer
  if (context === "history" && state.vim.mode !== "insert") {
    if (historyFindHandler(key, state)) return { type: "handled" };
  }

  // Message text object (im/am) — intercept before engine for all contexts
  const msgResult = handleMessageTextObject(key, state, context);
  if (msgResult) return msgResult;

  // History text objects (iw, aw, i", a", vi(, etc.) — resolve against
  // history lines instead of the prompt buffer the engine receives
  if (context === "history" && state.vim.pendingTextObjectModifier) {
    const htResult = historyTextObjectHandler(key, state);
    if (htResult) return htResult;
  }

  const prevMode = state.vim.mode;
  const result = processKey(key, state.vim, context, state.inputBuffer, state.cursorPos);

  switch (result.type) {
    case "passthrough":
      return null;

    case "noop":
    case "pending":
      return { type: "handled" };

    case "cursor_move":
      state.cursorPos = result.cursor;
      return { type: "handled" };

    case "buffer_edit":
      if (result.mode === "insert") {
        // Commands that edit + enter insert (o, O, c, C, cc):
        // Mark insert entry with state BEFORE the edit — the entire
        // edit + insert session is one undo unit (like vim).
        markInsertEntry(state.undo, state.inputBuffer, state.cursorPos);
      } else {
        // Pure normal-mode edit (dd, x, D, etc) — standalone undo unit
        pushUndo(state.undo, state.inputBuffer, state.cursorPos);
      }
      state.inputBuffer = result.buffer;
      state.cursorPos = result.cursor;
      if (result.mode) {
        state.vim.mode = result.mode;
      } else {
        state.cursorPos = clampNormal(state.inputBuffer, state.cursorPos);
      }
      return { type: "handled" };

    case "yank":
      copyToClipboard(result.text);
      return { type: "handled" };

    case "paste":
      handlePaste(result.position, state);
      return { type: "handled" };

    case "visual_edit":
      if (result.mode === "insert") {
        // visual c — edit + insert is one undo unit
        markInsertEntry(state.undo, state.inputBuffer, state.cursorPos);
      } else {
        // visual d — standalone undo unit
        pushUndo(state.undo, state.inputBuffer, state.cursorPos);
      }
      state.inputBuffer = result.buffer;
      state.cursorPos = result.cursor;
      state.vim.mode = result.mode;
      return { type: "handled" };

    case "undo": {
      const snap = undoFn(state.undo, state.inputBuffer, state.cursorPos);
      if (snap) {
        state.inputBuffer = snap.buffer;
        state.cursorPos = clampNormal(snap.buffer, snap.cursor);
      }
      return { type: "handled" };
    }

    case "redo": {
      const snap = redoFn(state.undo, state.inputBuffer, state.cursorPos);
      if (snap) {
        state.inputBuffer = snap.buffer;
        state.cursorPos = clampNormal(snap.buffer, snap.cursor);
      }
      return { type: "handled" };
    }

    case "mode_change":
      // Commit insert session when leaving insert mode
      // (prevMode needed because engine mutates vim.mode before returning)
      if (prevMode === "insert" && result.mode !== "insert") {
        commitInsertSession(state.undo, state.inputBuffer);
      }
      state.vim.mode = result.mode;
      if (result.cursor !== undefined) state.cursorPos = result.cursor;
      // Mark insert entry when entering insert mode
      if (result.mode === "insert") {
        markInsertEntry(state.undo, state.inputBuffer, state.cursorPos);
      }
      // Set visual anchor for history when entering visual mode
      if ((result.mode === "visual" || result.mode === "visual-line")
          && state.chatFocus === "history") {
        state.historyVisualAnchor = { ...state.historyCursor };
      }
      // If switching to insert from sidebar/history, also focus prompt
      if (result.mode === "insert" && state.chatFocus !== "prompt") {
        state.chatFocus = "prompt";
      }
      return { type: "handled" };

    case "action":
      return handleVimAction(result.action, state);
  }
}

// ── Vim action dispatch ───────────────────────────────────────────

/** Handle an action produced by the vim engine. */
function handleVimAction(action: string, state: RenderState): KeyResult {
  // History cursor actions (including visual yank)
  if ((action as Action).startsWith("history_")) {
    return handleHistoryCursorAction(action as Action, state);
  }

  switch (action) {
    case "quit":
      return { type: "quit" };
    case "focus_prompt":
      // Vim i/a in sidebar/history → focus prompt + enter insert
      focusPrompt(state);
      return { type: "handled" };
    case "nav_up":
      return handleContextNavigation("up", state);
    case "nav_down":
      return handleContextNavigation("down", state);
    case "nav_select":
    case "delete":
    case "undo_delete":
    case "mark":
    case "pin":
    case "move_up":
    case "move_down":
    case "clone":
      return trySidebarAction(action, state);
    case "scroll_top":
    case "scroll_bottom":
      handleScrollAction(action as Action, state);
      return { type: "handled" };
    default:
      return { type: "handled" };
  }
}

// ── Sidebar result mapping ────────────────────────────────────────

/**
 * Dispatch an action to the sidebar if focused, mapping the result
 * to a KeyResult. Returns "handled" if sidebar isn't focused.
 */
function trySidebarAction(action: string, state: RenderState): KeyResult {
  if (state.panelFocus !== "sidebar") return { type: "handled" };
  return mapSidebarResult(handleSidebarAction(action, state.sidebar));
}

/** Map a SidebarKeyResult to a KeyResult. */
export function mapSidebarResult(result: SidebarKeyResult): KeyResult {
  switch (result.type) {
    case "select":
      return { type: "load_conversation", convId: result.convId };
    case "handled":
    case "unhandled":
      return { type: "handled" };
    default:
      // Remaining variants (delete_conversation, undo_delete, mark_conversation,
      // rename_conversation, pin_conversation, move_conversation,
      // clone_conversation) are directly valid KeyResult types — forward as-is.
      return result;
  }
}

/** Handle j/k vim actions in sidebar or history context. */
function handleContextNavigation(dir: "up" | "down", state: RenderState): KeyResult {
  if (state.panelFocus === "sidebar") {
    const result = handleSidebarAction(dir === "up" ? "nav_up" : "nav_down", state.sidebar);
    if (result.type === "select") {
      return { type: "load_conversation", convId: result.convId };
    }
    return { type: "handled" };
  }
  // History scroll
  if (state.chatFocus === "history") {
    if (dir === "up") scrollUp(state);
    else scrollDown(state);
  }
  return { type: "handled" };
}

// ── Paste handling ────────────────────────────────────────────────

/** Async paste from clipboard. Reads clipboard, inserts into buffer. */
function handlePaste(position: "after" | "before", state: RenderState): void {
  pasteFromClipboard().then((text) => {
    if (!text) return;

    pushUndo(state.undo, state.inputBuffer, state.cursorPos);
    const buf = state.inputBuffer;
    const cursor = state.cursorPos;
    const insertAt = position === "after" ? cursor + 1 : cursor;
    const pos = Math.min(insertAt, buf.length);

    state.inputBuffer = buf.slice(0, pos) + text + buf.slice(pos);
    state.cursorPos = clampNormal(state.inputBuffer, pos + text.length - 1);
  });
}

// ── Scroll dispatch ───────────────────────────────────────────────

/**
 * Route scroll actions. When history cursor is active, uses vim-style
 * cursor-aware scrolling. Otherwise falls back to viewport-only scroll.
 */
export function handleScrollAction(action: Action, state: RenderState): void {
  const inHistory = state.panelFocus === "chat" && state.chatFocus === "history";

  if (inHistory) {
    // Vim-style: cursor moves with scroll
    switch (action) {
      case "scroll_line_up":   scrollLineWithStickyCursor(state, 1);  return;
      case "scroll_line_down": scrollLineWithStickyCursor(state, -1); return;
      case "scroll_half_up":   scrollHalfPageWithCursor(state, 1);    return;
      case "scroll_half_down": scrollHalfPageWithCursor(state, -1);   return;
      case "scroll_page_up":   scrollFullPageWithCursor(state, 1);    return;
      case "scroll_page_down": scrollFullPageWithCursor(state, -1);   return;
      case "scroll_top":       scrollToTop(state); ensureCursorVisible(state); return;
      case "scroll_bottom":    scrollToBottom(state); ensureCursorVisible(state); return;
    }
  }

  // Viewport-only (prompt focused, sidebar, etc.)
  switch (action) {
    case "scroll_line_up":   scrollLineUp(state);   break;
    case "scroll_line_down": scrollLineDown(state);  break;
    case "scroll_half_up":   scrollHalfUp(state);    break;
    case "scroll_half_down": scrollHalfDown(state);  break;
    case "scroll_page_up":   scrollPageUp(state);    break;
    case "scroll_page_down": scrollPageDown(state);  break;
    case "scroll_top":       scrollToTop(state);     break;
    case "scroll_bottom":    scrollToBottom(state);  break;
  }
}
