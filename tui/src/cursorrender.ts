/**
 * ANSI cursor overlay rendering.
 *
 * Paints a block cursor onto an ANSI-styled string at a given
 * visible column. Preserves surrounding text styles (bold, fg
 * color, etc) through the cursor reset.
 *
 * Separated from historycursor.ts (navigation) because this is
 * pure ANSI string surgery — no knowledge of motions, scrolling,
 * or state. Will grow with visual mode (range highlighting).
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
