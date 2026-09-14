import { wrapAnsiLine } from "../ansiwrap";
import type { LinkSpan } from "../links";
import { stripAnsi } from "../historymotions";
import { formatMarkdownChunksWithLinks } from "./formatting";

/** Format before wrapping: hidden destinations must not consume display width. */
export function wrapLinkedParagraphs(paragraphs: string[], width: number, bgRestore: string) {
  const formatted = formatMarkdownChunksWithLinks(paragraphs, paragraphs.map((_, i) => i ? "\n" : ""), bgRestore);
  const lines: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];
  const links: LinkSpan[][] = [];
  for (let p = 0; p < formatted.lines.length; p++) {
    const wrapped = wrapAnsiLine(formatted.lines[p], width);
    let offset = 0;
    for (let row = 0; row < wrapped.lines.length; row++) {
      offset += wrapped.joins[row].length;
      const length = stripAnsi(wrapped.lines[row]).length;
      links.push(formatted.links[p]
        .filter(span => span.start < offset + length && span.end > offset)
        .map(span => ({ target: span.target, start: Math.max(0, span.start - offset), end: Math.min(length, span.end - offset) })));
      lines.push(wrapped.lines[row]);
      cont.push(row > 0);
      join.push(wrapped.joins[row]);
      offset += length;
    }
  }
  return { lines, cont, join, links };
}
