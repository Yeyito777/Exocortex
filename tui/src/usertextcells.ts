/** Mapping between reflowed user-bubble rows and their canonical history rows. */

import { compareUserMessageFlowCursors, type UserMessageFlowCursor, type UserMessageRowText } from "./blockrenderer";
import type { RenderLineAnchor } from "./conversation";

/**
 * A reflowed bubble row's text: where it sits in its plain line and the source
 * cursor it starts at. Its columns are unrelated to the canonical line's.
 */
export type UserTextSpan = UserMessageRowText & { source: UserMessageFlowCursor };

/**
 * The canonical (line, column) each UTF-16 unit of a reflowed bubble row's
 * text shows. Column null marks a break the canonical layout wrapped at,
 * which it does not show.
 */
export function userTextCanonicalCells(
  lineAnchors: readonly RenderLineAnchor[],
  lineIndex: number,
  text: UserTextSpan,
): Array<{ lineIndex: number; col: number | null }> {
  const owner = lineAnchors[lineIndex]?.owner;
  const cells: Array<{ lineIndex: number; col: number | null }> = [];
  for (let index = 0; index < text.length; index++) {
    const position = { lineIndex: text.source.lineIndex, offset: text.source.offset + index };
    for (;;) {
      const next = lineAnchors[lineIndex + 1];
      if (next?.owner !== owner
        || !next.userFlowStart
        || compareUserMessageFlowCursors(next.userFlowStart, position) > 0) break;
      lineIndex++;
    }
    const start = lineAnchors[lineIndex]?.userFlowStart;
    const canonical = lineAnchors[lineIndex]?.userFlowText;
    const offset = position.offset - (start?.offset ?? 0);
    cells.push({
      lineIndex,
      col: start && canonical && start.lineIndex === position.lineIndex && offset >= 0 && offset < canonical.length
        ? canonical.col + offset
        : null,
    });
  }
  return cells;
}
