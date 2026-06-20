/**
 * Plain terminal word wrapping helpers.
 *
 * Wrap results retain continuation metadata so history yanks can reconstruct
 * logical text without adding or losing separators at soft-wrap boundaries.
 */
import { sliceByWidthFrom } from "./textwidth";

export interface WrapResult {
  lines: string[];
  /** true for visual lines that are continuations of the previous logical line. */
  cont: boolean[];
  /** separator to reinsert before each continuation line when reconstructing plain text. */
  join: string[];
  /**
   * Optional per-rendered-row projection used for vim yanks/copies.
   *
   * Most rendered rows are copied by stripping ANSI and trimming display padding.
   * Rows with markdown-only decoration (for example fenced-code gutters and
   * language labels) can provide their source text here so clipboard output does
   * not include those display-only markers.
   */
  copy?: Array<WrapCopyLine | null>;
}

export interface WrapCopyLine {
  /** Plain text represented by this visual row. */
  text: string;
  /** Column in the ANSI-stripped rendered row where `text` begins. */
  displayStart: number;
  /** Omit this display-only row entirely from yanks/copies. */
  skip?: boolean;
}

function firstCodePointEnd(text: string, start: number): number {
  const cp = text.codePointAt(start);
  if (cp === undefined) return start;
  return start + (cp > 0xFFFF ? 2 : 1);
}

function trimStartIndex(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const char = String.fromCodePoint(cp);
    if (char.trimStart() !== "") break;
    i += cp > 0xFFFF ? 2 : 1;
  }
  return i;
}

export function wordWrap(text: string, width: number): WrapResult {
  if (width <= 0) return { lines: [text], cont: [false], join: [""] };
  const lines: string[] = [];
  const cont: boolean[] = [];
  const join: string[] = [];

  for (const rawLine of text.split("\n")) {
    if (rawLine.length === 0) {
      lines.push(rawLine);
      cont.push(false);
      join.push("");
      continue;
    }

    let lineStart = 0;
    let first = true;
    let pendingJoin = "";
    for (;;) {
      const [fitEnd] = sliceByWidthFrom(rawLine, lineStart, width);
      if (fitEnd >= rawLine.length) break;

      const fit = rawLine.slice(lineStart, fitEnd);
      const breakRel = fit.lastIndexOf(" ");
      let breakAt = breakRel > 0 ? lineStart + breakRel : -1;
      let nextJoin = breakAt > 0 ? " " : "";

      if (breakRel <= 0 && fitEnd > lineStart && rawLine[fitEnd] === " ") {
        // Match the previous ASCII wrapper's behavior when the best break is a
        // space exactly at the wrap boundary. The space is omitted visually but
        // preserved as the copy/yank joiner for the continuation row.
        breakAt = fitEnd;
        nextJoin = " ";
      }

      if (breakAt <= lineStart) {
        // If the first grapheme is wider than the wrap width, sliceByWidth()
        // returns an empty prefix. Still consume one codepoint so wrapping makes
        // progress; extremely narrow terminals may display that glyph as wide.
        breakAt = fitEnd > lineStart ? fitEnd : firstCodePointEnd(rawLine, lineStart);
      }

      lines.push(rawLine.slice(lineStart, breakAt));
      cont.push(!first);
      join.push(first ? "" : pendingJoin);
      first = false;
      lineStart = trimStartIndex(rawLine, breakAt);
      pendingJoin = nextJoin;
    }
    if (lineStart < rawLine.length) {
      lines.push(rawLine.slice(lineStart));
      cont.push(!first);
      join.push(first ? "" : pendingJoin);
    }
  }

  return { lines, cont, join };
}
