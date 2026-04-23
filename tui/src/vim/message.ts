/**
 * Message text object (im/am).
 *
 * Intercepted before the vim engine because:
 *   1. In history context, text objects must operate on historyLines,
 *      not the prompt buffer that the engine receives.
 *   2. Only yank (y) and visual (v/V) are wired — no delete/change.
 *
 * The "i"/"a" modifier is set by the vim engine (visual.ts for visual
 * mode, engine.ts for normal mode). This interceptor only fires when
 * the pending modifier is already set and the specifier key is "m".
 */

import type { KeyEvent } from "../input";
import type { RenderState } from "../state";
import type { VimContext } from "./types";
import { keyString, resetPending } from "./types";
import { copyToClipboard } from "./clipboard";
import { stripAnsi, contentBounds, ensureCursorVisible, joinLogicalLines } from "../historycursor";

// ── Types ──────────────────────────────────────────────────────────

/** Result of the interceptor — matches focus.ts KeyResult shape. */
type Handled = { type: "handled" };
const HANDLED: Handled = { type: "handled" };

// ── Entry point ────────────────────────────────────────────────────

/**
 * Handle the message text object (im/am) across all contexts.
 * Returns a KeyResult if the key was consumed, null to fall through to the engine.
 */
export function handleMessageTextObject(
  key: KeyEvent,
  state: RenderState,
  context: VimContext,
): Handled | null {
  const vim = state.vim;
  const ks = keyString(key);
  if (!ks || ks !== "m") return null;

  const inVisual = vim.mode === "visual" || vim.mode === "visual-line";

  // ── Visual mode: pending modifier + "m" → select message ────────
  if (inVisual && vim.pendingTextObjectModifier) {
    const modifier = vim.pendingTextObjectModifier;
    vim.pendingTextObjectModifier = null;

    if (context === "prompt") return selectPromptMessage(modifier, state);
    if (context === "history") return selectHistoryMessage(modifier, state);
    return HANDLED;
  }

  // ── Normal mode: yank + text object modifier + "m" → yank message
  if (vim.mode === "normal"
    && vim.pendingOperator === "yank"
    && vim.pendingTextObjectModifier
  ) {
    const modifier = vim.pendingTextObjectModifier;
    resetPending(vim);

    if (context === "prompt") {
      const text = modifier === "i" ? state.inputBuffer.trim() : state.inputBuffer;
      if (text) copyToClipboard(text);
      return HANDLED;
    }
    if (context === "history") {
      const text = extractHistoryMessageText(state, modifier === "i");
      if (text) copyToClipboard(text);
      return HANDLED;
    }
    return HANDLED;
  }

  return null;
}

// ── Prompt helpers ─────────────────────────────────────────────────

/** vim/vam in prompt: snap visual selection to the entire buffer. */
function selectPromptMessage(modifier: "i" | "a", state: RenderState): Handled {
  const buf = state.inputBuffer;
  if (buf.length === 0) return HANDLED;

  let start = 0;
  let end = buf.length;
  if (modifier === "i") {
    while (start < end && (buf[start] === " " || buf[start] === "\t")) start++;
    while (end > start && (buf[end - 1] === " " || buf[end - 1] === "\t")) end--;
    if (start >= end) return HANDLED;
  }

  state.vim.visualAnchor = start;
  state.cursorPos = end - 1;
  return HANDLED;
}

// ── History helpers ────────────────────────────────────────────────

/**
 * Resolve the effective row range for a message in history.
 * im: content rows only (no metadata/padding, blank edges trimmed).
 * am: full message range.
 * Returns null if the cursor isn't on a message or the range is empty.
 */
function resolveMessageRows(
  state: RenderState,
  inner: boolean,
): { startRow: number; endRow: number } | null {
  const bounds = findMessageBoundsAtCursor(state);
  if (!bounds) return null;

  const lines = state.historyLines;
  let startRow = bounds.start;
  let endRow = inner ? bounds.contentEnd : bounds.end;

  if (inner) {
    while (startRow < endRow && stripAnsi(lines[startRow]).trim() === "") startRow++;
    while (endRow > startRow && stripAnsi(lines[endRow - 1]).trim() === "") endRow--;
  }

  if (startRow >= endRow) return null;
  return { startRow, endRow };
}

/** vim/vam in history: snap visual selection to the chat message at cursor. */
function selectHistoryMessage(modifier: "i" | "a", state: RenderState): Handled {
  const range = resolveMessageRows(state, modifier === "i");
  if (!range) return HANDLED;

  const { startRow, endRow } = range;
  const lines = state.historyLines;
  const startBnd = contentBounds(stripAnsi(lines[startRow]));
  const endBnd = contentBounds(stripAnsi(lines[endRow - 1]));

  state.historyVisualAnchor = { row: startRow, col: startBnd.start };
  state.historyCursor = { row: endRow - 1, col: endBnd.end };
  ensureCursorVisible(state);
  return HANDLED;
}

/** Find the MessageBound that contains the current history cursor row. */
function findMessageBoundsAtCursor(
  state: RenderState,
): { start: number; end: number; contentEnd: number } | null {
  const row = state.historyCursor.row;
  for (const b of state.historyMessageBounds) {
    if (row >= b.start && row < b.end) return b;
  }
  return null;
}

/** Extract plain text of the history message at the cursor row. */
function extractHistoryMessageText(state: RenderState, inner: boolean): string {
  const range = resolveMessageRows(state, inner);
  if (!range) return "";

  return joinLogicalLines(
    state.historyLines, state.historyWrapContinuation,
    range.startRow, range.endRow - 1,
    state.historyWrapJoiners,
  );
}
