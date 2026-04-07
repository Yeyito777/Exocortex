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
import { getViewStart } from "./chat";
import { copyToClipboard } from "./vim/clipboard";
import { keyString, resetPending } from "./vim/types";
import { resolveTextObject, isTextObjectKey } from "./vim/textobjects";
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

function jumpHistoryCursorToRow(state: RenderState, row: number): void {
  state.historyCursor = { row, col: clampCol(0, state.historyLines, row) };
}

function isRowWithinBound(row: number, bound: RenderedMessageBound): boolean {
  return row >= bound.start && row < bound.end;
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

  switch (action) {
    case "history_left":    state.historyCursor = charLeft(cur, lines); break;
    case "history_right":   state.historyCursor = charRight(cur, lines); break;
    case "history_up":      state.historyCursor = lineUp(cur, lines); break;
    case "history_down":    state.historyCursor = lineDown(cur, lines); break;
    case "history_w":       state.historyCursor = wordForward(cur, lines); break;
    case "history_b":       state.historyCursor = wordBackward(cur, lines); break;
    case "history_e":       state.historyCursor = wordEnd(cur, lines); break;
    case "history_W":       state.historyCursor = wordForwardBig(cur, lines); break;
    case "history_B":       state.historyCursor = wordBackwardBig(cur, lines); break;
    case "history_E":       state.historyCursor = wordEndBig(cur, lines); break;
    case "history_0":       state.historyCursor = lineStart(cur, lines, wrapCont); break;
    case "history_dollar":  state.historyCursor = lineEnd(cur, lines, wrapCont); break;
    case "history_gg":      state.historyCursor = bufferStart(lines); break;
    case "history_G":       state.historyCursor = bufferEnd(lines); break;
    case "history_prev_message": {
      const bounds = getUserMessageBounds(state);
      if (bounds.length === 0) break;
      // Jump only among user messages.
      // Pressing { inside a user message goes to its start; pressing {
      // at that start goes to the previous user message's start.
      let target = -1;
      for (let i = bounds.length - 1; i >= 0; i--) {
        if (bounds[i].contentStart < cur.row) { target = i; break; }
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
        if (bounds[i].contentStart > cur.row) { target = i; break; }
      }
      if (target >= 0) {
        jumpHistoryCursorToRow(state, bounds[target].contentStart);
      } else {
        const lastBound = bounds[bounds.length - 1];
        if (isRowWithinBound(cur.row, lastBound)) state.historyCursor = bufferEnd(lines);
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
  scrollWithCursor(state, dir * amount);
}

/**
 * Ctrl+B / Ctrl+F — scroll full page AND move cursor by the same amount.
 */
export function scrollFullPageWithCursor(state: RenderState, dir: number): void {
  scrollWithCursor(state, dir * state.layout.messageAreaHeight);
}

/**
 * Scroll viewport and move cursor by `lines` rows.
 * Positive = up (towards older), negative = down (towards newer).
 * Cursor always moves (clamped to buffer bounds), viewport follows.
 */
function scrollWithCursor(state: RenderState, lines: number): void {
  const totalLines = state.historyLines.length;
  if (totalLines === 0) return;

  // Always move cursor, even if viewport can't scroll further
  const newRow = Math.max(0, Math.min(state.historyCursor.row - lines, totalLines - 1));
  state.historyCursor = clampCursor({ row: newRow, col: state.historyCursor.col }, state.historyLines);

  // Move viewport by same amount (clamped)
  const { messageAreaHeight } = state.layout;
  const maxOff = Math.max(0, totalLines - messageAreaHeight);
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset + lines, maxOff));

  // Ensure cursor is visible (cursor may have moved past viewport)
  ensureCursorVisible(state);
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
  const maxOff = Math.max(0, totalLines - messageAreaHeight);

  // Move viewport only
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset + dir, maxOff));

  // Cursor stays on same buffer row — only adjust if off-screen
  const viewStart = getViewStart(state);
  const viewEnd = viewStart + messageAreaHeight - 1;
  const curRow = state.historyCursor.row;

  if (curRow < viewStart) {
    state.historyCursor = clampCursor(
      { row: viewStart, col: state.historyCursor.col }, state.historyLines,
    );
  } else if (curRow > viewEnd) {
    state.historyCursor = clampCursor(
      { row: viewEnd, col: state.historyCursor.col }, state.historyLines,
    );
  }
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
    if (!vim.lastFind) return true;
    const dir = key.char === ";"
      ? vim.lastFind.direction
      : (vim.lastFind.direction === "f" ? "F" : "f") as "f" | "F";
    state.historyCursor = dir === "f"
      ? findForward(state.historyCursor, lines, vim.lastFind.char)
      : findBackward(state.historyCursor, lines, vim.lastFind.char);
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

/** Extract the selected text from history in visual/visual-line mode. */
export function getHistoryVisualSelection(state: RenderState): string {
  const anchor = state.historyVisualAnchor;
  const cursor = state.historyCursor;
  const lines = state.historyLines;
  const wrapCont = state.historyWrapContinuation;

  let startRow = Math.min(anchor.row, cursor.row);
  let endRow = Math.max(anchor.row, cursor.row);

  if (state.vim.mode === "visual-line") {
    // Expand to logical line groups
    if (wrapCont.length > 0) {
      startRow = logicalLineRange(startRow, wrapCont).first;
      endRow = logicalLineRange(endRow, wrapCont).last;
    }
    return joinLogicalLines(lines, wrapCont, startRow, endRow);
  }

  // Character visual — single line
  if (startRow === endRow) {
    const plain = stripAnsi(lines[startRow] ?? "");
    const startCol = Math.min(anchor.col, cursor.col);
    const endCol = Math.max(anchor.col, cursor.col);
    return plain.slice(startCol, endCol + 1).trim();
  }

  // Multi-line character selection
  const result: string[] = [];
  const firstPlain = stripAnsi(lines[startRow] ?? "");
  const lastPlain = stripAnsi(lines[endRow] ?? "");
  const firstCol = startRow === anchor.row ? anchor.col : cursor.col;
  const lastCol = endRow === anchor.row ? anchor.col : cursor.col;

  result.push(firstPlain.slice(firstCol).trimEnd());
  for (let r = startRow + 1; r < endRow; r++) {
    result.push(stripAnsi(lines[r] ?? "").trim());
  }
  result.push(lastPlain.slice(0, lastCol + 1).trimStart());

  return result.join("\n");
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
    const plain = joinLogicalLines(state.historyLines, wrapCont, first, last);
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

/**
 * Join visual rows into text, respecting wrap continuations.
 * Wrap-continuation rows are joined with a space (same logical line).
 * Non-continuation rows start a new \n-delimited line.
 */
export function joinLogicalLines(
  lines: string[],
  wrapCont: boolean[],
  startRow: number,
  endRow: number,
): string {
  const parts: string[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const text = stripAnsi(lines[r] ?? "").trim();
    if (r === startRow || !wrapCont[r]) {
      parts.push(text);
    } else {
      // Continuation of previous logical line — append with space
      parts[parts.length - 1] += (text ? " " + text : "");
    }
  }
  return parts.join("\n");
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
  if (totalLines <= messageAreaHeight) {
    state.scrollOffset = 0;
    return;
  }

  const cursorRow = state.historyCursor.row;
  const viewStart = getViewStart(state);
  const viewEnd = viewStart + messageAreaHeight;

  if (cursorRow < viewStart) {
    state.scrollOffset = totalLines - messageAreaHeight - cursorRow;
  } else if (cursorRow >= viewEnd) {
    state.scrollOffset = totalLines - messageAreaHeight - (cursorRow - messageAreaHeight + 1);
  }

  const maxScroll = Math.max(0, totalLines - messageAreaHeight);
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxScroll));
}
