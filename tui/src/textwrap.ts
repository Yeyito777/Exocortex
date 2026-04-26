/**
 * Plain terminal word wrapping helpers.
 *
 * Wrap results retain continuation metadata so history yanks can reconstruct
 * logical text without adding or losing separators at soft-wrap boundaries.
 */
import { sliceByWidth, termWidth } from "./textwidth";

export interface WrapResult {
  lines: string[];
  /** true for visual lines that are continuations of the previous logical line. */
  cont: boolean[];
  /** separator to reinsert before each continuation line when reconstructing plain text. */
  join: string[];
}

function firstCodePoint(text: string): string {
  return Array.from(text)[0] ?? "";
}

export function wordWrap(text: string, width: number): WrapResult {
  if (width <= 0) return { lines: [text], cont: [false], join: [""] };
  const lines: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];

  for (const rawLine of text.split("\n")) {
    if (termWidth(rawLine) <= width) {
      lines.push(rawLine);
      cont.push(false);
      join.push("");
      continue;
    }
    let line = rawLine;
    let first = true;
    let pendingJoin = "";
    while (termWidth(line) > width) {
      const [taken] = sliceByWidth(line, width);
      let breakAt = taken.lastIndexOf(" ");
      let nextJoin = breakAt > 0 ? " " : "";
      if (breakAt <= 0 && taken.length > 0 && line[taken.length] === " ") {
        // Match the previous ASCII wrapper's behavior when the best break is a
        // space exactly at the wrap boundary. The space is omitted visually but
        // preserved as the copy/yank joiner for the continuation row.
        breakAt = taken.length;
        nextJoin = " ";
      }
      if (breakAt <= 0) {
        // If the first grapheme is wider than the wrap width, sliceByWidth()
        // returns an empty prefix. Still consume one codepoint so wrapping makes
        // progress; extremely narrow terminals may display that glyph as wide.
        breakAt = taken.length > 0 ? taken.length : firstCodePoint(line).length;
      }
      lines.push(line.slice(0, breakAt));
      cont.push(!first);
      join.push(first ? "" : pendingJoin);
      first = false;
      line = line.slice(breakAt).trimStart();
      pendingJoin = nextJoin;
    }
    if (line) {
      lines.push(line);
      cont.push(!first);
      join.push(first ? "" : pendingJoin);
    }
  }

  return { lines, cont, join };
}
