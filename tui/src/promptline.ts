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
import { markInsertEntry } from "./undo";
import { updateAutocomplete, cycleAutocomplete, tryPathComplete } from "./autocomplete";

/** Returns true if the key resulted in a submit (Enter). */
export function handlePromptKey(state: RenderState, key: KeyEvent): "submit" | "handled" | "unhandled" {
  const action = resolveAction(key);

  // Tab → cycle autocomplete forward, or try path completion
  if (key.type === "tab") {
    if (state.autocomplete) {
      cycleAutocomplete(state, 1);
    } else {
      tryPathComplete(state);
    }
    return "handled";
  }

  // Shift+Tab → cycle autocomplete backward
  if (key.type === "backtab") {
    if (state.autocomplete) {
      cycleAutocomplete(state, -1);
    }
    return "handled";
  }

  // Char input — only when no action is bound to this key
  if (key.type === "char" && action === null) {
    if (!key.char) return "handled";
    state.inputBuffer =
      state.inputBuffer.slice(0, state.cursorPos) +
      key.char +
      state.inputBuffer.slice(state.cursorPos);
    state.cursorPos++;
    updateAutocomplete(state);
    return "handled";
  }

  switch (action) {
    case "submit":
      state.autocomplete = null;
      return "submit";

    case "newline": {
      state.inputBuffer =
        state.inputBuffer.slice(0, state.cursorPos) +
        "\n" +
        state.inputBuffer.slice(state.cursorPos);
      state.cursorPos++;
      state.autocomplete = null;
      return "handled";
    }

    case "delete_back": {
      if (state.cursorPos > 0) {
        state.inputBuffer =
          state.inputBuffer.slice(0, state.cursorPos - 1) +
          state.inputBuffer.slice(state.cursorPos);
        state.cursorPos--;
      }
      updateAutocomplete(state);
      return "handled";
    }

    case "delete_forward": {
      if (state.cursorPos < state.inputBuffer.length) {
        state.inputBuffer =
          state.inputBuffer.slice(0, state.cursorPos) +
          state.inputBuffer.slice(state.cursorPos + 1);
      }
      updateAutocomplete(state);
      return "handled";
    }

    case "cursor_left":
      if (state.cursorPos > 0) state.cursorPos--;
      return "handled";

    case "cursor_right":
      if (state.cursorPos < state.inputBuffer.length) state.cursorPos++;
      return "handled";

    case "cursor_home": {
      const lineStart = state.inputBuffer.lastIndexOf("\n", state.cursorPos - 1) + 1;
      state.cursorPos = lineStart;
      return "handled";
    }

    case "cursor_end": {
      const nextNl = state.inputBuffer.indexOf("\n", state.cursorPos);
      state.cursorPos = nextNl === -1 ? state.inputBuffer.length : nextNl;
      return "handled";
    }

    case "cursor_up": {
      const buf = state.inputBuffer;
      const currentLineStart = buf.lastIndexOf("\n", state.cursorPos - 1) + 1;
      if (currentLineStart > 0) {
        const colInLine = state.cursorPos - currentLineStart;
        const prevLineStart = buf.lastIndexOf("\n", currentLineStart - 2) + 1;
        const prevLineLen = currentLineStart - 1 - prevLineStart;
        state.cursorPos = prevLineStart + Math.min(colInLine, prevLineLen);
        return "handled";
      }
      return "unhandled";
    }

    case "cursor_down": {
      const buf = state.inputBuffer;
      const nextNl = buf.indexOf("\n", state.cursorPos);
      if (nextNl !== -1) {
        const currentLineStart = buf.lastIndexOf("\n", state.cursorPos - 1) + 1;
        const colInLine = state.cursorPos - currentLineStart;
        const nextLineStart = nextNl + 1;
        const nextLineEnd = buf.indexOf("\n", nextLineStart);
        const nextLineLen = (nextLineEnd === -1 ? buf.length : nextLineEnd) - nextLineStart;
        state.cursorPos = nextLineStart + Math.min(colInLine, nextLineLen);
        return "handled";
      }
      return "unhandled";
    }

    default:
      return "unhandled";
  }
}

/** Clear the prompt buffer and reset cursor. */
export function clearPrompt(state: RenderState): void {
  state.inputBuffer = "";
  state.cursorPos = 0;
  state.vim.mode = "insert";
  // Mark new insert session so subsequent typing is undoable
  markInsertEntry(state.undo, "", 0);
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
}

/**
 * Split the input buffer into display lines with hard-wrapping.
 * Long lines are broken at maxWidth (vim-style, no word boundaries).
 * Returns the visible slice (scrolled to keep cursor in view)
 * plus cursor position within that slice.
 */
export function getInputLines(
  buffer: string,
  cursorPos: number,
  maxWidth: number,
  maxRows: number,
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

    if (line.length <= maxWidth) {
      // Cursor within this line?
      if (cursorPos >= bufOffset && cursorPos <= bufOffset + line.length) {
        cursorWrappedLine = wrapped.length;
        cursorColInLine = cursorPos - bufOffset;
      }
      wrapped.push(line);
      isNewLineArr.push(li > 0);
    } else {
      // Hard-wrap into chunks of maxWidth
      for (let i = 0; i < line.length; i += maxWidth) {
        const chunk = line.slice(i, i + maxWidth);
        // Cursor within this chunk?
        const chunkStart = bufOffset + i;
        const chunkEnd = chunkStart + chunk.length;
        if (cursorPos >= chunkStart && cursorPos <= chunkEnd) {
          cursorWrappedLine = wrapped.length;
          cursorColInLine = cursorPos - chunkStart;
        }
        wrapped.push(chunk);
        isNewLineArr.push(li > 0 && i === 0);
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
    };
  }

  // Cursor-following scroll
  let scrollStart = Math.max(0, cursorWrappedLine - maxRows + 1);
  // Don't scroll past the end
  scrollStart = Math.min(scrollStart, wrapped.length - maxRows);

  return {
    lines: wrapped.slice(scrollStart, scrollStart + maxRows),
    isNewLine: isNewLineArr.slice(scrollStart, scrollStart + maxRows),
    cursorLine: cursorWrappedLine - scrollStart,
    cursorCol: cursorColInLine,
  };
}
