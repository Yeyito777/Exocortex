/** Visible-width wrapping for already-rendered ANSI lines. */

import { nextGrapheme } from "./textwidth";

const ANSI_RESET = "\x1b[0m";

/** Remove visible leading spaces while retaining any SGR styling before them. */
export function trimAnsiLeadingSpaces(line: string, maxSpaces: number): { line: string; removed: number } {
  let cursor = 0;
  let removed = 0;
  let prefix = "";

  while (cursor < line.length) {
    if (line[cursor] === "\x1b") {
      const match = line.slice(cursor).match(/^\x1b\[[0-9;]*m/);
      if (!match) break;
      prefix += match[0];
      cursor += match[0].length;
      continue;
    }
    if (line[cursor] !== " " || removed >= maxSpaces) break;
    cursor++;
    removed++;
  }

  return { line: prefix + line.slice(cursor), removed };
}

/**
 * The SGR state after `sequence`. A 0 (or empty) parameter resets; the
 * arguments of an extended color (38/48/58 followed by `5;n` or `2;r;g;b`)
 * are not parameters, and a colon-form color (`38:2::0:5:15`) is one.
 */
function updateActiveSgr(active: string, sequence: string): string {
  const params = sequence.slice(2, -1).split(";");
  let lastReset = -1;
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    if (param === "38" || param === "48" || param === "58") {
      i += params[i + 1] === "5" ? 2 : params[i + 1] === "2" ? 4 : 0;
    } else if (Number(param) === 0) {
      lastReset = i;
    }
  }
  if (lastReset === -1) return active + sequence;
  return lastReset === params.length - 1 ? "" : sequence;
}

interface AnsiRowTake {
  /** End of this row's text in the input. */
  lineEnd: number;
  /** Where the next row resumes, or -1 when this row ends the input. */
  restStart: number;
  /** SGR state the next row reopens with. */
  activeSgr: string;
  join: string;
}

const SGR_RE = /\x1b\[[0-9;]*m/y;
const WHITESPACE_RE = /^\s+$/u;

/**
 * Take one row starting at `start`. Works on offsets into the original line:
 * slicing the remainder for every row (or every escape) made wrapping a long
 * streamed paragraph quadratic in its length.
 */
function takeAnsiRow(input: string, start: number, width: number, carriedSgr: string): AnsiRowTake {
  let cursor = start;
  let visibleWidth = 0;
  let activeSgr = carriedSgr;
  let lastBreak: AnsiRowTake | null = null;

  while (cursor < input.length) {
    if (input.charCodeAt(cursor) === 0x1b) {
      SGR_RE.lastIndex = cursor;
      const match = SGR_RE.exec(input);
      if (match) {
        activeSgr = updateActiveSgr(activeSgr, match[0]);
        cursor += match[0].length;
        continue;
      }
    }

    const [glyphWidth, end] = nextGrapheme(input, cursor);
    if (visibleWidth + glyphWidth > width && visibleWidth > 0) {
      // Whitespace just past the width is the best break: the row is full.
      const glyph = input.slice(cursor, end);
      if (WHITESPACE_RE.test(glyph)) return { lineEnd: cursor, restStart: end, activeSgr, join: glyph };
      return lastBreak ?? { lineEnd: cursor, restStart: cursor, activeSgr, join: "" };
    }

    visibleWidth += glyphWidth;
    if (visibleWidth > glyphWidth) {
      const glyph = input.slice(cursor, end);
      if (WHITESPACE_RE.test(glyph)) lastBreak = { lineEnd: cursor, restStart: end, activeSgr, join: glyph };
    }
    cursor = end;
  }

  return { lineEnd: input.length, restStart: -1, activeSgr: "", join: "" };
}

/** Word-wrap an ANSI-authored line without splitting escape sequences. */
export function wrapAnsiLine(line: string, width: number): { lines: string[]; joins: string[] } {
  const lines: string[] = [];
  const joins: string[] = [];
  let start = 0;
  // A row reopens the SGR state active where the previous row broke; parsing
  // that prefix again would yield the same state, so it seeds the scan.
  let carriedSgr = "";
  let pendingJoin = "";

  for (;;) {
    const taken = takeAnsiRow(line, start, Math.max(1, width), carriedSgr);
    const text = carriedSgr + line.slice(start, taken.lineEnd);
    lines.push(taken.restStart !== -1 && taken.activeSgr ? text + ANSI_RESET : text);
    joins.push(pendingJoin);
    if (taken.restStart === -1) break;
    carriedSgr = taken.activeSgr;
    start = taken.restStart;
    pendingJoin = taken.join;
  }

  return { lines, joins };
}
