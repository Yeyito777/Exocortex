/**
 * Prompt-buffer state helpers shared outside promptline.ts.
 *
 * Keep small state mutations that other modules need in this leaf module so
 * command handling doesn't depend on the full prompt input implementation.
 */

import type { RenderState } from "./state";
import { markInsertEntry } from "./undo";

/** Clear the prompt buffer and reset cursor. */
export function clearPrompt(state: RenderState): void {
  state.inputBuffer = "";
  state.cursorPos = 0;
  state.promptScrollOffset = 0;
  state.vim.mode = "insert";
  // Mark new insert session so subsequent typing is undoable
  markInsertEntry(state.undo, "", 0);
}
