/**
 * Focus system for the Exocortex TUI.
 *
 * Routes key events to the correct handler based on current focus.
 * Owns focus switching and scroll logic. The only file that decides
 * what a key does based on context.
 */

import type { KeyEvent } from "./input";
import type { RenderState } from "./state";
import { handlePromptKey } from "./promptline";

// ── Types ───────────────────────────────────────────────────────────

export type FocusTarget = "prompt" | "history";

export type KeyResult =
  | { type: "handled" }
  | { type: "submit" }
  | { type: "quit" }
  | { type: "abort" };

// ── Key routing ─────────────────────────────────────────────────────

export function handleFocusedKey(key: KeyEvent, state: RenderState): KeyResult {
  // Global keys — work regardless of focus
  switch (key.type) {
    case "ctrl-c":
    case "ctrl-d":
      return { type: "quit" };
    case "escape":
      return { type: "abort" };
  }

  if (state.focus === "prompt") {
    return handlePromptFocused(key, state);
  } else {
    return handleHistoryFocused(key, state);
  }
}

// ── Prompt focus ────────────────────────────────────────────────────

function handlePromptFocused(key: KeyEvent, state: RenderState): KeyResult {
  // Ctrl+N → switch to history
  if (key.type === "ctrl-n") {
    state.focus = "history";
    return { type: "handled" };
  }

  // Delegate to promptline
  const result = handlePromptKey(state, key);
  if (result === "submit") return { type: "submit" };
  if (result === "handled") return { type: "handled" };

  // Unhandled by promptline (up/down on first/last line) → scroll
  if (key.type === "up") {
    scrollUp(state);
    return { type: "handled" };
  }
  if (key.type === "down") {
    scrollDown(state);
    return { type: "handled" };
  }

  return { type: "handled" };
}

// ── History focus ───────────────────────────────────────────────────

function handleHistoryFocused(key: KeyEvent, state: RenderState): KeyResult {
  switch (key.type) {
    case "char":
      // i or a → back to prompt (vim-style insert)
      if (key.char === "i" || key.char === "a") {
        state.focus = "prompt";
        return { type: "handled" };
      }
      return { type: "handled" };

    case "ctrl-n":
      state.focus = "prompt";
      return { type: "handled" };

    case "up":
      scrollUp(state);
      return { type: "handled" };

    case "down":
      scrollDown(state);
      return { type: "handled" };

    default:
      return { type: "handled" };
  }
}

// ── Scroll helpers ──────────────────────────────────────────────────

function scrollUp(state: RenderState): void {
  const allLines = state.messages.length * 3;
  const maxScroll = Math.max(0, allLines - (state.rows - 5));
  state.scrollOffset = Math.min(state.scrollOffset + 3, maxScroll);
}

function scrollDown(state: RenderState): void {
  state.scrollOffset = Math.max(0, state.scrollOffset - 3);
}
