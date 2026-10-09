/**
 * Prompt line input handling.
 *
 * Owns all input buffer manipulation: character insertion, deletion,
 * cursor movement, multiline navigation. The only file that mutates
 * state.inputBuffer and state.cursorPos.
 */

import type { KeyEvent } from "./input";
import type { RenderState } from "./state";
import { resolveAction } from "./keybinds";
import { updateAutocomplete, cycleAutocomplete, tryPathComplete, type PathCompletionProvider } from "./autocomplete";
import { getSymbol } from "./symbols";
import { graphemeBoundaryAtOrAfter, nextGraphemeEnd, previousGraphemeStart } from "./graphemes";
import { sliceByWidthFrom, termWidth } from "./textwidth";
import { sanitizePromptTextForInsertion } from "./prompttext";
import { PROMPT_TAB, promptDeleteStart, promptDeleteEnd } from "./prompttabs";
import { SIDEBAR_WIDTH } from "./sidebar/layout";

export type PromptKeyResult =
  | { type: "handled" }
  | { type: "submit" }
  | { type: "unhandled" };

const SUBMIT: PromptKeyResult = { type: "submit" };
const HANDLED: PromptKeyResult = { type: "handled" };
const UNHANDLED: PromptKeyResult = { type: "unhandled" };

function resetPromptCurswant(state: RenderState): void {
  state.promptCurswant = null;
}

/** Visible width of the vim mode + prompt prefix (e.g. "N > "). */
export const PROMPT_PREFIX_WIDTH = 4;

/** Prompt wrap width for the current terminal and sidebar layout. */
export function promptInputWidth(state: RenderState): number {
  const sidebarW = state.sidebar.open ? SIDEBAR_WIDTH : 0;
  return Math.max(1, state.cols - sidebarW) - PROMPT_PREFIX_WIDTH;
}

function offsetForPromptVCol(line: string, desiredCol: number): number {
  let offset = 0;
  let col = 0;

  while (offset < line.length) {
    const end = nextGraphemeEnd(line, offset);
    const cluster = line.slice(offset, end);
    const width = termWidth(cluster);
    if (col + width > desiredCol) return offset;
    if (col + width === desiredCol) return end;
    col += width;
    offset = end;
  }

  return line.length;
}

/**
 * Apply one or more vertical prompt moves, preserving/setting `state.promptCurswant`.
 *
 * Moves by display rows (Vim `gj`/`gk`), so a wrapped line's continuation
 * rows are reachable with j/k and the viewport scrolls one row at a time.
 * The preferred column is a display column within the row; Infinity sticks
 * to the end of each row (after `$`/End).
 */
export function movePromptCursorVerticalWithCurswant(
  state: RenderState,
  direction: -1 | 1,
  count: number = 1,
  normalMode: boolean = false,
): boolean {
  const buffer = state.inputBuffer;
  const maxWidth = Math.max(1, promptInputWidth(state));
  const rows = promptDisplayRows(buffer, maxWidth);
  const cell = promptCursorCell(buffer, rows, state.cursorPos);
  // An insert cursor just past a full-width line is drawn at column 0 of its
  // own row below it, so moving up first lands on the line's own last row.
  const onPhantomRow = cell.col >= maxWidth;
  const desiredCol = state.promptCurswant ?? (onPhantomRow ? 0 : cell.col);
  const upFromPhantomRow = onPhantomRow && direction < 0;
  const steps = Math.max(1, count) - (upFromPhantomRow ? 1 : 0);
  const target = Math.max(0, Math.min(rows.length - 1, cell.row + direction * steps));

  state.promptCurswant = desiredCol;
  if (target === cell.row && !upFromPhantomRow) return false;

  const row = rows[target];
  let pos = row.start + offsetForPromptVCol(buffer.slice(row.start, row.end), desiredCol);
  // A wrapped row's end offset is drawn at the start of its continuation row,
  // and normal mode never rests past a line's last character.
  const continues = target + 1 < rows.length && rows[target + 1].start === row.end;
  if (pos >= row.end && row.end > row.start && (continues || normalMode)) {
    pos = previousGraphemeStart(buffer, row.end);
  }
  state.cursorPos = pos;
  return true;
}

/** Handle a key event in the prompt. Returns a typed result object. */
export function handlePromptKey(
  state: RenderState,
  key: KeyEvent,
  pathCompletionProvider?: PathCompletionProvider,
): PromptKeyResult {
  const action = resolveAction(key);

  // Tab → cycle autocomplete, complete a path, or insert a four-space soft tab.
  if (key.type === "tab") {
    if (state.autocomplete) {
      cycleAutocomplete(state, 1);
    } else if (!tryPathComplete(state, pathCompletionProvider) && state.vim.mode === "insert") {
      const pos = graphemeBoundaryAtOrAfter(state.inputBuffer, state.cursorPos);
      state.inputBuffer =
        state.inputBuffer.slice(0, pos) + PROMPT_TAB + state.inputBuffer.slice(pos);
      state.cursorPos = pos + PROMPT_TAB.length;
      updateAutocomplete(state);
    }
    resetPromptCurswant(state);
    return HANDLED;
  }

  // Shift+Tab → cycle autocomplete backward
  if (key.type === "backtab") {
    if (state.autocomplete) {
      cycleAutocomplete(state, -1);
    }
    resetPromptCurswant(state);
    return HANDLED;
  }

  // Up/Down choose from the visible autocomplete popup when it is open.
  if (state.autocomplete && (key.type === "up" || key.type === "down")) {
    cycleAutocomplete(state, key.type === "down" ? 1 : -1);
    resetPromptCurswant(state);
    return HANDLED;
  }

  // Symbol keys (Ctrl+number row → F14-F24 from st)
  const sym = getSymbol(key);
  if (sym) {
    const pos = graphemeBoundaryAtOrAfter(state.inputBuffer, state.cursorPos);
    state.inputBuffer =
      state.inputBuffer.slice(0, pos) +
      sym +
      state.inputBuffer.slice(pos);
    state.cursorPos = pos + sym.length;
    resetPromptCurswant(state);
    updateAutocomplete(state);
    return HANDLED;
  }

  // Char input — in insert mode every char is typed.
  // Non-prompt actions (e.g. sidebar_next bound to Shift+J/K) are already
  // handled by focus.ts before we get here; the vim engine passthroughs all
  // chars in insert mode, so we don't gate on resolveAction.
  if (key.type === "char") {
    if (!key.char) return HANDLED;
    const text = sanitizePromptTextForInsertion(key.char);
    if (!text) return HANDLED;
    const pos = graphemeBoundaryAtOrAfter(state.inputBuffer, state.cursorPos);
    state.inputBuffer =
      state.inputBuffer.slice(0, pos) +
      text +
      state.inputBuffer.slice(pos);
    state.cursorPos = pos + text.length;
    resetPromptCurswant(state);
    updateAutocomplete(state);
    return HANDLED;
  }

  switch (action) {
    case "submit":
      state.autocomplete = null;
      return SUBMIT;

    case "newline": {
      const pos = graphemeBoundaryAtOrAfter(state.inputBuffer, state.cursorPos);
      state.inputBuffer =
        state.inputBuffer.slice(0, pos) +
        "\n" +
        state.inputBuffer.slice(pos);
      state.cursorPos = pos + 1;
      resetPromptCurswant(state);
      state.autocomplete = null;
      return HANDLED;
    }

    case "delete_back": {
      const pos = graphemeBoundaryAtOrAfter(state.inputBuffer, state.cursorPos);
      if (pos > 0) {
        const start = promptDeleteStart(state.inputBuffer, pos);
        state.inputBuffer =
          state.inputBuffer.slice(0, start) +
          state.inputBuffer.slice(pos);
        state.cursorPos = start;
      } else if (state.pendingImages.length > 0) {
        // Backspace at position 0 pops the last pending image
        state.pendingImages.pop();
      }
      resetPromptCurswant(state);
      updateAutocomplete(state);
      return HANDLED;
    }

    case "delete_forward": {
      const pos = graphemeBoundaryAtOrAfter(state.inputBuffer, state.cursorPos);
      if (pos < state.inputBuffer.length) {
        const end = promptDeleteEnd(state.inputBuffer, pos);
        state.inputBuffer =
          state.inputBuffer.slice(0, pos) +
          state.inputBuffer.slice(end);
        state.cursorPos = pos;
      }
      resetPromptCurswant(state);
      updateAutocomplete(state);
      return HANDLED;
    }

    case "cursor_left":
      state.cursorPos = previousGraphemeStart(state.inputBuffer, state.cursorPos);
      resetPromptCurswant(state);
      return HANDLED;

    case "cursor_right":
      state.cursorPos = nextGraphemeEnd(state.inputBuffer, state.cursorPos);
      resetPromptCurswant(state);
      return HANDLED;

    case "cursor_home": {
      const lineStart = state.inputBuffer.lastIndexOf("\n", state.cursorPos - 1) + 1;
      state.cursorPos = lineStart;
      resetPromptCurswant(state);
      return HANDLED;
    }

    case "cursor_end": {
      const nextNl = state.inputBuffer.indexOf("\n", state.cursorPos);
      state.cursorPos = nextNl === -1 ? state.inputBuffer.length : nextNl;
      // Like Vim's <End>/$: later vertical moves stick to the end of each row.
      state.promptCurswant = Infinity;
      return HANDLED;
    }

    case "cursor_up":
      return movePromptCursorVerticalWithCurswant(state, -1) ? HANDLED : UNHANDLED;

    case "cursor_down":
      return movePromptCursorVerticalWithCurswant(state, 1) ? HANDLED : UNHANDLED;

    default:
      return UNHANDLED;
  }
}

export { clearPrompt } from "./promptstate";

// ── Display rows (vim-style hard wrap) ──────────────────────────────

/** One hard-wrapped prompt row: buffer offsets [start, end), excluding "\n". */
export interface PromptRow {
  start: number;
  end: number;
}

/**
 * Hard-wrap the buffer into terminal-width display rows (vim-style, no word
 * boundaries) without splitting grapheme clusters. Every logical line,
 * including an empty one, yields at least one row.
 */
export function promptDisplayRows(buffer: string, maxWidth: number): PromptRow[] {
  // Guard against zero/negative width — would cause infinite loop in hard-wrap
  if (maxWidth < 1) maxWidth = 1;
  const rows: PromptRow[] = [];
  let lineStart = 0;

  for (const line of buffer.split("\n")) {
    let rel = 0;
    do {
      const [chunkEnd] = sliceByWidthFrom(line, rel, maxWidth);
      const end = chunkEnd > rel || line.length === 0 ? chunkEnd : nextGraphemeEnd(line, rel);
      rows.push({ start: lineStart + rel, end: lineStart + end });
      rel = end;
    } while (rel < line.length);
    lineStart += line.length + 1; // +1 for the \n
  }

  return rows;
}

/**
 * Row and display column of a buffer offset. A wrapped row's end offset is
 * also its continuation row's start; the continuation row wins. An insert
 * cursor just past a full-width line reports a column of `maxWidth`.
 */
function promptCursorCell(buffer: string, rows: PromptRow[], pos: number): { row: number; col: number } {
  let row = 0;
  for (let i = 0; i < rows.length && rows[i].start <= pos; i++) {
    if (pos <= rows[i].end) row = i;
  }
  return { row, col: termWidth(buffer.slice(rows[row].start, Math.max(rows[row].start, pos))) };
}

// ── Input line wrapping + scroll ────────────────────────────────────

export interface InputLinesResult {
  /** Visible lines after wrapping + scroll. */
  lines: string[];
  /** Buffer offset where each visible line starts. */
  lineStarts: number[];
  /** true if this wrapped line starts a new buffer line (after a \n). */
  isNewLine: boolean[];
  /** Cursor row within the visible lines. */
  cursorLine: number;
  /** Cursor column within its visible line. */
  cursorCol: number;
  /** Updated scroll offset (persist this for the next call). */
  scrollOffset: number;
}

/**
 * Split the input buffer into display lines with hard-wrapping.
 * Long lines are broken at maxWidth (vim-style, no word boundaries).
 * Returns the visible slice (scrolled to keep cursor in view)
 * plus cursor position within that slice.
 *
 * Scrolling is vim-style: the viewport only moves when the cursor
 * would leave the visible area (top or bottom), not on every movement.
 * Pass the previous scrollOffset to preserve the viewport position.
 */
export function getInputLines(
  buffer: string,
  cursorPos: number,
  maxWidth: number,
  maxRows: number,
  prevScrollOffset: number = 0,
): InputLinesResult {
  if (maxWidth < 1) maxWidth = 1;
  const rows = promptDisplayRows(buffer, maxWidth);
  const wrapped = rows.map(row => buffer.slice(row.start, row.end));
  const lineStarts = rows.map(row => row.start);
  const isNewLineArr = rows.map(row => row.start > 0 && buffer[row.start - 1] === "\n");
  let { row: cursorWrappedLine, col: cursorColInLine } = promptCursorCell(buffer, rows, cursorPos);

  // Cursor at the right edge of a full-width line → its own empty
  // continuation row, so it never overlaps the next line's first character.
  if (cursorColInLine >= maxWidth) {
    cursorWrappedLine++;
    cursorColInLine = 0;
    wrapped.splice(cursorWrappedLine, 0, "");
    lineStarts.splice(cursorWrappedLine, 0, cursorPos);
    isNewLineArr.splice(cursorWrappedLine, 0, false);
  }

  // Scroll to keep cursor visible
  if (wrapped.length <= maxRows) {
    return {
      lines: wrapped,
      lineStarts,
      isNewLine: isNewLineArr,
      cursorLine: cursorWrappedLine,
      cursorCol: cursorColInLine,
      scrollOffset: 0,
    };
  }

  // Vim-style scroll: keep previous offset, only adjust when cursor
  // would leave the visible area.
  let scrollStart = prevScrollOffset;

  // Clamp to valid range first
  const maxScroll = wrapped.length - maxRows;
  scrollStart = Math.max(0, Math.min(scrollStart, maxScroll));

  // Cursor above viewport → scroll up so cursor is at the top
  if (cursorWrappedLine < scrollStart) {
    scrollStart = cursorWrappedLine;
  }
  // Cursor below viewport → scroll down so cursor is at the bottom
  else if (cursorWrappedLine >= scrollStart + maxRows) {
    scrollStart = cursorWrappedLine - maxRows + 1;
  }

  return {
    lines: wrapped.slice(scrollStart, scrollStart + maxRows),
    lineStarts: lineStarts.slice(scrollStart, scrollStart + maxRows),
    isNewLine: isNewLineArr.slice(scrollStart, scrollStart + maxRows),
    cursorLine: cursorWrappedLine - scrollStart,
    cursorCol: cursorColInLine,
    scrollOffset: scrollStart,
  };
}
