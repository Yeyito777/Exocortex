/** Visible-width wrapping for already-rendered ANSI lines. */

import { nextGrapheme, visibleLength } from "./textwidth";

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

function updateActiveSgr(active: string, sequence: string): string {
  const params = sequence.slice(2, -1);
  const values = params === "" ? ["0"] : params.split(";");
  if (values.includes("0")) return values.every(value => value === "0") ? "" : sequence;
  return active + sequence;
}

interface AnsiRowTake {
  line: string;
  rest: string;
  join: string;
}

function takeAnsiRow(input: string, width: number): AnsiRowTake {
  if (visibleLength(input) <= width) return { line: input, rest: "", join: "" };

  let cursor = 0;
  let visibleWidth = 0;
  let activeSgr = "";
  let lastBreak: { lineEnd: number; restStart: number; activeSgr: string; join: string } | null = null;

  while (cursor < input.length) {
    if (input[cursor] === "\x1b") {
      const match = input.slice(cursor).match(/^\x1b\[[0-9;]*m/);
      if (match) {
        activeSgr = updateActiveSgr(activeSgr, match[0]);
        cursor += match[0].length;
        continue;
      }
    }

    const [glyphWidth, end] = nextGrapheme(input, cursor);
    if (visibleWidth + glyphWidth > width && visibleWidth > 0) {
      if (lastBreak) {
        const line = input.slice(0, lastBreak.lineEnd) + (lastBreak.activeSgr ? ANSI_RESET : "");
        const rest = lastBreak.activeSgr + input.slice(lastBreak.restStart);
        return { line, rest, join: lastBreak.join };
      }
      return {
        line: input.slice(0, cursor) + (activeSgr ? ANSI_RESET : ""),
        rest: activeSgr + input.slice(cursor),
        join: "",
      };
    }

    const glyph = input.slice(cursor, end);
    visibleWidth += glyphWidth;
    cursor = end;
    if (/^\s+$/u.test(glyph) && visibleWidth > glyphWidth) {
      lastBreak = {
        lineEnd: cursor - glyph.length,
        restStart: cursor,
        activeSgr,
        join: glyph,
      };
    }
  }

  return { line: input, rest: "", join: "" };
}

/** Word-wrap an ANSI-authored line without splitting escape sequences. */
export function wrapAnsiLine(line: string, width: number): { lines: string[]; joins: string[] } {
  const lines: string[] = [];
  const joins: string[] = [];
  let remaining = line;
  let pendingJoin = "";

  for (;;) {
    const taken = takeAnsiRow(remaining, Math.max(1, width));
    lines.push(taken.line);
    joins.push(pendingJoin);
    if (!taken.rest) break;
    remaining = taken.rest;
    pendingJoin = taken.join;
  }

  return { lines, joins };
}
