import { findOpenableTargetMatches } from "./openable";
import { activeHistorySurface } from "./historysurface";
import { contentBounds, logicalLineRange, stripAnsi } from "./historymotions";
import type { RenderState } from "./state";

/**
 * Return the configured-openable target currently under the history cursor.
 *
 * Rendered history may hard-wrap long paths/URLs across multiple visual rows,
 * so this reconstructs the current logical line before mapping the cursor
 * column back into that logical text.
 */
export function openableTargetAtHistoryCursor(state: RenderState): string | null {
  const surface = activeHistorySurface(state);
  const row = surface.cursor.row;
  const lines = surface.lines;
  if (row < 0 || row >= lines.length) return null;

  const range = surface.wrapContinuation.length > 0
    ? logicalLineRange(row, surface.wrapContinuation)
    : { first: row, last: row };

  let logicalText = "";
  let cursorOffset: number | null = null;
  for (let r = range.first; r <= range.last; r++) {
    const plain = stripAnsi(lines[r] ?? "");
    const bounds = contentBounds(plain);
    const segment = plain.slice(bounds.start, bounds.end + 1);
    const joiner = r === range.first ? "" : (surface.wrapJoiners[r] ?? " ");
    logicalText += joiner;
    const segmentStart = logicalText.length;
    logicalText += segment;

    if (r !== row) continue;
    const col = surface.cursor.col;
    if (col < bounds.start || col > bounds.end) return null;
    cursorOffset = segmentStart + Math.max(0, Math.min(col - bounds.start, segment.length - 1));
  }

  if (cursorOffset == null) return null;
  for (const match of findOpenableTargetMatches(logicalText)) {
    if (cursorOffset >= match.start && cursorOffset < match.end) return match.target;
  }
  return null;
}
