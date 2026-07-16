/**
 * Chat history cursor — state, dispatch, scroll, find, and visual selection.
 *
 * Pure motions live in historymotions.ts.
 * This file owns the stateful operations that depend on RenderState:
 * action dispatch, cursor-aware scrolling, find interception,
 * and visual selection extraction.
 */

import type { KeyEvent } from "./input";
import type { Action } from "./keybinds";
import type { RenderState } from "./state";
import { getScrollOffsetForViewStart, getViewStart } from "./chatscroll";
import {
  ensureCursorRowVisibleInViewport,
  scrollLineWithStickyCursorInViewport,
  scrollPageWithCursorInViewport,
  scrollWithCursorInViewport,
} from "./viewportscroll";
import { copyToClipboard } from "./vim/clipboard";
import { keyString, resetPending } from "./vim/types";
import { resolveTextObject, isTextObjectKey } from "./vim/textobjects";
import { appendPromptQuoteBlock } from "./promptstate";
import { nextGraphemeEnd } from "./graphemes";
import { findFinalAssistantTextRows } from "./historymessage";
import {
  stripAnsi, contentBounds, clampCol, clampCursor,
  logicalLineRange,
  charLeft, charRight, lineUp, lineDown, lineStart, lineEnd,
  bufferStart, bufferEnd,
  wordForward, wordBackward, wordEnd,
  wordForwardBig, wordBackwardBig, wordEndBig,
  findForward, findBackward,
} from "./historymotions";

// Re-export everything from historymotions so existing consumers don't break
export {
  stripAnsi, contentBounds, clampCol, clampCursor,
  logicalLineRange,
  charLeft, charRight, lineUp, lineDown, lineStart, lineEnd,
  bufferStart, bufferEnd,
  wordForward, wordBackward, wordEnd,
  wordForwardBig, wordBackwardBig, wordEndBig,
  findForward, findBackward, placeAtBottom,
} from "./historymotions";

// ── State ──────────────────────────────────────────────────────────

export interface HistoryCursor {
  row: number;
  col: number;
}

export function createHistoryCursor(): HistoryCursor {
  return { row: 0, col: 0 };
}

type RenderedMessageBound = RenderState["historyMessageBounds"][number];

function getUserMessageBounds(state: RenderState): RenderedMessageBound[] {
  return state.historyMessageBounds.filter((bound) => bound.role === "user");
}

type RenderedAIResponseBound = RenderedMessageBound & { responseStart: number };

function getAIResponseBounds(state: RenderState): RenderedAIResponseBound[] {
  const responses: RenderedAIResponseBound[] = [];
  for (const bound of state.historyMessageBounds) {
    if (bound.role !== "assistant") continue;
    const finalText = findFinalAssistantTextRows(state, bound.contentStart, bound.contentEnd);
    if (finalText) responses.push({ ...bound, responseStart: finalText.startRow });
  }
  return responses;
}

function isMessageNavigationAction(action: Action): boolean {
  return action === "history_prev_message"
    || action === "history_next_message"
    || action === "history_prev_ai_message"
    || action === "history_next_ai_message";
}

/**
 * Prompt-focused message navigation has no visible history cursor to start from.
 * Start at the visible bottom, matching where explicitly focusing history would
 * place the cursor. Backward jumps use the position just after that row so a
 * message beginning on the bottom edge is included.
 */
function messageNavigationOriginRow(action: Action, state: RenderState, cursorRow: number): number {
  if (state.chatFocus !== "prompt" || !isMessageNavigationAction(action)) return cursorRow;
  if (state.layout.messageAreaHeight <= 0 || state.historyLines.length === 0) return cursorRow;

  const viewStart = getViewStart(state);
  const viewEnd = Math.min(
    state.historyLines.length - 1,
    viewStart + state.layout.messageAreaHeight - 1,
  );
  const movingBackward = action === "history_prev_message" || action === "history_prev_ai_message";
  return movingBackward ? viewEnd + 1 : viewEnd;
}

function jumpHistoryCursorToRow(state: RenderState, row: number): void {
  state.historyCursor = { row, col: clampCol(0, state.historyLines, row) };
  state.historyCurswant = null;
}

function isRowWithinBound(row: number, bound: RenderedMessageBound): boolean {
  return row >= bound.start && row < bound.end;
}

function resetHistoryCurswant(state: RenderState): void {
  state.historyCurswant = null;
}

function moveHistoryLine(state: RenderState, direction: -1 | 1): void {
  const desiredCol = state.historyCurswant ?? state.historyCursor.col;
  state.historyCursor = direction < 0
    ? lineUp(state.historyCursor, state.historyLines, desiredCol)
    : lineDown(state.historyCursor, state.historyLines, desiredCol);
  state.historyCurswant = desiredCol;
}

// ── Dispatch ───────────────────────────────────────────────────────

/**
 * Apply a history cursor action to state.
 * Returns true if the action was handled.
 */
export function applyHistoryAction(action: Action, state: RenderState): boolean {
  const lines = state.historyLines;
  const cur = state.historyCursor;

  if (lines.length === 0) return true;

  const wrapCont = state.historyWrapContinuation;
  const navigationRow = messageNavigationOriginRow(action, state, cur.row);

  switch (action) {
    case "history_left":    state.historyCursor = charLeft(cur, lines); resetHistoryCurswant(state); break;
    case "history_right":   state.historyCursor = charRight(cur, lines); resetHistoryCurswant(state); break;
    case "history_up":      moveHistoryLine(state, -1); break;
    case "history_down":    moveHistoryLine(state, 1); break;
    case "history_w":       state.historyCursor = wordForward(cur, lines); resetHistoryCurswant(state); break;
    case "history_b":       state.historyCursor = wordBackward(cur, lines); resetHistoryCurswant(state); break;
    case "history_e":       state.historyCursor = wordEnd(cur, lines); resetHistoryCurswant(state); break;
    case "history_W":       state.historyCursor = wordForwardBig(cur, lines); resetHistoryCurswant(state); break;
    case "history_B":       state.historyCursor = wordBackwardBig(cur, lines); resetHistoryCurswant(state); break;
    case "history_E":       state.historyCursor = wordEndBig(cur, lines); resetHistoryCurswant(state); break;
    case "history_0":       state.historyCursor = lineStart(cur, lines, wrapCont); resetHistoryCurswant(state); break;
    case "history_dollar":  state.historyCursor = lineEnd(cur, lines, wrapCont); resetHistoryCurswant(state); break;
    case "history_gg":      state.historyCursor = bufferStart(lines); resetHistoryCurswant(state); break;
    case "history_G":       state.historyCursor = bufferEnd(lines); resetHistoryCurswant(state); break;
    case "history_prev_message": {
      const bounds = getUserMessageBounds(state);
      if (bounds.length === 0) break;
      // Jump only among user messages.
      // Pressing { inside a user message goes to its start; pressing {
      // at that start goes to the previous user message's start.
      let target = -1;
      for (let i = bounds.length - 1; i >= 0; i--) {
        if (bounds[i].contentStart < navigationRow) { target = i; break; }
      }
      if (target >= 0) jumpHistoryCursorToRow(state, bounds[target].contentStart);
      break;
    }
    case "history_next_message": {
      const bounds = getUserMessageBounds(state);
      if (bounds.length === 0) break;
      // Jump only among user-message starts.
      // Pressing } moves to the next user-message start; if the cursor is
      // anywhere inside the last user message, jump to the conversation bottom.
      let target = -1;
      for (let i = 0; i < bounds.length; i++) {
        if (bounds[i].contentStart > navigationRow) { target = i; break; }
      }
      if (target >= 0) {
        jumpHistoryCursorToRow(state, bounds[target].contentStart);
      } else {
        const lastBound = bounds[bounds.length - 1];
        if (isRowWithinBound(navigationRow, lastBound)) {
          state.historyCursor = bufferEnd(lines);
          resetHistoryCurswant(state);
        }
      }
      break;
    }
    case "history_prev_ai_message": {
      const bounds = getAIResponseBounds(state);
      let target = -1;
      for (let i = bounds.length - 1; i >= 0; i--) {
        if (bounds[i].responseStart < navigationRow) { target = i; break; }
      }
      if (target >= 0) jumpHistoryCursorToRow(state, bounds[target].responseStart);
      break;
    }
    case "history_next_ai_message": {
      const bounds = getAIResponseBounds(state);
      let target = -1;
      for (let i = 0; i < bounds.length; i++) {
        if (bounds[i].responseStart > navigationRow) { target = i; break; }
      }
      if (target >= 0) {
        jumpHistoryCursorToRow(state, bounds[target].responseStart);
      } else {
        // Unlike forward user-message navigation, ] always falls through to
        // the conversation end when there is no later AI response text.
        state.historyCursor = bufferEnd(lines);
        resetHistoryCurswant(state);
      }
      break;
    }
    case "history_yy":      return true; // caller handles clipboard
    default:                return false;
  }

  ensureCursorVisible(state);
  return true;
}

// ── Cursor-aware scrolling (vim-style) ─────────────────────────────

/**
 * Ctrl+U / Ctrl+D — scroll half page AND move cursor by the same amount.
 * If there aren't enough lines, cursor takes the remainder.
 * `dir`: positive = up, negative = down.
 */
export function scrollHalfPageWithCursor(state: RenderState, dir: number): void {
  const amount = Math.floor(state.layout.messageAreaHeight / 2);
  scrollHistoryViewportWithCursor(state, dir, amount);
}

/**
 * Ctrl+B / Ctrl+F — Vim-style page scroll with cursor placed at the edge of the new page.
 */
export function scrollFullPageWithCursor(state: RenderState, dir: number): void {
  const totalLines = state.historyLines.length;
  if (totalLines === 0) return;

  const { messageAreaHeight } = state.layout;
  const next = scrollPageWithCursorInViewport({
    totalLines,
    viewportHeight: messageAreaHeight,
    viewStart: getViewStart(state),
    cursorRow: state.historyCursor.row,
  }, dir);

  state.historyCursor = clampCursor({ row: next.cursorRow, col: state.historyCursor.col }, state.historyLines);
  state.scrollOffset = getScrollOffsetForViewStart(totalLines, messageAreaHeight, next.viewStart);
}

/** Apply the shared cursor-aware page scroll logic to chat history's inverted scrollOffset. */
function scrollHistoryViewportWithCursor(state: RenderState, dir: number, amount: number): void {
  const totalLines = state.historyLines.length;
  if (totalLines === 0) return;

  const { messageAreaHeight } = state.layout;
  const next = scrollWithCursorInViewport({
    totalLines,
    viewportHeight: messageAreaHeight,
    viewStart: getViewStart(state),
    cursorRow: state.historyCursor.row,
  }, dir, amount);

  state.historyCursor = clampCursor({ row: next.cursorRow, col: state.historyCursor.col }, state.historyLines);
  state.scrollOffset = getScrollOffsetForViewStart(totalLines, messageAreaHeight, next.viewStart);
}

/**
 * Ctrl+E / Ctrl+Y — scroll viewport by 1 line, cursor stays on
 * same BUFFER LINE (sticks to the line). Only moves cursor if
 * it would go off-screen (clamped to nearest visible edge).
 * `dir`: positive = up (Ctrl+Y), negative = down (Ctrl+E).
 */
export function scrollLineWithStickyCursor(state: RenderState, dir: number): void {
  const totalLines = state.historyLines.length;
  if (totalLines === 0) return;

  const { messageAreaHeight } = state.layout;
  const next = scrollLineWithStickyCursorInViewport({
    totalLines,
    viewportHeight: messageAreaHeight,
    viewStart: getViewStart(state),
    cursorRow: state.historyCursor.row,
  }, dir);

  state.historyCursor = clampCursor({ row: next.cursorRow, col: state.historyCursor.col }, state.historyLines);
  state.scrollOffset = getScrollOffsetForViewStart(totalLines, messageAreaHeight, next.viewStart);
}

// ── Find interception for history ────────────────────────────────

/**
 * Handle f/F/;/, for history context. Returns true if the key was a find key
 * and was handled. Returns false if the key is not a find — caller should
 * fall through to the engine.
 */
export function handleHistoryFind(key: KeyEvent, state: RenderState): boolean {
  const vim = state.vim;
  const lines = state.historyLines;

  // Resolve pending find — waiting for the target character
  if (vim.pendingFind) {
    if (key.type !== "char" || !key.char) { vim.pendingFind = null; return true; }
    const dir = vim.pendingFind;
    vim.lastFind = { char: key.char, direction: dir };
    vim.pendingFind = null;
    state.historyCursor = dir === "f"
      ? findForward(state.historyCursor, lines, key.char)
      : findBackward(state.historyCursor, lines, key.char);
    resetHistoryCurswant(state);
    ensureCursorVisible(state);
    return true;
  }

  // Initiate find
  if (key.type === "char" && (key.char === "f" || key.char === "F")) {
    vim.pendingFind = key.char as "f" | "F";
    return true;
  }

  // Repeat last find
  if (key.type === "char" && (key.char === ";" || key.char === ",")) {
    // Visual `;` has a history-specific keymap action. Let the vim engine
    // dispatch it instead of treating it as repeat-find.
    if (key.char === ";" && (vim.mode === "visual" || vim.mode === "visual-line")) {
      return false;
    }
    if (!vim.lastFind) return true;
    const dir = key.char === ";"
      ? vim.lastFind.direction
      : (vim.lastFind.direction === "f" ? "F" : "f") as "f" | "F";
    state.historyCursor = dir === "f"
      ? findForward(state.historyCursor, lines, vim.lastFind.char)
      : findBackward(state.historyCursor, lines, vim.lastFind.char);
    resetHistoryCurswant(state);
    ensureCursorVisible(state);
    return true;
  }

  return false;
}

// ── History text objects ──────────────────────────────────────────

/**
 * Handle standard text objects (iw, aw, iW, aW, i", a", i(, etc.)
 * in history context.
 *
 * Intercepts before the vim engine so text objects resolve against
 * the ANSI-stripped history line under the cursor, not the prompt
 * buffer that the engine receives.
 *
 * Returns { type: "handled" } if the key was consumed, null to
 * fall through to the engine.
 */
export function handleHistoryTextObject(
  key: KeyEvent,
  state: RenderState,
): { type: "handled" } | null {
  const vim = state.vim;
  const ks = keyString(key);
  if (!ks || !vim.pendingTextObjectModifier || !isTextObjectKey(ks)) return null;

  const modifier = vim.pendingTextObjectModifier;
  vim.pendingTextObjectModifier = null;

  const lines = state.historyLines;
  const cursor = state.historyCursor;
  const row = cursor.row;
  const plain = stripAnsi(lines[row] ?? "");

  const range = resolveTextObject(modifier, ks, plain, cursor.col);
  if (!range || range.start >= range.end) {
    resetPending(vim);
    return { type: "handled" };
  }

  // Clamp to content bounds — cursor can't roam into padding
  const { start: cbStart, end: cbEnd } = contentBounds(plain);
  const rangeStart = Math.max(range.start, cbStart);
  const rangeEnd = Math.min(range.end, cbEnd + 1); // end is exclusive

  if (rangeStart >= rangeEnd) {
    resetPending(vim);
    return { type: "handled" };
  }

  const inVisual = vim.mode === "visual" || vim.mode === "visual-line";

  if (inVisual) {
    // Snap visual selection to the text object range
    state.historyVisualAnchor = { row, col: rangeStart };
    state.historyCursor = { row, col: rangeEnd - 1 }; // inclusive
    resetHistoryCurswant(state);
    ensureCursorVisible(state);
    return { type: "handled" };
  }

  // Operator mode (yank only — history is read-only)
  if (vim.pendingOperator === "yank") {
    const text = plain.slice(rangeStart, rangeEnd);
    if (text) copyToClipboard(text);
  }

  resetPending(vim);
  return { type: "handled" };
}

// ── Visual selection extraction ─────────────────────────────────

function normalizeHistorySelection(anchor: HistoryCursor, cursor: HistoryCursor): {
  start: HistoryCursor;
  end: HistoryCursor;
} {
  const forward = anchor.row < cursor.row
    || (anchor.row === cursor.row && anchor.col <= cursor.col);
  return {
    start: forward ? anchor : cursor,
    end: forward ? cursor : anchor,
  };
}

function extractHistoryCharwiseSelection(
  state: RenderState,
  start: HistoryCursor,
  end: HistoryCursor,
): string {
  const lines = state.historyLines;
  const wrapCont = state.historyWrapContinuation;
  const wrapJoiners = state.historyWrapJoiners;
  if (start.row === end.row) {
    const plain = stripAnsi(lines[start.row] ?? "");
    return copyLineSlice(state, start.row, start.col, nextGraphemeEnd(plain, end.col)) ?? "";
  }

  const result: string[] = [];
  for (let r = start.row; r <= end.row; r++) {
    const plain = stripAnsi(lines[r] ?? "");
    const { start: lineStart, end: lineEnd } = contentBounds(plain);
    const sliceStart = r === start.row ? start.col : lineStart;
    const sliceEnd = r === end.row
      ? nextGraphemeEnd(plain, end.col)
      : nextGraphemeEnd(plain, lineEnd);
    const text = copyLineSlice(state, r, sliceStart, sliceEnd);
    if (text == null) continue;

    if (r === start.row || !wrapCont[r] || result.length === 0) {
      result.push(text);
    } else if (text) {
      result[result.length - 1] += `${wrapJoiners[r] ?? " "}${text}`;
    }
  }

  return result.join("\n");
}

/** Extract the selected text from history in visual/visual-line mode. */
export function getHistoryVisualSelection(state: RenderState): string {
  const lines = state.historyLines;
  const wrapCont = state.historyWrapContinuation;
  const wrapJoiners = state.historyWrapJoiners;
  const { start, end } = normalizeHistorySelection(state.historyVisualAnchor, state.historyCursor);

  let startRow = start.row;
  let endRow = end.row;

  if (state.vim.mode === "visual-line") {
    // Expand to logical line groups
    if (wrapCont.length > 0) {
      startRow = logicalLineRange(startRow, wrapCont).first;
      endRow = logicalLineRange(endRow, wrapCont).last;
    }
    return joinLogicalLines(lines, wrapCont, startRow, endRow, wrapJoiners, state.historyCopyLines);
  }

  return extractHistoryCharwiseSelection(state, start, end);
}

// ── History cursor action dispatch (yank, visual yank, motions) ───

/**
 * Handle a history cursor action. Dispatches yank/visual-yank and
 * delegates motion actions to applyHistoryAction.
 * Returns a KeyResult-compatible object.
 */
export function handleHistoryCursorAction(
  action: Action,
  state: RenderState,
): { type: "handled" } {
  if (action === "history_yy") {
    const wrapCont = state.historyWrapContinuation;
    const curRow = state.historyCursor.row;
    const { first, last } = wrapCont.length > 0
      ? logicalLineRange(curRow, wrapCont)
      : { first: curRow, last: curRow };
    const plain = joinLogicalLines(state.historyLines, wrapCont, first, last, state.historyWrapJoiners, state.historyCopyLines);
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

  if (action === "history_append_selection") {
    appendPromptQuoteBlock(state, getHistoryVisualSelection(state));
    state.vim.mode = "normal";
    resetPending(state.vim);
    ensureCursorVisible(state);
    return { type: "handled" };
  }

  applyHistoryAction(action, state);
  return { type: "handled" };
}

/**
 * Join visual rows into text, respecting wrap continuations.
 * Continuation rows reinsert their recorded wrap separator (usually a space,
 * but empty for hard-broken tokens like long paths/URLs).
 * Non-continuation rows start a new \n-delimited line.
 */
export function joinLogicalLines(
  lines: string[],
  wrapCont: boolean[],
  startRow: number,
  endRow: number,
  wrapJoiners: string[] = [],
  copyLines: RenderState["historyCopyLines"] = [],
): string {
  const parts: string[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const text = wholeCopyLine(lines, copyLines, r);
    if (text == null) continue;
    if (r === startRow || !wrapCont[r] || parts.length === 0) {
      parts.push(text);
    } else {
      const joiner = wrapJoiners[r] ?? " ";
      parts[parts.length - 1] += (text ? joiner + text : "");
    }
  }
  return parts.join("\n");
}

function wholeCopyLine(
  lines: string[],
  copyLines: RenderState["historyCopyLines"],
  row: number,
): string | null {
  const projection = copyLines?.[row] ?? null;
  if (projection?.skip) return null;
  if (projection) return projection.text;
  return stripAnsi(lines[row] ?? "").trim();
}

function copyLineSlice(
  state: RenderState,
  row: number,
  startCol: number,
  endCol: number,
): string | null {
  const projection = state.historyCopyLines?.[row] ?? null;
  if (projection?.skip) return null;
  if (projection) {
    const start = Math.max(0, Math.min(projection.text.length, startCol - projection.displayStart));
    const end = Math.max(0, Math.min(projection.text.length, endCol - projection.displayStart));
    return projection.text.slice(start, end);
  }

  const plain = stripAnsi(state.historyLines[row] ?? "");
  return plain.slice(startCol, endCol);
}

/**
 * Place the cursor at the bottom of the currently *visible* viewport.
 * Unlike placeAtBottom (which always targets the absolute last line),
 * this respects scrollOffset so the user doesn't lose their scroll position.
 */
export function placeAtVisibleBottom(state: RenderState): HistoryCursor {
  const lines = state.historyLines;
  if (lines.length === 0) return { row: 0, col: 0 };

  const { messageAreaHeight } = state.layout;

  const viewStart = getViewStart(state);
  const viewEnd = Math.min(lines.length - 1, viewStart + messageAreaHeight - 1);

  return { row: viewEnd, col: clampCol(0, lines, viewEnd) };
}

/** Adjust scrollOffset so the cursor row is within the visible message area. */
export function ensureCursorVisible(state: RenderState): void {
  const { totalLines, messageAreaHeight } = state.layout;
  const next = ensureCursorRowVisibleInViewport({
    totalLines,
    viewportHeight: messageAreaHeight,
    viewStart: getViewStart(state),
    cursorRow: state.historyCursor.row,
  });
  state.scrollOffset = getScrollOffsetForViewStart(totalLines, messageAreaHeight, next.viewStart);
}
