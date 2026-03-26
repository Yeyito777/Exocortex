/**
 * Chat panel key routing.
 *
 * Owns the chat's inner focus (prompt vs history) and routes
 * keys accordingly. Delegates to promptline.ts for buffer editing
 * and handles history scrolling directly.
 */

import type { KeyEvent } from "./input";
import type { RenderState } from "./state";
import { focusPrompt } from "./state";
import { resolveAction } from "./keybinds";
import { handlePromptKey, type PromptKeyResult } from "./promptline";

// ── Types ───────────────────────────────────────────────────────────

export type ChatFocus = "prompt" | "history";

/** Re-export PromptKeyResult as the chat-level result type — same shape. */
export type ChatKeyResult = PromptKeyResult;

// ── Key routing ─────────────────────────────────────────────────────

export function handleChatKey(key: KeyEvent, state: RenderState): ChatKeyResult {
  if (state.chatFocus === "prompt") {
    return handlePromptFocused(key, state);
  } else {
    return handleHistoryFocused(key, state);
  }
}

// ── Prompt focus ────────────────────────────────────────────────────

function handlePromptFocused(key: KeyEvent, state: RenderState): ChatKeyResult {
  const action = resolveAction(key);

  // Delegate to promptline — returns a typed result directly
  const result = handlePromptKey(state, key);
  if (result.type !== "unhandled") return result;

  // Unhandled by promptline (up/down on first/last line) → scroll
  if (action === "cursor_up") {
    scrollUp(state);
    return { type: "handled" };
  }
  if (action === "cursor_down") {
    scrollDown(state);
    return { type: "handled" };
  }

  return { type: "unhandled" };
}

// ── History focus ───────────────────────────────────────────────────

function handleHistoryFocused(key: KeyEvent, state: RenderState): ChatKeyResult {
  const action = resolveAction(key, "navigation");

  switch (action) {
    case "focus_prompt":
      // i/a → prompt
      focusPrompt(state);
      return { type: "handled" };

    case "nav_up":
    case "cursor_up":
      scrollUp(state);
      return { type: "handled" };

    case "nav_down":
    case "cursor_down":
      scrollDown(state);
      return { type: "handled" };

    default:
      return { type: "unhandled" };
  }
}

// ── Scroll helpers ──────────────────────────────────────────────────

function maxScroll(state: RenderState): number {
  return Math.max(0, state.layout.totalLines - state.layout.messageAreaHeight);
}

/**
 * First historyLines index visible in the message area.
 *
 * scrollOffset === 0 means "pinned to bottom" (auto-scroll), so we
 * snap to the tail of the buffer.  Any positive offset scrolls up.
 * Always clamped to ≥ 0 so callers never get a negative index.
 */
export function getViewStart(state: RenderState): number {
  const { totalLines, messageAreaHeight } = state.layout;
  if (state.scrollOffset === 0) return Math.max(0, totalLines - messageAreaHeight);
  return Math.max(0, totalLines - messageAreaHeight - state.scrollOffset);
}

export function scrollBy(state: RenderState, lines: number): void {
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset + lines, maxScroll(state)));
}

export function scrollUp(state: RenderState): void { scrollBy(state, 3); }
export function scrollDown(state: RenderState): void { scrollBy(state, -3); }

export function scrollLineUp(state: RenderState): void { scrollBy(state, 1); }
export function scrollLineDown(state: RenderState): void { scrollBy(state, -1); }

export function scrollHalfUp(state: RenderState): void {
  scrollBy(state, Math.floor(state.rows / 2));
}
export function scrollHalfDown(state: RenderState): void {
  scrollBy(state, -Math.floor(state.rows / 2));
}

export function scrollPageUp(state: RenderState): void {
  scrollBy(state, state.rows);
}
export function scrollPageDown(state: RenderState): void {
  scrollBy(state, -state.rows);
}

export function scrollToTop(state: RenderState): void {
  state.scrollOffset = maxScroll(state);
}
export function scrollToBottom(state: RenderState): void {
  state.scrollOffset = 0;
}
