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
 * the pending modifier is already set and the specifier key is "m"/"M".
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
  if (!ks || (ks !== "m" && ks !== "M")) return null;

  const inVisual = vim.mode === "visual" || vim.mode === "visual-line";

  // ── Visual mode: pending modifier + "m" → select message ────────
  if (inVisual && vim.pendingTextObjectModifier) {
    const modifier = vim.pendingTextObjectModifier;
    vim.pendingTextObjectModifier = null;

    if (context === "prompt") return selectPromptMessage(modifier, state);
    if (context === "history") return selectHistoryMessage(ks, state);
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
      const text = extractHistoryMessageText(state, ks);
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

function trimRowsToContent(state: RenderState, startRow: number, endRow: number): { startRow: number; endRow: number } | null {
  const lines = state.historyLines;
  let start = startRow;
  let end = endRow;
  while (start < end && stripAnsi(lines[start]).trim() === "") start++;
  while (end > start && stripAnsi(lines[end - 1]).trim() === "") end--;
  return start < end ? { startRow: start, endRow: end } : null;
}

function findFinalAssistantTextRows(state: RenderState, startRow: number, endRow: number): { startRow: number; endRow: number } | null {
  const anchors = state.historyLineAnchors ?? [];
  let currentOwner: object | null = null;
  let currentStart = -1;
  let currentEnd = -1;
  let finalStart = -1;
  let finalEnd = -1;

  const finishCurrent = () => {
    if (currentStart >= 0 && currentEnd > currentStart) {
      finalStart = currentStart;
      finalEnd = currentEnd;
    }
    currentOwner = null;
    currentStart = -1;
    currentEnd = -1;
  };

  for (let row = startRow; row < endRow; row++) {
    const anchor = anchors[row];
    const owner = anchor?.owner as ({ type?: string } & object) | undefined;
    const isTextBlock = anchor?.segment === "assistant_block" && owner?.type === "text";
    if (!isTextBlock || !owner) {
      finishCurrent();
      continue;
    }

    if (currentOwner !== owner) {
      finishCurrent();
      currentOwner = owner;
      currentStart = row;
    }
    currentEnd = row + 1;
  }
  finishCurrent();

  if (finalStart >= 0 && finalEnd > finalStart) return trimRowsToContent(state, finalStart, finalEnd);
  return null;
}

/**
 * Resolve the effective row range for a message in history.
 * m: final assistant text block for assistant messages, otherwise content rows.
 * M: full message range (previous behavior).
 * Returns null if the cursor isn't on a message or the range is empty.
 */
function resolveMessageRows(
  state: RenderState,
  key: "m" | "M",
): { startRow: number; endRow: number } | null {
  const bounds = findMessageBoundsAtCursor(state);
  if (!bounds) return null;

  if (key === "M") return { startRow: bounds.start, endRow: bounds.end };

  if (bounds.role === "assistant") {
    const finalText = findFinalAssistantTextRows(state, bounds.contentStart, bounds.contentEnd);
    if (finalText) return finalText;
  }

  return trimRowsToContent(state, bounds.contentStart, bounds.contentEnd);
}

/** vim/vam in history: snap visual selection to the chat message at cursor. */
function selectHistoryMessage(key: "m" | "M", state: RenderState): Handled {
  const range = resolveMessageRows(state, key);
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
): { role: RenderState["historyMessageBounds"][number]["role"]; start: number; end: number; contentStart: number; contentEnd: number } | null {
  const row = state.historyCursor.row;
  for (const b of state.historyMessageBounds) {
    if (row >= b.start && row < b.end) return b;
  }
  return null;
}

/** Extract plain text of the history message at the cursor row. */
function extractHistoryMessageText(state: RenderState, key: "m" | "M"): string {
  const range = resolveMessageRows(state, key);
  if (!range) return "";

  return joinLogicalLines(
    state.historyLines, state.historyWrapContinuation,
    range.startRow, range.endRow - 1,
    state.historyWrapJoiners,
  );
}
