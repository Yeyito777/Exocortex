/**
 * Vim operators — pure functions.
 *
 * Each operator takes a buffer + range and returns a new buffer + cursor.
 * No side effects, no state.
 */

import type { BufferEdit } from "./types";
import { lineStartOf, lineEndOf } from "./buffer";

// ── Core: delete a range ───────────────────────────────────────────

/** Delete [start, end) from the buffer. */
export function deleteRange(buffer: string, start: number, end: number): BufferEdit {
  if (start > end) [start, end] = [end, start];
  const newBuffer = buffer.slice(0, start) + buffer.slice(end);
  const cursor = Math.min(start, Math.max(0, newBuffer.length - 1));
  return { buffer: newBuffer, cursor: Math.max(0, cursor) };
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
  const cursor = Math.min(start, Math.max(0, newBuffer.length - 1));
  return { buffer: newBuffer, cursor: Math.max(0, cursor) };
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
  return deleteRange(buffer, pos, pos + 1);
}

/** X — delete character before cursor. */
export function deleteCharBefore(buffer: string, pos: number): BufferEdit {
  if (pos <= 0) return { buffer, cursor: 0 };
  return deleteRange(buffer, pos - 1, pos);
}

// ── To-end-of-line operators ───────────────────────────────────────

/** D — delete from cursor to end of line. */
export function deleteToEnd(buffer: string, pos: number): BufferEdit {
  const le = lineEndOf(buffer, pos);
  if (pos >= le) return { buffer, cursor: Math.max(0, pos - 1) };
  return deleteRange(buffer, pos, le);
}

/** C — same as D, but caller switches to insert mode. */
export function changeToEnd(buffer: string, pos: number): BufferEdit {
  return deleteToEnd(buffer, pos);
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
