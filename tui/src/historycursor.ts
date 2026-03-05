/**
 * Chat history cursor — read-only navigation in rendered content.
 *
 * Owns the cursor position (row, col) within the rendered message
 * lines. Supports vim motions (h/j/k/l, w/W/b/B/e/E, 0/$, gg/G).
 *
 * The cursor operates on ANSI-stripped "plain" text. The renderer
 * uses (row, col) to place a reverse-video block cursor on the
 * corresponding screen position.
 */

// ── State ──────────────────────────────────────────────────────────

export interface HistoryCursor {
  row: number;
  col: number;
}

export function createHistoryCursor(): HistoryCursor {
  return { row: 0, col: 0 };
}

// ── ANSI stripping ─────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\]8;[^;]*;[^\x1b]*\x1b\\/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

// ── Character classification ───────────────────────────────────────

function isWordChar(ch: string): boolean { return /\w/.test(ch); }
function isSpace(ch: string): boolean { return ch === " " || ch === "\t"; }

// ── Motions ────────────────────────────────────────────────────────

/** Move cursor left within the current line. */
export function charLeft(cursor: HistoryCursor): HistoryCursor {
  return { row: cursor.row, col: Math.max(0, cursor.col - 1) };
}

/** Move cursor right within the current line. */
export function charRight(cursor: HistoryCursor, lineLen: number): HistoryCursor {
  const max = Math.max(0, lineLen - 1);
  return { row: cursor.row, col: Math.min(max, cursor.col + 1) };
}

/** Move cursor up one line. */
export function lineUp(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  if (cursor.row <= 0) return cursor;
  const newRow = cursor.row - 1;
  const maxCol = Math.max(0, stripAnsi(lines[newRow]).length - 1);
  return { row: newRow, col: Math.min(cursor.col, maxCol) };
}

/** Move cursor down one line. */
export function lineDown(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  if (cursor.row >= lines.length - 1) return cursor;
  const newRow = cursor.row + 1;
  const maxCol = Math.max(0, stripAnsi(lines[newRow]).length - 1);
  return { row: newRow, col: Math.min(cursor.col, maxCol) };
}

/** Move to start of line. */
export function lineStart(cursor: HistoryCursor): HistoryCursor {
  return { row: cursor.row, col: 0 };
}

/** Move to end of line. */
export function lineEnd(cursor: HistoryCursor, lineLen: number): HistoryCursor {
  return { row: cursor.row, col: Math.max(0, lineLen - 1) };
}

/** Move to first line, column 0. */
export function bufferStart(): HistoryCursor {
  return { row: 0, col: 0 };
}

/** Move to last line, column 0. */
export function bufferEnd(lines: string[]): HistoryCursor {
  return { row: Math.max(0, lines.length - 1), col: 0 };
}

/** word forward (w) — next word start on plain text of current line, wraps down. */
export function wordForward(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  let pos = cursor.col;

  if (pos < plain.length) {
    // Skip current word
    if (isWordChar(plain[pos])) {
      while (pos < plain.length && isWordChar(plain[pos])) pos++;
    } else if (!isSpace(plain[pos])) {
      while (pos < plain.length && !isWordChar(plain[pos]) && !isSpace(plain[pos])) pos++;
    }
    // Skip spaces
    while (pos < plain.length && isSpace(plain[pos])) pos++;
  }

  if (pos >= plain.length) {
    // Wrap to next non-empty line
    for (let r = cursor.row + 1; r < lines.length; r++) {
      const next = stripAnsi(lines[r]);
      if (next.length > 0) {
        let c = 0;
        while (c < next.length && isSpace(next[c])) c++;
        return { row: r, col: Math.min(c, Math.max(0, next.length - 1)) };
      }
    }
    return { row: cursor.row, col: Math.max(0, plain.length - 1) };
  }

  return { row: cursor.row, col: pos };
}

/** word backward (b) */
export function wordBackward(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  let pos = cursor.col;

  if (pos > 0) {
    pos--;
    // Skip spaces
    while (pos > 0 && isSpace(plain[pos])) pos--;
    // Skip word
    if (isWordChar(plain[pos])) {
      while (pos > 0 && isWordChar(plain[pos - 1])) pos--;
    } else if (!isSpace(plain[pos])) {
      while (pos > 0 && !isWordChar(plain[pos - 1]) && !isSpace(plain[pos - 1])) pos--;
    }
    return { row: cursor.row, col: pos };
  }

  // Wrap to previous non-empty line
  for (let r = cursor.row - 1; r >= 0; r--) {
    const prev = stripAnsi(lines[r]);
    if (prev.length > 0) {
      return { row: r, col: Math.max(0, prev.length - 1) };
    }
  }
  return cursor;
}

/** word end (e) */
export function wordEnd(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  let pos = cursor.col;

  if (pos < plain.length - 1) {
    pos++;
    // Skip spaces
    while (pos < plain.length && isSpace(plain[pos])) pos++;
    // Run through word
    if (pos < plain.length) {
      if (isWordChar(plain[pos])) {
        while (pos < plain.length - 1 && isWordChar(plain[pos + 1])) pos++;
      } else {
        while (pos < plain.length - 1 && !isWordChar(plain[pos + 1]) && !isSpace(plain[pos + 1])) pos++;
      }
      return { row: cursor.row, col: pos };
    }
  }

  // Wrap to next non-empty line
  for (let r = cursor.row + 1; r < lines.length; r++) {
    const next = stripAnsi(lines[r]);
    if (next.length > 0) {
      let c = 0;
      while (c < next.length && isSpace(next[c])) c++;
      if (isWordChar(next[c])) {
        while (c < next.length - 1 && isWordChar(next[c + 1])) c++;
      } else {
        while (c < next.length - 1 && !isWordChar(next[c + 1]) && !isSpace(next[c + 1])) c++;
      }
      return { row: r, col: c };
    }
  }
  return { row: cursor.row, col: Math.max(0, plain.length - 1) };
}

/** WORD forward (W) — whitespace-delimited */
export function wordForwardBig(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  let pos = cursor.col;

  // Skip non-space
  while (pos < plain.length && !isSpace(plain[pos])) pos++;
  // Skip space
  while (pos < plain.length && isSpace(plain[pos])) pos++;

  if (pos >= plain.length) {
    for (let r = cursor.row + 1; r < lines.length; r++) {
      const next = stripAnsi(lines[r]);
      if (next.length > 0) {
        let c = 0;
        while (c < next.length && isSpace(next[c])) c++;
        return { row: r, col: Math.min(c, Math.max(0, next.length - 1)) };
      }
    }
    return { row: cursor.row, col: Math.max(0, plain.length - 1) };
  }
  return { row: cursor.row, col: pos };
}

/** WORD backward (B) */
export function wordBackwardBig(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  let pos = cursor.col;

  if (pos > 0) {
    pos--;
    while (pos > 0 && isSpace(plain[pos])) pos--;
    while (pos > 0 && !isSpace(plain[pos - 1])) pos--;
    return { row: cursor.row, col: pos };
  }

  for (let r = cursor.row - 1; r >= 0; r--) {
    const prev = stripAnsi(lines[r]);
    if (prev.length > 0) {
      return { row: r, col: Math.max(0, prev.length - 1) };
    }
  }
  return cursor;
}

/** WORD end (E) */
export function wordEndBig(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  const plain = stripAnsi(lines[cursor.row]);
  let pos = cursor.col;

  if (pos < plain.length - 1) {
    pos++;
    while (pos < plain.length && isSpace(plain[pos])) pos++;
    while (pos < plain.length - 1 && !isSpace(plain[pos + 1])) pos++;
    if (pos < plain.length) return { row: cursor.row, col: pos };
  }

  for (let r = cursor.row + 1; r < lines.length; r++) {
    const next = stripAnsi(lines[r]);
    if (next.length > 0) {
      let c = 0;
      while (c < next.length && isSpace(next[c])) c++;
      while (c < next.length - 1 && !isSpace(next[c + 1])) c++;
      return { row: r, col: c };
    }
  }
  return { row: cursor.row, col: Math.max(0, plain.length - 1) };
}

// ── Placement ──────────────────────────────────────────────────────

/**
 * Place cursor at the bottom of the visible content.
 * Called when entering history focus.
 */
export function placeAtBottom(lines: string[]): HistoryCursor {
  const row = Math.max(0, lines.length - 1);
  return { row, col: 0 };
}

/** Clamp cursor to valid bounds after content changes. */
export function clampCursor(cursor: HistoryCursor, lines: string[]): HistoryCursor {
  if (lines.length === 0) return { row: 0, col: 0 };
  const row = Math.min(cursor.row, lines.length - 1);
  const maxCol = Math.max(0, stripAnsi(lines[row]).length - 1);
  return { row, col: Math.min(cursor.col, maxCol) };
}

// ── Dispatch ───────────────────────────────────────────────────────

import type { Action } from "./keybinds";
import type { RenderState } from "./state";

/**
 * Apply a history cursor action to state.
 * Returns true if the action was handled.
 */
export function applyHistoryAction(action: Action, state: RenderState): boolean {
  const lines = state.historyLines;
  const cur = state.historyCursor;

  if (lines.length === 0) return true;

  const lineLen = stripAnsi(lines[cur.row] ?? "").length;

  switch (action) {
    case "history_left":    state.historyCursor = charLeft(cur); break;
    case "history_right":   state.historyCursor = charRight(cur, lineLen); break;
    case "history_up":      state.historyCursor = lineUp(cur, lines); break;
    case "history_down":    state.historyCursor = lineDown(cur, lines); break;
    case "history_w":       state.historyCursor = wordForward(cur, lines); break;
    case "history_b":       state.historyCursor = wordBackward(cur, lines); break;
    case "history_e":       state.historyCursor = wordEnd(cur, lines); break;
    case "history_W":       state.historyCursor = wordForwardBig(cur, lines); break;
    case "history_B":       state.historyCursor = wordBackwardBig(cur, lines); break;
    case "history_E":       state.historyCursor = wordEndBig(cur, lines); break;
    case "history_0":       state.historyCursor = lineStart(cur); break;
    case "history_dollar":  state.historyCursor = lineEnd(cur, lineLen); break;
    case "history_gg":      state.historyCursor = bufferStart(); break;
    case "history_G":       state.historyCursor = bufferEnd(lines); break;
    case "history_yy":      return true; // caller handles clipboard
    default:                return false;
  }

  ensureCursorVisible(state);
  return true;
}

/** Adjust scrollOffset so the cursor row is within the visible message area. */
export function ensureCursorVisible(state: RenderState): void {
  const { totalLines, messageAreaHeight } = state.layout;
  if (totalLines <= messageAreaHeight) {
    state.scrollOffset = 0;
    return;
  }

  const cursorRow = state.historyCursor.row;
  const viewStart = totalLines - messageAreaHeight - state.scrollOffset;
  const viewEnd = viewStart + messageAreaHeight;

  if (cursorRow < viewStart) {
    state.scrollOffset = totalLines - messageAreaHeight - cursorRow;
  } else if (cursorRow >= viewEnd) {
    state.scrollOffset = totalLines - messageAreaHeight - (cursorRow - messageAreaHeight + 1);
  }

  const maxScroll = Math.max(0, totalLines - messageAreaHeight);
  state.scrollOffset = Math.max(0, Math.min(state.scrollOffset, maxScroll));
}

// ── Rendering ──────────────────────────────────────────────────────

import { theme } from "./theme";

const CURSOR_FG = "\x1b[38;2;0;0;0m";  // black text on cursor

/**
 * Render a line with a themed block cursor at the given visible
 * column position. Walks the ANSI string, counting only visible
 * characters to find the right spot.
 *
 * After the cursor character, re-emits the active ANSI state so
 * that styled text (bold, colors) continues correctly.
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
      // Cursor: override fg/bg, then restore previous style after
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
