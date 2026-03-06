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
import { handleSidebarKey, handleSidebarAction, moveSelection } from "./sidebar";
import { processKey, copyToClipboard, pasteFromClipboard, type VimContext } from "./vim";
import { clampNormal } from "./vim/buffer";
import {
  applyHistoryAction, stripAnsi, ensureCursorVisible, placeAtBottom,
  handleHistoryFind as historyFindHandler,
  getHistoryVisualSelection,
  scrollHalfPageWithCursor, scrollFullPageWithCursor, scrollLineWithStickyCursor,
} from "./historycursor";

// ── Types ───────────────────────────────────────────────────────────

export type PanelFocus = "sidebar" | "chat";

export type KeyResult =
  | { type: "handled" }
  | { type: "submit" }
  | { type: "quit" }
  | { type: "abort" }
  | { type: "load_conversation"; convId: string }
  | { type: "delete_conversation"; convId: string }
  | { type: "new_conversation" };

// ── Key routing ─────────────────────────────────────────────────────

export function handleFocusedKey(key: KeyEvent, state: RenderState): KeyResult {
  // Bracketed paste — insert directly into prompt buffer, newlines preserved
  if (key.type === "paste" && key.text) {
    // Normalize line endings: \r\n → \n, stray \r → \n
    const text = key.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const buf = state.inputBuffer;
    const pos = state.cursorPos;
    state.inputBuffer = buf.slice(0, pos) + text + buf.slice(pos);
    state.cursorPos = pos + text.length;
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
      return { type: "handled" };
    case "focus_cycle":
      if (state.sidebar.open) {
        state.panelFocus = state.panelFocus === "sidebar" ? "chat" : "sidebar";
      }
      return { type: "handled" };
    case "new_conversation":
      return { type: "new_conversation" };
    case "focus_history":
      // Toggle: if already in history → back to prompt, otherwise → history
      if (state.panelFocus === "chat" && state.chatFocus === "history") {
        state.chatFocus = "prompt";
        state.vim.mode = "insert";
      } else {
        state.panelFocus = "chat";
        state.chatFocus = "history";
        state.vim.mode = "normal";
        state.historyCursor = placeAtBottom(state.historyLines);
      }
      return { type: "handled" };
    case "sidebar_next":
    case "sidebar_prev": {
      // Don't intercept when typing in the prompt — these are regular chars
      const isPromptTyping = state.panelFocus === "chat" && state.chatFocus === "prompt"
        && state.vim.mode === "insert";
      if (isPromptTyping) break;
      if (!state.sidebar.open) state.sidebar.open = true;
      state.panelFocus = "sidebar";
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
  }

  // ── Sidebar pending delete cancel (before vim) ──────────────────
  if (action === "abort" && state.panelFocus === "sidebar" && state.sidebar.pendingDeleteId) {
    state.sidebar.pendingDeleteId = null;
    // Also normalize vim to normal mode so we don't eat the next Escape
    if (state.vim.mode === "insert") {
      state.vim.mode = "normal";
    }
    return { type: "handled" };
  }

  // ── Vim processing ─────────────────────────────────────────────
  const vimResult = processVimKey(key, state);
  if (vimResult) return vimResult;

  // ── Abort (only when vim doesn't consume Esc) ──────────────────
  if (action === "abort") {
    return { type: "abort" };
  }

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
      state.inputBuffer = result.buffer;
      state.cursorPos = result.cursor;
      if (result.mode) {
        state.vim.mode = result.mode;
      } else {
        // Staying in normal mode — clamp cursor to last char
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
      state.inputBuffer = result.buffer;
      state.cursorPos = result.cursor;
      state.vim.mode = result.mode;
      return { type: "handled" };

    case "mode_change":
      state.vim.mode = result.mode;
      if (result.cursor !== undefined) state.cursorPos = result.cursor;
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
    case "abort":
      return { type: "abort" };
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
    default:
      return { type: "handled" };
  }
}

// ── History cursor actions ────────────────────────────────────────

function handleHistoryCursorAction(action: Action, state: RenderState): KeyResult {
  if (action === "history_yy") {
    const plain = stripAnsi(state.historyLines[state.historyCursor.row] ?? "").trim();
    if (plain) copyToClipboard(plain);
    ensureCursorVisible(state);
    return { type: "handled" };
  }

  if (action === "history_visual_yank") {
    const text = getHistoryVisualSelection(state);
    if (text) copyToClipboard(text);
    state.vim.mode = "normal";
    ensureCursorVisible(state);
    return { type: "handled" };
  }

  applyHistoryAction(action, state);
  return { type: "handled" };
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
