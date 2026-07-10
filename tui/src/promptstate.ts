/**
 * Prompt-buffer state helpers shared outside promptline.ts.
 *
 * Keep small state mutations that other modules need in this leaf module so
 * command handling doesn't depend on the full prompt input implementation.
 */

import type { RenderState } from "./state";
import { sanitizePromptTextForInsertion } from "./prompttext";
import { commitInsertSession, markInsertEntry, pushUndo } from "./undo";

/** Clear the prompt buffer and reset cursor. */
export function clearPrompt(state: RenderState): void {
  state.inputBuffer = "";
  state.cursorPos = 0;
  state.promptCurswant = null;
  state.promptScrollOffset = 0;
  state.vim.mode = "insert";
  // Mark new insert session so subsequent typing is undoable
  markInsertEntry(state.undo, "", 0);
}

/** Append text to the draft as a triple-quote block on its own prompt line. */
export function appendPromptQuoteBlock(state: RenderState, text: string): boolean {
  const safeText = sanitizePromptTextForInsertion(text);
  if (!safeText) return false;

  const currentLastLine = state.inputBuffer.slice(state.inputBuffer.lastIndexOf("\n") + 1);
  const leadingNewline = currentLastLine.length > 0 ? "\n" : "";
  const quoteBlock = `"""\n${safeText}\n"""\n`;

  // Ctrl-N can move from a modified insert-mode prompt to history without an
  // Escape transition. Commit that earlier typing before recording this append
  // so a later `u` removes the quote block before the pre-existing draft.
  commitInsertSession(state.undo, state.inputBuffer);
  pushUndo(state.undo, state.inputBuffer, state.cursorPos);
  state.inputBuffer += leadingNewline + quoteBlock;
  state.cursorPos = state.inputBuffer.length;
  state.promptCurswant = null;
  state.autocomplete = null;
  return true;
}
