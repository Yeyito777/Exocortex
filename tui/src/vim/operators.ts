/**
 * Vim operators — pure functions.
 *
 * Each operator takes a buffer + range and returns a new buffer + cursor.
 * No side effects, no state.
 */

import type { BufferEdit } from "./types";
import { lineStartOf, lineEndOf, clampNormal, nextGraphemeEnd, previousGraphemeStart } from "./buffer";
import { PROMPT_TAB, PROMPT_TAB_WIDTH } from "../prompttabs";

// ── Core: delete a range ───────────────────────────────────────────

/** Delete [start, end) from the buffer. Returns raw cursor at start —
 *  caller clamps for normal mode, insert mode uses as-is. */
export function deleteRange(buffer: string, start: number, end: number): BufferEdit {
  if (start > end) [start, end] = [end, start];
  const newBuffer = buffer.slice(0, start) + buffer.slice(end);
  return { buffer: newBuffer, cursor: Math.min(start, newBuffer.length) };
}

// ── Line operators ─────────────────────────────────────────────────
// Linewise operators take `first` (start of the first line) and `last`
// (end of the last line: its \n or buffer.length).

/** The span of the cursor's line plus `delta` more lines below (+) or above (-), clamped to the buffer. */
export function lineSpan(buffer: string, pos: number, delta: number): { first: number; last: number } {
  let first = lineStartOf(buffer, pos);
  let last = lineEndOf(buffer, pos);
  for (let i = 0; i < Math.abs(delta); i++) {
    if (delta > 0 && last < buffer.length) last = lineEndOf(buffer, last + 1);
    else if (delta < 0 && first > 0) first = lineStartOf(buffer, first - 1);
  }
  return { first, last };
}

/** dd/dj/dk — delete whole lines; cursor at the start of the line that takes their place. */
export function deleteLines(buffer: string, first: number, last: number): BufferEdit {
  let start = first;
  let end = last;

  // Include the newline: trailing if possible, else leading
  if (end < buffer.length) end++;
  else if (start > 0) start--;

  const newBuffer = buffer.slice(0, start) + buffer.slice(end);
  return { buffer: newBuffer, cursor: lineStartOf(newBuffer, start) };
}

/** cc/cj/ck — replace whole lines with one empty line (cursor at its start). */
export function changeLines(buffer: string, first: number, last: number): BufferEdit {
  return { buffer: buffer.slice(0, first) + buffer.slice(last), cursor: first };
}

/** yy/yj/yk — whole lines as a linewise register: always \n-terminated. */
export function linewiseText(buffer: string, first: number, last: number): string {
  return buffer.slice(first, last) + "\n";
}

/** p/P of linewise text — put whole lines below/above the cursor's line. */
export function putLines(buffer: string, pos: number, text: string, below: boolean): BufferEdit {
  // wl-paste drops the trailing newline, so restore it.
  const lines = text.endsWith("\n") ? text : text + "\n";
  let newBuffer: string;
  let lineStart: number;
  if (!below) {
    lineStart = lineStartOf(buffer, pos);
    newBuffer = buffer.slice(0, lineStart) + lines + buffer.slice(lineStart);
  } else {
    const le = lineEndOf(buffer, pos);
    lineStart = le + 1;
    newBuffer = le < buffer.length
      ? buffer.slice(0, lineStart) + lines + buffer.slice(lineStart)
      : buffer + "\n" + lines.slice(0, -1);
  }
  // Like Vim, land on the first nonblank of the first put line.
  let cursor = lineStart;
  while (newBuffer[cursor] === " " || newBuffer[cursor] === "\t") cursor++;
  return { buffer: newBuffer, cursor: clampNormal(newBuffer, cursor) };
}

/** Shift every logical line touched by the inclusive range by one soft tab. */
export function shiftLines(buffer: string, start: number, end: number, direction: -1 | 1): BufferEdit {
  const first = lineStartOf(buffer, Math.min(start, end));
  const last = lineEndOf(buffer, Math.max(start, end));
  const lines = buffer.slice(first, last).split("\n").map(line => {
    if (direction > 0) return PROMPT_TAB + line;
    const indent = line.match(/^ */)![0].length;
    return line.slice(Math.min(indent, PROMPT_TAB_WIDTH));
  });
  const newBuffer = buffer.slice(0, first) + lines.join("\n") + buffer.slice(last);
  // Like Vim, land on the first nonblank of the first shifted line.
  const indent = lines[0].match(/^ */)![0].length;
  const col = Math.min(indent, Math.max(0, lines[0].length - 1));
  return { buffer: newBuffer, cursor: clampNormal(newBuffer, first + col) };
}

// ── Character operators ────────────────────────────────────────────

/** x — delete `count` characters from the cursor, never the line break. */
export function deleteChars(buffer: string, pos: number, count: number): BufferEdit {
  const le = lineEndOf(buffer, pos);
  let end = pos;
  for (let i = 0; i < count && end < le; i++) end = nextGraphemeEnd(buffer, end);
  return deleteRange(buffer, pos, end);
}

/** X — delete `count` characters before the cursor, within the line. */
export function deleteCharsBefore(buffer: string, pos: number, count: number): BufferEdit {
  const ls = lineStartOf(buffer, pos);
  let start = pos;
  for (let i = 0; i < count && start > ls; i++) start = previousGraphemeStart(buffer, start);
  return deleteRange(buffer, start, pos);
}

// ── To-end-of-line operators ───────────────────────────────────────

/** End of the line `count - 1` lines below the cursor's (D/C with a count). */
function countedLineEnd(buffer: string, pos: number, count: number): number {
  return lineSpan(buffer, pos, count - 1).last;
}

/** D — delete from cursor to end of line (and `count - 1` more lines). Stays in normal mode. */
export function deleteToEnd(buffer: string, pos: number, count = 1): BufferEdit {
  const le = countedLineEnd(buffer, pos, count);
  if (pos >= le) return { buffer, cursor: pos };
  const edit = deleteRange(buffer, pos, le);
  edit.cursor = clampNormal(edit.buffer, edit.cursor);
  return edit;
}

/** C — delete from cursor to end of line (and `count - 1` more lines). Caller switches to insert mode. */
export function changeToEnd(buffer: string, pos: number, count = 1): BufferEdit {
  const le = countedLineEnd(buffer, pos, count);
  if (pos >= le) return { buffer, cursor: pos };
  return deleteRange(buffer, pos, le);
}

// ── Open line ──────────────────────────────────────────────────────

/** o — open a new line below and position cursor there. */
export function openLineBelow(buffer: string, pos: number): BufferEdit {
  const le = lineEndOf(buffer, pos);
  const newBuffer = buffer.slice(0, le) + "\n" + buffer.slice(le);
  return { buffer: newBuffer, cursor: le + 1 };
}

/** O — open a new line above and position cursor there. */
export function openLineAbove(buffer: string, pos: number): BufferEdit {
  const ls = lineStartOf(buffer, pos);
  const newBuffer = buffer.slice(0, ls) + "\n" + buffer.slice(ls);
  return { buffer: newBuffer, cursor: ls };
}

// ── Case operators ────────────────────────────────────────────────

/** Swap the case of every character in [start, end). */
function toggleCase(text: string): string {
  let out = "";
  for (const ch of text) {
    out += ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
  }
  return out;
}

/** ~ (normal) — swap case of `count` characters starting at pos, advance cursor. */
export function swapCase(buffer: string, pos: number, count: number): BufferEdit {
  const le = lineEndOf(buffer, pos);
  // Clamp count so we don't cross the newline / buffer end
  let end = pos;
  for (let i = 0; i < count && end < le; i++) end = nextGraphemeEnd(buffer, end);
  if (pos >= end) return { buffer, cursor: pos };
  const swapped = toggleCase(buffer.slice(pos, end));
  const newBuffer = buffer.slice(0, pos) + swapped + buffer.slice(end);
  // Cursor lands on the last swapped character (clamped to line)
  return { buffer: newBuffer, cursor: clampNormal(newBuffer, end) };
}

/** r — replace character under cursor with the given character. */
export function replaceChar(buffer: string, pos: number, ch: string): BufferEdit {
  if (pos >= buffer.length || buffer[pos] === "\n") return { buffer, cursor: pos };
  const newBuffer = buffer.slice(0, pos) + ch + buffer.slice(nextGraphemeEnd(buffer, pos));
  return { buffer: newBuffer, cursor: pos };
}

/** ~ (visual) — swap case of [start, end), cursor goes to start. */
export function swapCaseRange(buffer: string, start: number, end: number): BufferEdit {
  if (start > end) [start, end] = [end, start];
  const swapped = toggleCase(buffer.slice(start, end));
  const newBuffer = buffer.slice(0, start) + swapped + buffer.slice(end);
  return { buffer: newBuffer, cursor: clampNormal(newBuffer, start) };
}
