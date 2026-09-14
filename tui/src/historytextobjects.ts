/** Resolve Vim text objects in logical history text, not individual screen rows. */
import type { HistoryCursor } from "./historycursor";
import type { HistorySurface } from "./historysurface";
import { contentBounds, logicalLineRange, stripAnsi } from "./historymotions";
import { nextGraphemeEnd, previousGraphemeStart } from "./graphemes";
import { resolveTextObject } from "./vim/textobjects";

export function resolveHistoryTextObject(
  surface: HistorySurface,
  modifier: "i" | "a",
  key: string,
): { start: HistoryCursor; end: HistoryCursor } | null {
  const cursor = surface.cursor;
  let { first, last } = logicalLineRange(cursor.row, surface.wrapContinuation);

  // Brackets can enclose real newlines, but must not pair delimiters from
  // unrelated messages. Words/quotes retain their logical-line semantics.
  if ("()b{}B[]<>".includes(key)) {
    const message = surface.messageBounds.find(b => cursor.row >= b.contentStart && cursor.row < b.contentEnd);
    if (message) {
      first = message.contentStart;
      last = message.contentEnd - 1;
    }
  }

  let text = "";
  let cursorOffset: number | null = null;
  const rows: Array<{ row: number; col: number; offset: number; text: string }> = [];
  for (let row = first; row <= last; row++) {
    const projection = surface.copyLines[row];
    if (projection?.skip) continue;
    const plain = stripAnsi(surface.lines[row] ?? "");
    const bounds = contentBounds(plain);
    const col = projection?.displayStart ?? bounds.start;
    const rowText = projection?.text ?? plain.slice(bounds.start, nextGraphemeEnd(plain, bounds.end));
    if (rows.length > 0) {
      text += surface.wrapContinuation[row] ? (surface.wrapJoiners[row] ?? " ") : "\n";
    }
    const offset = text.length;
    rows.push({ row, col, offset, text: rowText });
    if (row === cursor.row) {
      cursorOffset = offset + Math.max(0, Math.min(rowText.length - 1, cursor.col - col));
    }
    text += rowText;
  }
  if (cursorOffset === null) return null;
  const range = resolveTextObject(modifier, key, text, cursorOffset);
  if (!range || range.start >= range.end) return null;

  // Wrap separators and real newlines have no screen cell. Snap endpoints
  // inward to represented characters, retaining separators between the rows.
  let start: HistoryCursor | null = null;
  let end: HistoryCursor | null = null;
  for (const row of rows) {
    const from = Math.max(0, range.start - row.offset);
    const to = Math.min(row.text.length, range.end - row.offset);
    if (from >= to) continue;
    start ??= { row: row.row, col: row.col + from };
    end = { row: row.row, col: row.col + previousGraphemeStart(row.text, to) };
  }
  return start && end ? { start, end } : null;
}
