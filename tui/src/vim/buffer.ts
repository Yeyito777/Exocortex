/**
 * Buffer primitives — shared across vim modules.
 *
 * Line boundary helpers used by motions, operators, and the engine.
 * Single source of truth for these calculations.
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
