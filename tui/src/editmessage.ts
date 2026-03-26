/**
 * Edit message modal — lets the user pick a previous user message to re-edit.
 *
 * Ctrl+W opens a modal listing all user messages in the current conversation
 * plus any queued messages. j/k navigate, Enter selects, Escape cancels.
 *
 * For sent messages: the conversation is unwound (abort if streaming, then
 * truncate history) and the text is placed in the prompt for re-editing.
 * For queued messages: simply unqueued and placed in the prompt.
 */

import type { KeyEvent } from "./input";
import type { RenderState, EditMessageItem } from "./state";
import { focusPrompt } from "./state";

// ── Open modal ────────────────────────────────────────────────────

/** Open the edit message modal. No-op if there are no user/queued messages. */
export function openEditMessageModal(state: RenderState): void {
  if (!state.convId) return;

  const items: EditMessageItem[] = [];

  // Collect sent user messages
  let userIdx = 0;
  for (const msg of state.messages) {
    if (msg.role === "user") {
      items.push({
        userMessageIndex: userIdx,
        text: msg.text,
        isQueued: false,
        images: msg.images,
      });
      userIdx++;
    }
  }

  // Collect queued messages
  const queued = state.queuedMessages.filter(qm => qm.convId === state.convId);
  for (const qm of queued) {
    items.push({
      userMessageIndex: -1,
      text: qm.text,
      isQueued: true,
    });
  }

  if (items.length === 0) return;

  state.editMessagePrompt = {
    items,
    selection: items.length - 1,  // default to most recent
    scrollOffset: 0,
  };
}

// ── Key handling ──────────────────────────────────────────────────

export interface EditMessageKeyResult {
  type: "handled" | "confirm" | "cancel";
}

/** Handle a key event while the edit message modal is active. */
export function handleEditMessageKey(key: KeyEvent, state: RenderState): EditMessageKeyResult {
  const em = state.editMessagePrompt!;

  switch (key.type) {
    case "char":
      if (key.char === "k") {
        if (em.selection > 0) em.selection--;
      } else if (key.char === "j") {
        if (em.selection < em.items.length - 1) em.selection++;
      }
      return { type: "handled" };
    case "up":
      if (em.selection > 0) em.selection--;
      return { type: "handled" };
    case "down":
      if (em.selection < em.items.length - 1) em.selection++;
      return { type: "handled" };
    case "enter":
      return { type: "confirm" };
    case "escape":
    case "ctrl-c":
      return { type: "cancel" };
    default:
      return { type: "handled" };
  }
}

// ── Confirm / cancel ──────────────────────────────────────────────

export type EditConfirmResult =
  | { action: "edit_sent"; text: string; userMessageIndex: number }
  | { action: "edit_queued"; text: string }
  | { action: "cancel" };

/**
 * Confirm the selected message for editing.
 * Places the text in the prompt and closes the modal.
 */
export function confirmEditMessage(state: RenderState): EditConfirmResult {
  const em = state.editMessagePrompt!;
  const item = em.items[em.selection];

  state.editMessagePrompt = null;

  if (!item) return { action: "cancel" };

  // Place text in prompt
  state.inputBuffer = item.text;
  state.cursorPos = item.text.length;
  focusPrompt(state);

  // Restore image attachments so they're re-sent with the edited message
  if (item.images?.length) {
    state.pendingImages = [...item.images];
  }

  if (item.isQueued) {
    return { action: "edit_queued", text: item.text };
  }

  return { action: "edit_sent", text: item.text, userMessageIndex: item.userMessageIndex };
}

/** Cancel the edit message modal. */
export function cancelEditMessage(state: RenderState): void {
  state.editMessagePrompt = null;
}
