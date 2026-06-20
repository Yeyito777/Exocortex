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
import { updateAutocomplete, cycleAutocomplete, tryPathComplete } from "./autocomplete";
import { getSymbol } from "./symbols";
import { graphemeBoundaryAtOrAfter, nextGraphemeEnd, previousGraphemeStart } from "./graphemes";
import { sliceByWidthFrom, termWidth } from "./textwidth";
import { sanitizePromptTextForInsertion } from "./prompttext";

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

function lineStartOf(buffer: string, pos: number): number {
  return buffer.lastIndexOf("\n", pos - 1) + 1;
}

function lineEndOf(buffer: string, pos: number): number {
  const nextNl = buffer.indexOf("\n", pos);
  return nextNl === -1 ? buffer.length : nextNl;
}

function promptCursorVCol(buffer: string, pos: number): number {
  const lineStart = lineStartOf(buffer, pos);
  return termWidth(buffer.slice(lineStart, pos));
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

/** Move prompt cursor vertically using Vim's curswant/preferred-column behavior. */
export function movePromptCursorVertical(
  buffer: string,
  cursorPos: number,
  direction: -1 | 1,
  desiredCol: number,
): number | null {
  const currentLineStart = lineStartOf(buffer, cursorPos);
  let targetLineStart: number;
  let targetLineEnd: number;

  if (direction < 0) {
    if (currentLineStart === 0) return null;
    targetLineEnd = currentLineStart - 1;
    targetLineStart = lineStartOf(buffer, targetLineEnd);
  } else {
    const currentLineEnd = lineEndOf(buffer, cursorPos);
    if (currentLineEnd >= buffer.length) return null;
    targetLineStart = currentLineEnd + 1;
    targetLineEnd = lineEndOf(buffer, targetLineStart);
  }

  const targetLine = buffer.slice(targetLineStart, targetLineEnd);
  return graphemeBoundaryAtOrAfter(buffer, targetLineStart + offsetForPromptVCol(targetLine, desiredCol));
}

/** Apply one or more vertical prompt moves, preserving/setting `state.promptCurswant`. */
export function movePromptCursorVerticalWithCurswant(
  state: RenderState,
  direction: -1 | 1,
  count: number = 1,
  normalMode: boolean = false,
): boolean {
  const desiredCol = state.promptCurswant ?? promptCursorVCol(state.inputBuffer, state.cursorPos);
  let pos = state.cursorPos;
  let moved = false;

  for (let i = 0; i < Math.max(1, count); i++) {
    const next = movePromptCursorVertical(state.inputBuffer, pos, direction, desiredCol);
    if (next === null) break;
    pos = next;
    moved = true;
  }

  state.promptCurswant = desiredCol;
  if (moved) {
    if (normalMode) {
      const lineStart = lineStartOf(state.inputBuffer, pos);
      const lineEnd = lineEndOf(state.inputBuffer, pos);
      state.cursorPos = lineEnd > lineStart && pos >= lineEnd
        ? previousGraphemeStart(state.inputBuffer, lineEnd)
        : pos;
    } else {
      state.cursorPos = pos;
    }
  }
  return moved;
}

/** Handle a key event in the prompt. Returns a typed result object. */
export function handlePromptKey(state: RenderState, key: KeyEvent): PromptKeyResult {
  const action = resolveAction(key);

  // Tab → cycle autocomplete forward, or try path completion
  if (key.type === "tab") {
    if (state.autocomplete) {
      cycleAutocomplete(state, 1);
    } else {
      tryPathComplete(state);
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
        const start = previousGraphemeStart(state.inputBuffer, pos);
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
        const end = nextGraphemeEnd(state.inputBuffer, pos);
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
      resetPromptCurswant(state);
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

// ── Wrapped-line offset mapping ──────────────────────────────────────

/**
 * Compute the buffer offset for each wrapped line.
 *
 * Given the raw input buffer and the hard-wrap width, returns an array
 * where `offsets[i]` is the character index in `buffer` where wrapped
 * line `i` begins. Used by prompt highlighting and visual selection
 * to map between buffer positions and visible wrapped lines.
 */
export function wrappedLineOffsets(buffer: string, maxWidth: number): number[] {
  if (maxWidth < 1) maxWidth = 1;
  const offsets: number[] = [];
  const lines = buffer.split("\n");
  let pos = 0;

  for (const line of lines) {
    const [firstChunkEnd] = line.length === 0 ? [0] : sliceByWidthFrom(line, 0, maxWidth);
    if (line.length === 0 || firstChunkEnd >= line.length) {
      offsets.push(pos);
    } else {
      let rel = 0;
      while (rel < line.length) {
        offsets.push(pos + rel);
        const [chunkEnd] = rel === 0 ? [firstChunkEnd] : sliceByWidthFrom(line, rel, maxWidth);
        rel = chunkEnd > rel ? chunkEnd : nextGraphemeEnd(line, rel);
      }
    }
    pos += line.length + 1; // +1 for \n
  }

  return offsets;
}

// ── Input line wrapping (vim-style hard wrap) ───────────────────────

export interface InputLinesResult {
  /** Visible lines after wrapping + scroll. */
  lines: string[];
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
  // Guard against zero/negative width — would cause infinite loop in hard-wrap
  if (maxWidth < 1) maxWidth = 1;
  const bufferLines = buffer.split("\n");
  const wrapped: string[] = [];
  const isNewLineArr: boolean[] = [];

  // Track which wrapped line the cursor falls on
  let cursorWrappedLine = 0;
  let cursorColInLine = 0;
  let bufOffset = 0;

  for (let li = 0; li < bufferLines.length; li++) {
    const line = bufferLines[li];
    const [firstChunkEnd] = line.length === 0 ? [0] : sliceByWidthFrom(line, 0, maxWidth);

    if (line.length === 0 || firstChunkEnd >= line.length) {
      // Cursor within this line?
      if (cursorPos >= bufOffset && cursorPos <= bufOffset + line.length) {
        cursorWrappedLine = wrapped.length;
        cursorColInLine = termWidth(line.slice(0, cursorPos - bufOffset));
      }
      wrapped.push(line);
      isNewLineArr.push(li > 0);
    } else {
      // Hard-wrap into terminal-width chunks without splitting grapheme clusters.
      let rel = 0;
      while (rel < line.length) {
        const [chunkEndIndex] = rel === 0 ? [firstChunkEnd] : sliceByWidthFrom(line, rel, maxWidth);
        const chunkEndRel = chunkEndIndex > rel ? chunkEndIndex : nextGraphemeEnd(line, rel);
        const chunk = line.slice(rel, chunkEndRel);
        // Cursor within this chunk?
        const chunkStart = bufOffset + rel;
        const chunkEnd = bufOffset + chunkEndRel;
        if (cursorPos >= chunkStart && cursorPos <= chunkEnd) {
          cursorWrappedLine = wrapped.length;
          cursorColInLine = termWidth(line.slice(rel, cursorPos - bufOffset));
        }
        wrapped.push(chunk);
        isNewLineArr.push(li > 0 && rel === 0);
        rel = chunkEndRel;
      }
    }

    bufOffset += line.length + 1; // +1 for the \n
  }

  // Ensure at least one line
  if (wrapped.length === 0) {
    wrapped.push("");
    isNewLineArr.push(false);
  }

  // Cursor at the right edge of a full-width line → drop to col 0 of next line
  if (cursorColInLine >= maxWidth) {
    cursorWrappedLine++;
    cursorColInLine = 0;
    // If there's no next line yet, insert an empty continuation line
    if (cursorWrappedLine >= wrapped.length) {
      wrapped.splice(cursorWrappedLine, 0, "");
      isNewLineArr.splice(cursorWrappedLine, 0, false);
    }
  }

  // Scroll to keep cursor visible
  if (wrapped.length <= maxRows) {
    return {
      lines: wrapped,
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
    isNewLine: isNewLineArr.slice(scrollStart, scrollStart + maxRows),
    cursorLine: cursorWrappedLine - scrollStart,
    cursorCol: cursorColInLine,
    scrollOffset: scrollStart,
  };
}
