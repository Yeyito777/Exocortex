/**
 * Pure motion functions for the chat history cursor.
 *
 * All functions take a HistoryCursor + rendered lines, return a new
 * HistoryCursor. No side effects, no state mutation, no RenderState.
 * Also owns ANSI stripping and content bounds — the foundation
 * that every motion depends on.
 */

import type { HistoryCursor } from "./historycursor";
import { isWordChar, isSpace } from "./chars";

// ── ANSI stripping ─────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\]8;[^;]*;[^\x1b]*\x1b\\/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

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
  // All spaces or empty (e.g. blank indented AI line): cursor at
  // indentation point (where text would start on this line).
  if (start >= plain.length) {
    const pos = Math.max(0, plain.length);
    return { start: pos, end: pos };
  }
  return { start, end };
}

/** Clamp a column to the content bounds of a line. */
export function clampCol(col: number, lines: string[], row: number): number {
  const plain = stripAnsi(lines[row] ?? "");
  if (plain.length === 0) return 0;
  const { start, end } = contentBounds(plain);
  return Math.max(start, Math.min(col, end));
}

// ── Logical line groups ──────────────────────────────────────────

/**
 * Get the range of visual rows that belong to the same logical line as `row`.
 * A logical line is a group of consecutive visual rows where all but the
 * first have wrapCont[r] === true (they are word-wrap continuations).
 */
export function logicalLineRange(
  row: number,
  wrapCont: boolean[],
): { first: number; last: number } {
  let first = row;
  while (first > 0 && wrapCont[first]) first--;
  let last = row;
  while (last < wrapCont.length - 1 && wrapCont[last + 1]) last++;
  return { first, last };
}

// ── Basic motions ─────────────────────────────────────────────────

export function charLeft(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const { start } = contentBounds(stripAnsi(lines[cursor.row] ?? ""));
  return { row: cursor.row, col: Math.max(start, cursor.col - 1) };
}

export function charRight(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const { end } = contentBounds(stripAnsi(lines[cursor.row] ?? ""));
  return { row: cursor.row, col: Math.min(end, cursor.col + 1) };
}

export function lineUp(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  if (cursor.row <= 0) return cursor;
  const newRow = cursor.row - 1;
  return { row: newRow, col: clampCol(cursor.col, lines, newRow) };
}

export function lineDown(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  if (cursor.row >= lines.length - 1) return cursor;
  const newRow = cursor.row + 1;
  return { row: newRow, col: clampCol(cursor.col, lines, newRow) };
}

export function lineStart(cursor: HistoryCursor, lines: string[], wrapCont?: boolean[]): HistoryCursor {
  const row = wrapCont ? logicalLineRange(cursor.row, wrapCont).first : cursor.row;
  const { start } = contentBounds(stripAnsi(lines[row] ?? ""));
  return { row, col: start };
}

export function lineEnd(cursor: HistoryCursor, lines: string[], wrapCont?: boolean[]): HistoryCursor {
  const row = wrapCont ? logicalLineRange(cursor.row, wrapCont).last : cursor.row;
  const { end } = contentBounds(stripAnsi(lines[row] ?? ""));
  return { row, col: end };
}

export function bufferStart(lines: string[]): HistoryCursor {
  return { row: 0, col: clampCol(0, lines, 0) };
}

export function bufferEnd(lines: string[]): HistoryCursor {
  const row = Math.max(0, lines.length - 1);
  return { row, col: clampCol(0, lines, row) };
}

// ── Word motions ──────────────────────────────────────────────────

export function wordForward(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  const { end } = contentBounds(plain);
  let pos = cursor.col;

  if (pos <= end) {
    if (isWordChar(plain[pos])) {
      while (pos <= end && isWordChar(plain[pos])) pos++;
    } else if (!isSpace(plain[pos])) {
      while (pos <= end && !isWordChar(plain[pos]) && !isSpace(plain[pos])) pos++;
    }
    while (pos <= end && isSpace(plain[pos])) pos++;
  }

  if (pos > end) {
    for (let r = cursor.row + 1; r < lines.length; r++) {
      const nb = contentBounds(stripAnsi(lines[r]));
      if (nb.end >= nb.start) return { row: r, col: nb.start };
    }
    return { row: cursor.row, col: end };
  }

  return { row: cursor.row, col: pos };
}

export function wordBackward(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  const { start } = contentBounds(plain);
  let pos = cursor.col;

  if (pos > start) {
    pos--;
    while (pos > start && isSpace(plain[pos])) pos--;
    if (isWordChar(plain[pos])) {
      while (pos > start && isWordChar(plain[pos - 1])) pos--;
    } else if (!isSpace(plain[pos])) {
      while (pos > start && !isWordChar(plain[pos - 1]) && !isSpace(plain[pos - 1])) pos--;
    }
    return { row: cursor.row, col: pos };
  }

  for (let r = cursor.row - 1; r >= 0; r--) {
    const pb = contentBounds(stripAnsi(lines[r]));
    if (pb.end >= pb.start) return { row: r, col: pb.end };
  }
  return cursor;
}

export function wordEnd(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  const { end } = contentBounds(plain);
  let pos = cursor.col;

  if (pos < end) {
    pos++;
    while (pos <= end && isSpace(plain[pos])) pos++;
    if (pos <= end) {
      if (isWordChar(plain[pos])) {
        while (pos < end && isWordChar(plain[pos + 1])) pos++;
      } else {
        while (pos < end && !isWordChar(plain[pos + 1]) && !isSpace(plain[pos + 1])) pos++;
      }
      return { row: cursor.row, col: pos };
    }
  }

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

// ── WORD motions ──────────────────────────────────────────────────

export function wordForwardBig(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  const { end } = contentBounds(plain);
  let pos = cursor.col;

  while (pos <= end && !isSpace(plain[pos])) pos++;
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
    const next = stripAnsi(lines[r]);
    const nb = contentBounds(next);
    if (nb.end >= nb.start) {
      let c = nb.start;
      while (c < nb.end && !isSpace(next[c + 1])) c++;
      return { row: r, col: c };
    }
  }
  return { row: cursor.row, col: end };
}

// ── Find motions (f/F) ─────────────────────────────────────────────

export function findForward(cursor: HistoryCursor, lines: string[], char: string): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row] ?? "");
  const { end } = contentBounds(plain);
  for (let i = cursor.col + 1; i <= end; i++) {
    if (plain[i] === char) return { row: cursor.row, col: i };
  }
  return cursor;
}

export function findBackward(cursor: HistoryCursor, lines: string[], char: string): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row] ?? "");
  const { start } = contentBounds(plain);
  for (let i = cursor.col - 1; i >= start; i--) {
    if (plain[i] === char) return { row: cursor.row, col: i };
  }
  return cursor;
}

// ── Placement ─────────────────────────────────────────────────────

export function placeAtBottom(lines: string[]): HistoryCursor {
  if (lines.length === 0) return { row: 0, col: 0 };
  const row = lines.length - 1;
  return { row, col: clampCol(0, lines, row) };
}

export function clampCursor(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  if (lines.length === 0) return { row: 0, col: 0 };
  const row = Math.max(0, Math.min(cursor.row, lines.length - 1));
  return { row, col: clampCol(cursor.col, lines, row) };
}
