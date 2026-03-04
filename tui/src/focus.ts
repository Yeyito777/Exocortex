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
import { resolveAction } from "./keybinds";
import { handleChatKey, scrollUp, scrollDown } from "./chat";
import { handleSidebarKey, handleSidebarAction } from "./sidebar";
import { processKey, type VimContext } from "./vim";

// ── Types ───────────────────────────────────────────────────────────

export type PanelFocus = "sidebar" | "chat";

export type KeyResult =
  | { type: "handled" }
  | { type: "submit" }
  | { type: "quit" }
  | { type: "abort" }
  | { type: "load_conversation"; convId: string }
  | { type: "delete_conversation"; convId: string };

// ── Key routing ─────────────────────────────────────────────────────

export function handleFocusedKey(key: KeyEvent, state: RenderState): KeyResult {
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
  }

  // ── Vim processing ─────────────────────────────────────────────
  if (state.vim.enabled) {
    const vimResult = processVimKey(key, state);
    if (vimResult) return vimResult;
    // vimResult === null means passthrough — continue to normal system
  }

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

    case "mode_change":
      state.vim.mode = result.mode;
      if (result.cursor !== undefined) state.cursorPos = result.cursor;
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

// ── Normal mode cursor clamp ───────────────────────────────────────

function clampCursorNormal(state: RenderState): void {
  if (state.inputBuffer.length > 0) {
    state.cursorPos = Math.min(state.cursorPos, state.inputBuffer.length - 1);
  } else {
    state.cursorPos = 0;
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
