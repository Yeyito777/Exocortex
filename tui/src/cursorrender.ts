/**
 * ANSI cursor & selection overlay rendering.
 *
 * Paints a block cursor or selection highlight onto ANSI-styled
 * strings. Preserves surrounding text styles (bold, fg color, etc)
 * through resets.
 *
 * Three functions:
 * - renderLineWithCursor: single character block cursor
 * - renderLineWithSelection: highlight a column range
 * - renderLineWithSearch: highlight one or more search-match ranges
 */

import { hexToAnsi, theme } from "./theme";
import { stripAnsi } from "./historycursor";
import { nextGraphemeEnd } from "./graphemes";

const CURSOR_FG = hexToAnsi("#000000"); // black text on cursor
const ANSI_OR_HYPERLINK = /^\x1b(?:\[[0-9;]*[A-Za-z]|\]8;[^;]*;[^\x1b]*\x1b\\)/;

/**
 * Render a line with a themed block cursor at the given visible
 * column position. Walks the ANSI string, counting only visible
 * characters to find the right spot.
 *
 * After the cursor character, re-emits active text styles (bold,
 * fg color, etc). Background restoration is handled by the caller
 * via applyLineBg() — this function only cares about the cursor
 * character and preserving text styling around it.
 */
export function renderLineWithCursor(line: string, col: number): string {
  const plain = stripAnsi(line);
  if (plain.length === 0) {
    return `${CURSOR_FG}${theme.cursorBg} ${theme.reset}`;
  }

  const parts: string[] = [];
  let visIdx = 0;
  let i = 0;
  let cursorRendered = false;
  // Track active ANSI escapes so we can restore after cursor reset
  let activeEscapes: string[] = [];

  while (i < line.length) {
    if (line[i] === "\x1b") {
      const match = line.slice(i).match(ANSI_OR_HYPERLINK);
      if (match) {
        const esc = match[0];
        // Track style state: reset clears all, otherwise accumulate
        if (esc === theme.reset || esc === "\x1b[0m") {
          activeEscapes = [];
        } else {
          activeEscapes.push(esc);
        }
        parts.push(esc);
        i += esc.length;
        continue;
      }
    }

    const end = nextGraphemeEnd(line, i);
    const cluster = line.slice(i, end);
    if (visIdx <= col && col < visIdx + cluster.length) {
      // Cursor: override fg/bg for the whole grapheme, then restore text styles after.
      parts.push(`${CURSOR_FG}${theme.cursorBg}${cluster}${theme.reset}${activeEscapes.join("")}`);
      cursorRendered = true;
    } else {
      parts.push(cluster);
    }
    visIdx += cluster.length;
    i = end;
  }

  if (!cursorRendered) {
    parts.push(`${CURSOR_FG}${theme.cursorBg} ${theme.reset}`);
  }

  return parts.join("");
}

/**
 * Highlight a range of visible columns with the selection background.
 * Preserves existing text styles. If startCol/endCol are -1, the
 * entire line is highlighted (visual-line mode).
 *
 * @param startCol - First visible column to highlight (inclusive). -1 = entire line.
 * @param endCol   - Last visible column to highlight (inclusive). -1 = entire line.
 */
export function renderLineWithSelection(
  line: string,
  startCol: number,
  endCol: number,
): string {
  const plain = stripAnsi(line);
  // Empty or all-whitespace line in selection: show a highlighted space
  // at the end (like neovim's virtual \n). Covers truly empty lines and
  // indented blank lines where startCol >= plain.length.
  if (plain.length === 0 || startCol >= plain.length) {
    return `${line}${theme.selectionBg} ${theme.reset}`;
  }

  const fullLine = startCol === -1;

  const parts: string[] = [];
  let visIdx = 0;
  let i = 0;
  let activeEscapes: string[] = [];
  let inSelection = fullLine;

  if (fullLine) parts.push(theme.selectionBg);

  while (i < line.length) {
    if (line[i] === "\x1b") {
      const match = line.slice(i).match(ANSI_OR_HYPERLINK);
      if (match) {
        const esc = match[0];
        if (esc === theme.reset || esc === "\x1b[0m") {
          activeEscapes = [];
          // Re-apply selection bg after reset
          parts.push(esc);
          if (inSelection) parts.push(theme.selectionBg);
        } else {
          activeEscapes.push(esc);
          parts.push(esc);
        }
        i += esc.length;
        continue;
      }
    }

    const end = nextGraphemeEnd(line, i);
    const cluster = line.slice(i, end);
    const clusterSelected = fullLine || (visIdx + cluster.length > startCol && visIdx <= endCol);

    if (!fullLine && clusterSelected && !inSelection) {
      inSelection = true;
      parts.push(theme.selectionBg);
    } else if (!fullLine && !clusterSelected && inSelection) {
      inSelection = false;
      parts.push(`${theme.reset}${activeEscapes.join("")}`);
    }

    parts.push(cluster);

    if (!fullLine && clusterSelected && visIdx + cluster.length > endCol) {
      inSelection = false;
      parts.push(`${theme.reset}${activeEscapes.join("")}`);
    }

    visIdx += cluster.length;
    i = end;
  }

  // Close selection if it extends to end of line
  if (inSelection) parts.push(theme.reset);

  return parts.join("");
}

/**
 * Highlight one or more visible-column search ranges.
 * Search highlight overrides both background and foreground colors, then
 * restores the original ANSI styling once the match ends.
 */
export function renderLineWithSearch(
  line: string,
  ranges: { from: number; to: number }[],
): string {
  if (!line || ranges.length === 0) return line;

  const parts: string[] = [];
  let visIdx = 0;
  let i = 0;
  let inSearch = false;
  let allCodesSoFar = "";

  while (i < line.length) {
    if (line[i] === "\x1b") {
      const match = line.slice(i).match(ANSI_OR_HYPERLINK);
      if (match) {
        const esc = match[0];
        allCodesSoFar += esc;
        if (!inSearch) parts.push(esc);
        i += esc.length;
        continue;
      }
    }

    const end = nextGraphemeEnd(line, i);
    const cluster = line.slice(i, end);
    const nowInSearch = ranges.some((range) => visIdx < range.to && visIdx + cluster.length > range.from);
    if (nowInSearch && !inSearch) {
      parts.push(theme.searchBg, theme.searchFg);
      inSearch = true;
    } else if (!nowInSearch && inSearch) {
      parts.push(`${theme.reset}${allCodesSoFar}`);
      inSearch = false;
    }

    parts.push(cluster);
    visIdx += cluster.length;
    i = end;
  }

  if (inSearch) parts.push(theme.reset);
  return parts.join("");
}
