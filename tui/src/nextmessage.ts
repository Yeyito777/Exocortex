/**
 * Experimental next-message suggestions (`experimental.nextMessageSuggestions`).
 *
 * The daemon predicts the user's next message after a turn ends. It shows as
 * dim ghost text in the focused, empty prompt and disappears as soon as
 * anything is typed. Right Shift (as in the owner's zsh autosuggestions) or
 * Right arrow in insert or normal mode, or Tab in normal mode, puts it in the
 * prompt for editing; it is never sent by itself.
 */

import type { KeyEvent } from "./input";
import type { Event } from "./protocol";
import { isStreaming, type RenderState } from "./state";
import { commitInsertSession, markInsertEntry, pushUndo } from "./undo";
import { previousGraphemeStart } from "./graphemes";
import { updateAutocomplete } from "./autocomplete";

export function receiveNextMessageSuggestion(
  state: RenderState,
  event: Extract<Event, { type: "next_message_suggestion" }>,
): void {
  state.nextMessageSuggestion = event.text ? { convId: event.convId, text: event.text } : null;
}

/** A new turn in the open conversation makes its suggestion stale. */
export function dropNextMessageSuggestion(state: RenderState, convId: string): void {
  if (state.nextMessageSuggestion?.convId === convId) state.nextMessageSuggestion = null;
}

/** The suggestion to draw in the prompt right now, if any. */
export function visibleNextMessageSuggestion(state: RenderState): string | null {
  const suggestion = state.nextMessageSuggestion;
  if (!suggestion || suggestion.convId !== state.convId) return null;
  if (state.panelFocus !== "chat" || state.chatFocus !== "prompt") return null;
  if (state.inputBuffer !== "" || state.pendingImages.length > 0) return null;
  if (state.voicePrompt || state.voicePromptJobs.length > 0) return null;
  if (state.vim.mode !== "insert" && state.vim.mode !== "normal") return null;
  if (isStreaming(state)) return null;
  return suggestion.text;
}

function isAcceptKey(state: RenderState, key: KeyEvent): boolean {
  if (key.event === "release") return false;
  switch (key.type) {
    // Right Shift: st's OSC, Mac Terminal's CSI 29~, and the Mac's F20 over
    // /ssh. st also sends F20 for Ctrl+7 (sidebar item 7 outside insert mode);
    // that shortcut still works whenever no suggestion is visible.
    case "right-shift":
    case "right":
    case "f20":
      return true;
    // Insert-mode Tab completes or indents; in normal mode it is otherwise unbound.
    case "tab":
      return state.vim.mode === "normal";
    default:
      return false;
  }
}

/** Put the visible suggestion in the prompt if `key` accepts it. */
export function acceptNextMessageSuggestion(state: RenderState, key: KeyEvent): boolean {
  if (!isAcceptKey(state, key)) return false;
  const text = visibleNextMessageSuggestion(state);
  if (!text) return false;
  commitInsertSession(state.undo, state.inputBuffer);
  pushUndo(state.undo, state.inputBuffer, state.cursorPos);
  state.inputBuffer = text;
  state.cursorPos = state.vim.mode === "insert" ? text.length : previousGraphemeStart(text, text.length);
  state.promptCurswant = null;
  if (state.vim.mode === "insert") markInsertEntry(state.undo, state.inputBuffer, state.cursorPos);
  updateAutocomplete(state);
  return true;
}
