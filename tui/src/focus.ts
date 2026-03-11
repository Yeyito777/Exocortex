/**
 * Panel-level focus routing.
 *
 * Routes key events based on which panel has focus (sidebar or chat).
 * When vim is enabled, keys pass through the vim engine first.
 * Chat manages its own inner focus (prompt/history) via chat.ts.
 * Sidebar manages its own keys via sidebar.ts.
 *
 * This is the top-level key routing — the only file main.ts calls
 * for key handling.
 */

import type { KeyEvent } from "./input";
import type { RenderState } from "./state";
import type { Action } from "./keybinds";
import { resolveAction } from "./keybinds";
import {
  handleChatKey,
  scrollUp, scrollDown,
  scrollLineUp, scrollLineDown,
  scrollHalfUp, scrollHalfDown,
  scrollPageUp, scrollPageDown,
  scrollToTop, scrollToBottom,
} from "./chat";
import { handleSidebarKey, handleSidebarAction, moveSelection, syncSelectedIndex } from "./sidebar";
import { processKey, copyToClipboard, pasteFromClipboard, type VimContext } from "./vim";
import { clampNormal } from "./vim/buffer";
import { pushUndo, markInsertEntry, commitInsertSession, undo as undoFn, redo as redoFn } from "./undo";
import {
  stripAnsi, ensureCursorVisible, placeAtVisibleBottom,
  handleHistoryFind as historyFindHandler,
  handleHistoryCursorAction,
  scrollHalfPageWithCursor, scrollFullPageWithCursor, scrollLineWithStickyCursor,
} from "./historycursor";
import { handleMessageTextObject } from "./vim/message";
import { dismissAutocomplete } from "./autocomplete";
import { handleQueuePromptKey } from "./queue";
import { handleEditMessageKey, openEditMessageModal } from "./editmessage";
import { readClipboardImage } from "./clipboard";

// ── Types ───────────────────────────────────────────────────────────

export type PanelFocus = "sidebar" | "chat";

export type KeyResult =
  | { type: "handled" }
  | { type: "submit" }
  | { type: "quit" }
  | { type: "abort" }
  | { type: "load_conversation"; convId: string }
  | { type: "delete_conversation"; convId: string }
  | { type: "undo_delete" }
  | { type: "mark_conversation"; convId: string; marked: boolean }
  | { type: "pin_conversation"; convId: string; pinned: boolean }
  | { type: "move_conversation"; convId: string; direction: "up" | "down" }
  | { type: "clone_conversation"; convId: string }
  | { type: "new_conversation" }
  | { type: "queue_confirm" }
  | { type: "queue_cancel" }
  | { type: "edit_message_confirm" }
  | { type: "edit_message_cancel" };

// ── Key routing ─────────────────────────────────────────────────────

export function handleFocusedKey(key: KeyEvent, state: RenderState): KeyResult {
  // ── Queue prompt modal — intercept all keys when showing ──────
  if (state.queuePrompt) {
    const qr = handleQueuePromptKey(key, state);
    if (qr.type === "confirm") return { type: "queue_confirm" };
    if (qr.type === "cancel")  return { type: "queue_cancel" };
    return { type: "handled" };
  }

  // ── Edit message modal — intercept all keys when showing ─────
  if (state.editMessagePrompt) {
    const er = handleEditMessageKey(key, state);
    if (er.type === "confirm") return { type: "edit_message_confirm" };
    if (er.type === "cancel")  return { type: "edit_message_cancel" };
    return { type: "handled" };
  }

  // Bracketed paste — insert directly into prompt buffer, newlines preserved
  if (key.type === "paste" && key.text) {
    // Normalize line endings: \r\n → \n, stray \r → \n
    const text = key.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    pushUndo(state.undo, state.inputBuffer, state.cursorPos);
    const buf = state.inputBuffer;
    const pos = state.cursorPos;
    state.inputBuffer = buf.slice(0, pos) + text + buf.slice(pos);
    state.cursorPos = pos + text.length;
    state.autocomplete = null;
    // Ensure prompt is focused and in insert mode
    state.panelFocus = "chat";
    state.chatFocus = "prompt";
    if (state.vim.mode !== "insert") state.vim.mode = "insert";
    return { type: "handled" };
  }

  const action = resolveAction(key);

  // Global actions — work regardless of focus and vim mode
  switch (action) {
    case "quit":
      return { type: "quit" };
    case "sidebar_toggle":
      state.sidebar.open = !state.sidebar.open;
      state.panelFocus = state.sidebar.open ? "sidebar" : "chat";
      if (state.panelFocus === "sidebar") {
        state.vim.mode = "normal";
        // Default cursor to the current conversation
        if (state.convId) {
          state.sidebar.selectedId = state.convId;
          syncSelectedIndex(state.sidebar);
        }
      }
      return { type: "handled" };
    case "focus_cycle":
      if (state.sidebar.open) {
        state.panelFocus = state.panelFocus === "sidebar" ? "chat" : "sidebar";
        if (state.panelFocus === "sidebar") state.vim.mode = "normal";
      }
      return { type: "handled" };
    case "new_conversation":
      return { type: "new_conversation" };
    case "edit_message":
      openEditMessageModal(state);
      return { type: "handled" };
    case "focus_history":
      // Toggle: if already in history → back to prompt, otherwise → history
      if (state.panelFocus === "chat" && state.chatFocus === "history") {
        state.chatFocus = "prompt";
        state.vim.mode = "insert";
      } else {
        state.panelFocus = "chat";
        state.chatFocus = "history";
        state.vim.mode = "normal";
        state.historyCursor = placeAtVisibleBottom(state);
      }
      return { type: "handled" };
    case "sidebar_next":
    case "sidebar_prev": {
      // Don't intercept when typing in the prompt — these are regular chars
      const isPromptTyping = state.panelFocus === "chat" && state.chatFocus === "prompt"
        && state.vim.mode === "insert";
      if (isPromptTyping) break;
      if (!state.sidebar.open) {
        state.sidebar.open = true;
        // Default cursor to the current conversation before moving
        if (state.convId) {
          state.sidebar.selectedId = state.convId;
          syncSelectedIndex(state.sidebar);
        }
      }
      state.panelFocus = "sidebar";
      state.vim.mode = "normal";
      moveSelection(state.sidebar, action === "sidebar_next" ? 1 : -1);
      return { type: "handled" };
    }
    case "scroll_line_up":
    case "scroll_line_down":
    case "scroll_half_up":
    case "scroll_half_down":
    case "scroll_page_up":
    case "scroll_page_down":
    case "scroll_top":
    case "scroll_bottom":
      handleScrollAction(action, state);
      return { type: "handled" };
    case "toggle_tool_output":
      state.showToolOutput = !state.showToolOutput;
      return { type: "handled" };
    case "paste_image": {
      const img = readClipboardImage();
      if (img) {
        state.pendingImages.push(img);
        // Force focus to prompt in insert mode so user can type a caption
        state.panelFocus = "chat";
        state.chatFocus = "prompt";
        if (state.vim.mode !== "insert") state.vim.mode = "insert";
      }
      return { type: "handled" };
    }
  }

  // ── Abort (Ctrl+Q) — always fires, regardless of focus or vim mode ─
  if (action === "abort") {
    return { type: "abort" };
  }

  // ── Sidebar pending delete cancel (before vim) ──────────────────
  if (key.type === "escape" && state.panelFocus === "sidebar" && state.sidebar.pendingDeleteId) {
    state.sidebar.pendingDeleteId = null;
    // Also normalize vim to normal mode so we don't eat the next Escape
    if (state.vim.mode === "insert") {
      state.vim.mode = "normal";
    }
    return { type: "handled" };
  }

  // ── Autocomplete dismiss on Escape ─────────────────────────────
  // Must happen before vim so the buffer is restored before vim
  // computes the normal-mode cursor position.
  if (key.type === "escape" && state.autocomplete) {
    dismissAutocomplete(state);
  }

  // ── Vim processing ─────────────────────────────────────────────
  const vimResult = processVimKey(key, state);
  if (vimResult) return vimResult;

  if (state.panelFocus === "sidebar" && state.sidebar.open) {
    return handleSidebarFocused(key, state);
  } else {
    return handleChatFocused(key, state);
  }
}

// ── Vim key processing ─────────────────────────────────────────────

/**
 * Run the key through the vim engine.
 * Returns a KeyResult if vim consumed the key, or null for passthrough.
 */
function processVimKey(key: KeyEvent, state: RenderState): KeyResult | null {
  const context = getVimContext(state);

  // History-specific find handling: f/F/;/, operate on history lines, not prompt buffer
  if (context === "history" && state.vim.mode !== "insert") {
    if (historyFindHandler(key, state)) return { type: "handled" };
  }

  // Message text object (im/am) — intercept before engine for all contexts
  const msgResult = handleMessageTextObject(key, state, context);
  if (msgResult) return msgResult;

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
        clampCursorNormal(state);
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
      state.vim.mode = "insert";
      if (state.panelFocus === "sidebar") {
        state.panelFocus = "chat";
      }
      state.chatFocus = "prompt";
      return { type: "handled" };
    case "nav_up":
      return handleContextNavigation("up", state);
    case "nav_down":
      return handleContextNavigation("down", state);
    case "nav_select":
      if (state.panelFocus === "sidebar") {
        const result = handleSidebarAction("nav_select", state.sidebar);
        if (result.type === "select") {
          return { type: "load_conversation", convId: result.convId };
        }
      }
      return { type: "handled" };
    case "delete":
      if (state.panelFocus === "sidebar") {
        const result = handleSidebarAction("delete", state.sidebar);
        if (result.type === "delete_conversation") {
          return { type: "delete_conversation", convId: result.convId };
        }
      }
      return { type: "handled" };
    case "undo_delete":
      if (state.panelFocus === "sidebar") {
        return { type: "undo_delete" };
      }
      return { type: "handled" };
    case "mark":
      if (state.panelFocus === "sidebar") {
        const result = handleSidebarAction("mark", state.sidebar);
        if (result.type === "mark_conversation") {
          return { type: "mark_conversation", convId: result.convId, marked: result.marked };
        }
      }
      return { type: "handled" };
    case "pin":
      if (state.panelFocus === "sidebar") {
        const result = handleSidebarAction("pin", state.sidebar);
        if (result.type === "pin_conversation") {
          return { type: "pin_conversation", convId: result.convId, pinned: result.pinned };
        }
      }
      return { type: "handled" };
    case "move_up":
    case "move_down":
      if (state.panelFocus === "sidebar") {
        const result = handleSidebarAction(action, state.sidebar);
        if (result.type === "move_conversation") {
          return { type: "move_conversation", convId: result.convId, direction: result.direction };
        }
      }
      return { type: "handled" };
    case "clone":
      if (state.panelFocus === "sidebar") {
        const result = handleSidebarAction("clone", state.sidebar);
        if (result.type === "clone_conversation") {
          return { type: "clone_conversation", convId: result.convId };
        }
      }
      return { type: "handled" };
    case "scroll_top":
    case "scroll_bottom":
      handleScrollAction(action as Action, state);
      return { type: "handled" };
    default:
      return { type: "handled" };
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

// ── Paste handling ─────────────────────────────────────────────────

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

// ── Normal mode cursor clamp ───────────────────────────────────────

function clampCursorNormal(state: RenderState): void {
  state.cursorPos = clampNormal(state.inputBuffer, state.cursorPos);
}

// ── Scroll dispatch ────────────────────────────────────────────────

/**
 * Route scroll actions. When history cursor is active, uses vim-style
 * cursor-aware scrolling. Otherwise falls back to viewport-only scroll.
 */
function handleScrollAction(action: Action, state: RenderState): void {
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

// ── Context resolver ───────────────────────────────────────────────

function getVimContext(state: RenderState): VimContext {
  if (state.panelFocus === "sidebar") return "sidebar";
  return state.chatFocus === "prompt" ? "prompt" : "history";
}

// ── Sidebar panel (non-vim path) ───────────────────────────────────

function handleSidebarFocused(key: KeyEvent, state: RenderState): KeyResult {
  const result = handleSidebarKey(key, state.sidebar);

  switch (result.type) {
    case "handled":
      return { type: "handled" };
    case "select":
      return { type: "load_conversation", convId: result.convId };
    case "delete_conversation":
      return { type: "delete_conversation", convId: result.convId };
    case "undo_delete":
      return { type: "undo_delete" };
    case "mark_conversation":
      return { type: "mark_conversation", convId: result.convId, marked: result.marked };
    case "pin_conversation":
      return { type: "pin_conversation", convId: result.convId, pinned: result.pinned };
    case "move_conversation":
      return { type: "move_conversation", convId: result.convId, direction: result.direction };
    case "clone_conversation":
      return { type: "clone_conversation", convId: result.convId };
    case "unhandled":
      // focus_prompt comes back as unhandled from sidebar (i/a)
      state.panelFocus = "chat";
      return { type: "handled" };
  }
}

// ── Chat panel (non-vim path) ──────────────────────────────────────

function handleChatFocused(key: KeyEvent, state: RenderState): KeyResult {
  const result = handleChatKey(key, state);

  switch (result.type) {
    case "submit":
      return { type: "submit" };
    case "handled":
      return { type: "handled" };
    case "unhandled":
      return { type: "handled" };
  }
}
