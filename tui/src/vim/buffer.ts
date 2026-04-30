/**
 * Buffer primitives — shared across vim modules.
 *
 * Line boundary helpers and cursor clamping used by motions,
 * operators, the engine, and focus. Cursor movement is grapheme-aware:
 * offsets are still UTF-16 string indices, but they are snapped to
 * user-visible character boundaries so emoji cannot be split.
 */

import { graphemeBoundaryAtOrAfter, graphemeStartAtOrAfter, nextGraphemeEnd, previousGraphemeStart } from "../graphemes";

/** Find the start of the line containing `pos`. */
export function lineStartOf(buffer: string, pos: number): number {
  if (pos <= 0) return 0;
  const idx = buffer.lastIndexOf("\n", pos - 1);
  return idx === -1 ? 0 : idx + 1;
}

/** Find the end of the line containing `pos` (the \n or buffer.length). */
export function lineEndOf(buffer: string, pos: number): number {
  const idx = buffer.indexOf("\n", pos);
  return idx === -1 ? buffer.length : idx;
}

/** Clamp an insert-mode cursor to a safe string-slice boundary. */
export function clampInsert(buffer: string, pos: number): number {
  return graphemeBoundaryAtOrAfter(buffer, pos);
}

/**
 * Clamp cursor position for normal mode.
 * If buffer ends with \n, allows buf.length (the implicit empty trailing line).
 * Otherwise clamps to the start of the last grapheme (sit ON the last char,
 * not past it, and never inside it).
 */
export function clampNormal(buffer: string, pos: number): number {
  if (buffer.length === 0) return 0;
  const max = buffer[buffer.length - 1] === "\n"
    ? buffer.length
    : previousGraphemeStart(buffer, buffer.length);
  return graphemeStartAtOrAfter(buffer, Math.max(0, Math.min(pos, max)));
}

export { nextGraphemeEnd, previousGraphemeStart };
