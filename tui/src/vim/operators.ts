/**
 * Vim operators — pure functions.
 *
 * Each operator takes a buffer + range and returns a new buffer + cursor.
 * No side effects, no state.
 */

import type { BufferEdit } from "./types";
import { lineStartOf, lineEndOf, clampNormal, nextGraphemeEnd, previousGraphemeStart } from "./buffer";

// ── Core: delete a range ───────────────────────────────────────────

/** Delete [start, end) from the buffer. Returns raw cursor at start —
 *  caller clamps for normal mode, insert mode uses as-is. */
export function deleteRange(buffer: string, start: number, end: number): BufferEdit {
  if (start > end) [start, end] = [end, start];
  const newBuffer = buffer.slice(0, start) + buffer.slice(end);
  return { buffer: newBuffer, cursor: Math.min(start, newBuffer.length) };
}

// ── Line operators ─────────────────────────────────────────────────

/** dd — delete the entire line the cursor is on. */
export function deleteLine(buffer: string, pos: number): BufferEdit {
  const ls = lineStartOf(buffer, pos);
  const le = lineEndOf(buffer, pos);
  let start = ls;
  let end = le;

  // Include the newline: trailing if possible, else leading
  if (end < buffer.length) end++;
  else if (start > 0) start--;

  const newBuffer = buffer.slice(0, start) + buffer.slice(end);
  return { buffer: newBuffer, cursor: clampNormal(newBuffer, start) };
}

/** cc — clear line content (keep the line, cursor at line start). */
export function changeLine(buffer: string, pos: number): BufferEdit {
  const ls = lineStartOf(buffer, pos);
  const le = lineEndOf(buffer, pos);
  const newBuffer = buffer.slice(0, ls) + buffer.slice(le);
  return { buffer: newBuffer, cursor: ls };
}

// ── Character operators ────────────────────────────────────────────

/** x — delete character under cursor. */
export function deleteChar(buffer: string, pos: number): BufferEdit {
  if (pos >= buffer.length) return { buffer, cursor: pos };
  return deleteRange(buffer, pos, nextGraphemeEnd(buffer, pos));
}

/** X — delete character before cursor. */
export function deleteCharBefore(buffer: string, pos: number): BufferEdit {
  if (pos <= 0) return { buffer, cursor: 0 };
  return deleteRange(buffer, previousGraphemeStart(buffer, pos), pos);
}

// ── To-end-of-line operators ───────────────────────────────────────

/** D — delete from cursor to end of line. Stays in normal mode. */
export function deleteToEnd(buffer: string, pos: number): BufferEdit {
  const le = lineEndOf(buffer, pos);
  if (pos >= le) return { buffer, cursor: clampNormal(buffer, Math.max(0, pos - 1)) };
  const edit = deleteRange(buffer, pos, le);
  edit.cursor = clampNormal(edit.buffer, edit.cursor);
  return edit;
}

/** C — delete from cursor to end of line. Caller switches to insert mode. */
export function changeToEnd(buffer: string, pos: number): BufferEdit {
  const le = lineEndOf(buffer, pos);
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
  const end = Math.min(pos + count, le);
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
