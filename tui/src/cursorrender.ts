/**
 * ANSI cursor & selection overlay rendering.
 *
 * Paints a block cursor or selection highlight onto ANSI-styled
 * strings. Preserves surrounding text styles (bold, fg color, etc)
 * through resets.
 *
 * Two functions:
 * - renderLineWithCursor: single character block cursor
 * - renderLineWithSelection: highlight a column range
 */

import { theme } from "./theme";
import { stripAnsi } from "./historycursor";

const CURSOR_FG = "\x1b[38;2;0;0;0m";  // black text on cursor

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
      const match = line.slice(i).match(/^\x1b(?:\[[0-9;]*[A-Za-z]|\]8;[^;]*;[^\x1b]*\x1b\\)/);
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

    if (visIdx === col) {
      // Cursor: override fg/bg, then restore text styles after
      parts.push(`${CURSOR_FG}${theme.cursorBg}${line[i]}${theme.reset}${activeEscapes.join("")}`);
      cursorRendered = true;
    } else {
      parts.push(line[i]);
    }
    visIdx++;
    i++;
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
      const match = line.slice(i).match(/^\x1b(?:\[[0-9;]*[A-Za-z]|\]8;[^;]*;[^\x1b]*\x1b\\)/);
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

    if (!fullLine && visIdx === startCol) {
      inSelection = true;
      parts.push(theme.selectionBg);
    }

    parts.push(line[i]);

    if (!fullLine && visIdx === endCol) {
      inSelection = false;
      parts.push(`${theme.reset}${activeEscapes.join("")}`);
    }

    visIdx++;
    i++;
  }

  // Close selection if it extends to end of line
  if (inSelection) parts.push(theme.reset);

  return parts.join("");
}
