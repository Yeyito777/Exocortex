/**
 * Prompt line input handling.
 *
 * Owns all input buffer manipulation: character insertion, deletion,
 * cursor movement, multiline navigation. The only file that mutates
 * state.inputBuffer and state.cursorPos.
 */

import type { KeyEvent } from "./input";
import type { RenderState } from "./state";

/** Returns true if the key resulted in a submit (Enter). */
export function handlePromptKey(state: RenderState, key: KeyEvent): "submit" | "handled" | "unhandled" {
  switch (key.type) {
    case "char": {
      if (!key.char) return "handled";
      state.inputBuffer =
        state.inputBuffer.slice(0, state.cursorPos) +
        key.char +
        state.inputBuffer.slice(state.cursorPos);
      state.cursorPos++;
      return "handled";
    }

    case "enter":
      return "submit";

    case "ctrl-l": {
      state.inputBuffer =
        state.inputBuffer.slice(0, state.cursorPos) +
        "\n" +
        state.inputBuffer.slice(state.cursorPos);
      state.cursorPos++;
      return "handled";
    }

    case "backspace": {
      if (state.cursorPos > 0) {
        state.inputBuffer =
          state.inputBuffer.slice(0, state.cursorPos - 1) +
          state.inputBuffer.slice(state.cursorPos);
        state.cursorPos--;
      }
      return "handled";
    }

    case "delete": {
      if (state.cursorPos < state.inputBuffer.length) {
        state.inputBuffer =
          state.inputBuffer.slice(0, state.cursorPos) +
          state.inputBuffer.slice(state.cursorPos + 1);
      }
      return "handled";
    }

    case "left":
      if (state.cursorPos > 0) state.cursorPos--;
      return "handled";

    case "right":
      if (state.cursorPos < state.inputBuffer.length) state.cursorPos++;
      return "handled";

    case "home": {
      const lineStart = state.inputBuffer.lastIndexOf("\n", state.cursorPos - 1) + 1;
      state.cursorPos = lineStart;
      return "handled";
    }

    case "end": {
      const nextNl = state.inputBuffer.indexOf("\n", state.cursorPos);
      state.cursorPos = nextNl === -1 ? state.inputBuffer.length : nextNl;
      return "handled";
    }

    case "up": {
      const buf = state.inputBuffer;
      const currentLineStart = buf.lastIndexOf("\n", state.cursorPos - 1) + 1;
      if (currentLineStart > 0) {
        const colInLine = state.cursorPos - currentLineStart;
        const prevLineStart = buf.lastIndexOf("\n", currentLineStart - 2) + 1;
        const prevLineLen = currentLineStart - 1 - prevLineStart;
        state.cursorPos = prevLineStart + Math.min(colInLine, prevLineLen);
        return "handled";
      }
      // On first line — not handled, let main.ts scroll messages
      return "unhandled";
    }

    case "down": {
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
      // On last line — not handled, let main.ts scroll messages
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
}
