/**
 * Buffer primitives — shared across vim modules.
 *
 * Line boundary helpers and cursor clamping used by motions,
 * operators, the engine, and focus. Single source of truth.
 */

/** Find the start of the line containing `pos`. */
export function lineStartOf(buffer: string, pos: number): number {
  const idx = buffer.lastIndexOf("\n", pos - 1);
  return idx === -1 ? 0 : idx + 1;
}

/** Find the end of the line containing `pos` (the \n or buffer.length). */
export function lineEndOf(buffer: string, pos: number): number {
  const idx = buffer.indexOf("\n", pos);
  return idx === -1 ? buffer.length : idx;
}

/**
 * Clamp cursor position for normal mode.
 * If buffer ends with \n, allows buf.length (the implicit empty trailing line).
 * Otherwise clamps to buf.length - 1 (sit ON the last char, not past it).
 */
export function clampNormal(buffer: string, pos: number): number {
  if (buffer.length === 0) return 0;
  const max = buffer[buffer.length - 1] === "\n" ? buffer.length : buffer.length - 1;
  return Math.max(0, Math.min(pos, max));
}
