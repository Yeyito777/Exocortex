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
import type { UserMessage } from "./messages";
import type { RenderState, EditMessageItem } from "./state";
import { EDIT_INDEX_INSTRUCTIONS, EDIT_INDEX_QUEUED, focusPrompt } from "./state";
import { computeEditMessageOverlayLayout, type EditMessageOverlayLayout } from "./editmessage-layout";
import { isNewConversationQueuedMessage } from "./queue";

// ── Open modal ────────────────────────────────────────────────────

/** Open the edit message modal. No-op if there are no user/queued messages. */
export function openEditMessageModal(state: RenderState): void {
  const items: EditMessageItem[] = [];
  const includedMessages = new Set<object>();
  const submittedVoiceMessage = state.voiceMessage?.message;

  function isSameSubmittedVoiceMessage(msg: UserMessage): boolean {
    if (!submittedVoiceMessage) return false;
    if (msg === submittedVoiceMessage) return true;
    const msgStartedAt = msg.metadata?.startedAt;
    const voiceStartedAt = submittedVoiceMessage.metadata?.startedAt;
    if (msgStartedAt !== undefined && voiceStartedAt !== undefined && msgStartedAt === voiceStartedAt) return true;
    return msg.text.includes("Transcribing…") && submittedVoiceMessage.text.includes("Transcribing…") && msg.text === submittedVoiceMessage.text;
  }

  // Collect system instructions (shown first with special marker)
  for (const msg of state.messages) {
    if (msg.role === "system_instructions" && msg.text.trim()) {
      items.push({
        userMessageIndex: EDIT_INDEX_INSTRUCTIONS,
        text: msg.text,
        isQueued: false,
      });
      break; // There's at most one
    }
  }

  // Collect sent user messages
  let userIdx = 0;
  for (const msg of state.messages) {
    if (msg.role === "user") {
      const itemMessage = isSameSubmittedVoiceMessage(msg) ? submittedVoiceMessage! : msg;
      if (includedMessages.has(itemMessage)) {
        userIdx++;
        continue;
      }
      items.push({
        userMessageIndex: userIdx,
        text: itemMessage.text,
        isQueued: false,
        images: itemMessage.images,
        message: itemMessage,
        sourceMessage: msg,
      });
      includedMessages.add(itemMessage);
      userIdx++;
    }
  }

  // A submitted voice transcription is a local user-message echo until the
  // transcript resolves and the final text is sent to the daemon.  It may be
  // outside canonical history (for example before a new conversation exists, or
  // after a history refresh).  Keep it in Ctrl-W so selecting it can move the
  // still-running transcription job back to the prompt.
  const submittedVoiceShownAsQueue = !!submittedVoiceMessage && !!state.convId
    && state.queuedMessages.some(qm => qm.convId === state.convId && qm.text === submittedVoiceMessage.text);
  if (submittedVoiceMessage && !includedMessages.has(submittedVoiceMessage) && !submittedVoiceShownAsQueue) {
    items.push({
      userMessageIndex: userIdx,
      text: submittedVoiceMessage.text,
      isQueued: false,
      images: submittedVoiceMessage.images,
      message: submittedVoiceMessage,
    });
  }

  // Collect queued messages
  const queued = state.convId
    ? state.queuedMessages.filter(qm => qm.convId === state.convId)
    : state.queuedMessages.filter(qm => isNewConversationQueuedMessage(qm) && qm.convId === state.pendingQueuedDraftConvId);
  for (const qm of queued) {
    items.push({
      userMessageIndex: EDIT_INDEX_QUEUED,
      text: qm.text,
      isQueued: true,
      images: qm.images,
      queuedMessage: qm,
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
      return { type: "cancel" };
    default:
      return { type: "handled" };
  }
}

function getEditMessageOverlayLayout(state: RenderState): EditMessageOverlayLayout | null {
  const em = state.editMessagePrompt;
  if (!em) return null;
  const chatW = state.cols - state.layout.chatCol + 1;
  return computeEditMessageOverlayLayout(
    em,
    chatW,
    state.layout.chatCol,
    state.layout.sepAbove,
    state.layout.messageAreaHeight,
  );
}

/**
 * Return the edit-message item under a mouse click, or null if the click was
 * outside the visible item rows.  Used to make Ctrl-W's modal clickable with
 * the same semantics as pressing Enter on the highlighted row.
 */
export function editMessageItemIndexAtMouse(
  state: RenderState,
  col: number,
  row: number,
): number | null {
  const layout = getEditMessageOverlayLayout(state);
  const em = state.editMessagePrompt;
  if (!layout || !em) return null;
  if (col < layout.boxLeft || col >= layout.boxLeft + layout.boxWidth) return null;
  const visibleIndex = row - layout.firstItemRow;
  if (visibleIndex < 0 || visibleIndex >= layout.maxVisible) return null;
  const itemIndex = layout.scrollStart + visibleIndex;
  return itemIndex >= 0 && itemIndex < em.items.length ? itemIndex : null;
}

// ── Confirm / cancel ──────────────────────────────────────────────

export type EditConfirmResult =
  | { action: "edit_sent"; text: string; userMessageIndex: number }
  | { action: "edit_queued"; text: string; queuedMessage?: EditMessageItem["queuedMessage"] }
  | { action: "edit_instructions"; text: string }
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

  if (item.userMessageIndex === EDIT_INDEX_INSTRUCTIONS) {
    if (state.folderInstructionsDoc) {
      state.inputBuffer = item.text;
      state.cursorPos = state.inputBuffer.length;
    } else {
      // Conversation instructions — prepend /instructions so it routes through the slash command.
      state.inputBuffer = `/instructions ${item.text}`;
      state.cursorPos = state.inputBuffer.length;
    }
    return { action: "edit_instructions", text: item.text };
  }

  if (item.isQueued) {
    return { action: "edit_queued", text: item.text, queuedMessage: item.queuedMessage };
  }

  return { action: "edit_sent", text: item.text, userMessageIndex: item.userMessageIndex };
}

/** Cancel the edit message modal. */
export function cancelEditMessage(state: RenderState): void {
  state.editMessagePrompt = null;
}
