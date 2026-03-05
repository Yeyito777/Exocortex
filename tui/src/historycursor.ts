/**
 * Chat history cursor — read-only navigation in rendered content.
 *
 * Owns the cursor position (row, col) within the rendered message
 * lines. Supports vim motions (h/j/k/l, w/W/b/B/e/E, 0/$, gg/G).
 *
 * The cursor operates on ANSI-stripped "plain" text. The renderer
 * uses (row, col) to place a reverse-video block cursor on the
 * corresponding screen position.
 */

import type { Action } from "./keybinds";
import type { RenderState } from "./state";

// ── State ──────────────────────────────────────────────────────────

export interface HistoryCursor {
  row: number;
  col: number;
}

export function createHistoryCursor(): HistoryCursor {
  return { row: 0, col: 0 };
}

// ── ANSI stripping ─────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\]8;[^;]*;[^\x1b]*\x1b\\/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// ── Character classification ───────────────────────────────────────

function isWordChar(ch: string): boolean { return /\w/.test(ch); }
function isSpace(ch: string): boolean { return ch === " " || ch === "\t"; }

// ── Content bounds ────────────────────────────────────────────────

/**
 * Find the first and last non-space character indices in a plain line.
 * Cursor is clamped to these bounds so it can't roam into padding
 * (e.g. leading spaces from right-aligned user messages).
 */
export function contentBounds(plain: string): { start: number; end: number } {
  let start = 0;
  while (start < plain.length && plain[start] === " ") start++;
  let end = plain.length - 1;
  while (end > start && plain[end] === " ") end--;
  // All spaces (e.g. empty indented AI line): cursor at last space
  // so it stays aligned with the indentation of surrounding content
  if (start > end) {
    const pos = Math.max(0, plain.length - 1);
    return { start: pos, end: pos };
  }
  return { start, end };
}

/** Clamp a column to the content bounds of a line. */
function clampCol(col: number, lines: string[], row: number): number {
  const plain = stripAnsi(lines[row] ?? "");
  if (plain.length === 0) return 0;
  const { start, end } = contentBounds(plain);
  return Math.max(start, Math.min(col, end));
}

// ── Motions ────────────────────────────────────────────────────────

/** Move cursor left, clamped to content start. */
export function charLeft(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const { start } = contentBounds(stripAnsi(lines[cursor.row] ?? ""));
  return { row: cursor.row, col: Math.max(start, cursor.col - 1) };
}

/** Move cursor right, clamped to content end. */
export function charRight(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const { end } = contentBounds(stripAnsi(lines[cursor.row] ?? ""));
  return { row: cursor.row, col: Math.min(end, cursor.col + 1) };
}

/** Move cursor up one line, col clamped to content bounds. */
export function lineUp(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  if (cursor.row <= 0) return cursor;
  const newRow = cursor.row - 1;
  return { row: newRow, col: clampCol(cursor.col, lines, newRow) };
}

/** Move cursor down one line, col clamped to content bounds. */
export function lineDown(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  if (cursor.row >= lines.length - 1) return cursor;
  const newRow = cursor.row + 1;
  return { row: newRow, col: clampCol(cursor.col, lines, newRow) };
}

/** Move to first non-space character (like vim ^). */
export function lineStart(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const { start } = contentBounds(stripAnsi(lines[cursor.row] ?? ""));
  return { row: cursor.row, col: start };
}

/** Move to last non-space character. */
export function lineEnd(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const { end } = contentBounds(stripAnsi(lines[cursor.row] ?? ""));
  return { row: cursor.row, col: end };
}

/** Move to first line, col at content start. */
export function bufferStart(lines: string[]): HistoryCursor {
  return { row: 0, col: clampCol(0, lines, 0) };
}

/** Move to last line, col at content start. */
export function bufferEnd(lines: string[]): HistoryCursor {
  const row = Math.max(0, lines.length - 1);
  return { row, col: clampCol(0, lines, row) };
}

/** word forward (w) — next word start on plain text of current line, wraps down. */
export function wordForward(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  const { end } = contentBounds(plain);
  let pos = cursor.col;

  if (pos <= end) {
    // Skip current word
    if (isWordChar(plain[pos])) {
      while (pos <= end && isWordChar(plain[pos])) pos++;
    } else if (!isSpace(plain[pos])) {
      while (pos <= end && !isWordChar(plain[pos]) && !isSpace(plain[pos])) pos++;
    }
    // Skip spaces
    while (pos <= end && isSpace(plain[pos])) pos++;
  }

  if (pos > end) {
    // Wrap to next non-empty line
    for (let r = cursor.row + 1; r < lines.length; r++) {
      const nb = contentBounds(stripAnsi(lines[r]));
      if (nb.end >= nb.start) return { row: r, col: nb.start };
    }
    return { row: cursor.row, col: end };
  }

  return { row: cursor.row, col: pos };
}

/** word backward (b) */
export function wordBackward(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  const { start } = contentBounds(plain);
  let pos = cursor.col;

  if (pos > start) {
    pos--;
    // Skip spaces
    while (pos > start && isSpace(plain[pos])) pos--;
    // Skip word
    if (isWordChar(plain[pos])) {
      while (pos > start && isWordChar(plain[pos - 1])) pos--;
    } else if (!isSpace(plain[pos])) {
      while (pos > start && !isWordChar(plain[pos - 1]) && !isSpace(plain[pos - 1])) pos--;
    }
    return { row: cursor.row, col: pos };
  }

  // Wrap to previous non-empty line
  for (let r = cursor.row - 1; r >= 0; r--) {
    const pb = contentBounds(stripAnsi(lines[r]));
    if (pb.end >= pb.start) return { row: r, col: pb.end };
  }
  return cursor;
}

/** word end (e) */
export function wordEnd(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  const { end } = contentBounds(plain);
  let pos = cursor.col;

  if (pos < end) {
    pos++;
    // Skip spaces
    while (pos <= end && isSpace(plain[pos])) pos++;
    // Run through word
    if (pos <= end) {
      if (isWordChar(plain[pos])) {
        while (pos < end && isWordChar(plain[pos + 1])) pos++;
      } else {
        while (pos < end && !isWordChar(plain[pos + 1]) && !isSpace(plain[pos + 1])) pos++;
      }
      return { row: cursor.row, col: pos };
    }
  }

  // Wrap to next non-empty line
  for (let r = cursor.row + 1; r < lines.length; r++) {
    const next = stripAnsi(lines[r]);
    const nb = contentBounds(next);
    if (nb.end >= nb.start) {
      let c = nb.start;
      if (isWordChar(next[c])) {
        while (c < nb.end && isWordChar(next[c + 1])) c++;
      } else {
        while (c < nb.end && !isWordChar(next[c + 1]) && !isSpace(next[c + 1])) c++;
      }
      return { row: r, col: c };
    }
  }
  return { row: cursor.row, col: end };
}

/** WORD forward (W) — whitespace-delimited */
export function wordForwardBig(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  const { end } = contentBounds(plain);
  let pos = cursor.col;

  // Skip non-space
  while (pos <= end && !isSpace(plain[pos])) pos++;
  // Skip space
  while (pos <= end && isSpace(plain[pos])) pos++;

  if (pos > end) {
    for (let r = cursor.row + 1; r < lines.length; r++) {
      const nb = contentBounds(stripAnsi(lines[r]));
      if (nb.end >= nb.start) return { row: r, col: nb.start };
    }
    return { row: cursor.row, col: end };
  }
  return { row: cursor.row, col: pos };
}

/** WORD backward (B) */
export function wordBackwardBig(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  const { start } = contentBounds(plain);
  let pos = cursor.col;

  if (pos > start) {
    pos--;
    while (pos > start && isSpace(plain[pos])) pos--;
    while (pos > start && !isSpace(plain[pos - 1])) pos--;
    return { row: cursor.row, col: pos };
  }

  for (let r = cursor.row - 1; r >= 0; r--) {
    const pb = contentBounds(stripAnsi(lines[r]));
    if (pb.end >= pb.start) return { row: r, col: pb.end };
  }
  return cursor;
}

/** WORD end (E) */
export function wordEndBig(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  const { end } = contentBounds(plain);
  let pos = cursor.col;

  if (pos < end) {
    pos++;
    while (pos <= end && isSpace(plain[pos])) pos++;
    while (pos < end && !isSpace(plain[pos + 1])) pos++;
    if (pos <= end) return { row: cursor.row, col: pos };
  }

  for (let r = cursor.row + 1; r < lines.length; r++) {
    const nb = contentBounds(stripAnsi(lines[r]));
    if (nb.end >= nb.start) {
      let c = nb.start;
      while (c < nb.end && !isSpace(stripAnsi(lines[r])[c + 1])) c++;
      return { row: r, col: c };
    }
  }
  return { row: cursor.row, col: end };
}

// ── Placement ──────────────────────────────────────────────────────

/**
 * Place cursor at the bottom of the visible content.
 * Called when entering history focus.
 */
export function placeAtBottom(lines: string[]): HistoryCursor {
  const row = Math.max(0, lines.length - 1);
  return { row, col: clampCol(0, lines, row) };
}

/** Clamp cursor to valid bounds after content changes. */
export function clampCursor(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  if (lines.length === 0) return { row: 0, col: 0 };
  const row = Math.min(cursor.row, lines.length - 1);
  return { row, col: clampCol(cursor.col, lines, row) };
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
    case "history_0":       state.historyCursor = lineStart(cur, lines); break;
    case "history_dollar":  state.historyCursor = lineEnd(cur, lines); break;
    case "history_gg":      state.historyCursor = bufferStart(lines); break;
    case "history_G":       state.historyCursor = bufferEnd(lines); break;
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
  const viewStart = totalLines - messageAreaHeight - state.scrollOffset;
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

/** Adjust scrollOffset so the cursor row is within the visible message area. */
export function ensureCursorVisible(state: RenderState): void {
  const { totalLines, messageAreaHeight } = state.layout;
  if (totalLines <= messageAreaHeight) {
    state.scrollOffset = 0;
    return;
  }

  const cursorRow = state.historyCursor.row;
  const viewStart = totalLines - messageAreaHeight - state.scrollOffset;
  const viewEnd = viewStart + messageAreaHeight;

  if (cursorRow < viewStart) {
    state.scrollOffset = totalLines - messageAreaHeight - cursorRow;
  } else if (cursorRow >= viewEnd) {
    state.scrollOffset = totalLines - messageAreaHeight - (cursorRow - messageAreaHeight + 1);
  }

  const maxScroll = Math.max(0, totalLines - messageAreaHeight);
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxScroll));
}
