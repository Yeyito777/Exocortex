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
import type { Event } from "./protocol";
import type { RenderState, EditMessageItem } from "./state";
import {
  EDIT_INDEX_INSTRUCTIONS,
  EDIT_INDEX_QUEUED,
  clearPendingAI,
  clearStreamingTailMessages,
  focusPrompt,
} from "./state";
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
  let userIdx = state.historyStartUserIndex;
  for (const msg of state.messages) {
    if (msg.role === "user") {
      const absoluteUserIdx = userIdx;
      userIdx += 1;
      // Native/plaintext compaction is irreversible. The daemon exposes only
      // post-checkpoint user messages as rewindable and enforces the same rule.
      if (msg.contextCheckpoint?.editable === false) {
        continue;
      }
      const itemMessage = isSameSubmittedVoiceMessage(msg) ? submittedVoiceMessage! : msg;
      if (includedMessages.has(itemMessage)) {
        continue;
      }
      items.push({
        userMessageIndex: absoluteUserIdx,
        text: itemMessage.text,
        isQueued: false,
        images: itemMessage.images,
        message: itemMessage,
        sourceMessage: msg,
      });
      includedMessages.add(itemMessage);
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
  | { action: "edit_sent"; text: string; userMessageIndex: number; expectedStartedAt?: number; targetFingerprint?: string }
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

  if (!item || (!item.isQueued && item.userMessageIndex >= 0 && item.message?.contextCheckpoint?.editable === false)) {
    return { action: "cancel" };
  }

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

  if (item.message?.contextCheckpoint) {
    state.contextTokens = item.message.contextCheckpoint.contextTokens;
  }

  const expectedStartedAt = item.message?.metadata?.startedAt;
  const targetFingerprint = item.sourceMessage?.unwindFingerprint ?? item.message?.unwindFingerprint;
  return {
    action: "edit_sent",
    text: item.text,
    userMessageIndex: item.userMessageIndex,
    ...(typeof expectedStartedAt === "number" ? { expectedStartedAt } : {}),
    ...(targetFingerprint ? { targetFingerprint } : {}),
  };
}

/**
 * Immediately project a sent-message unwind into the local transcript.
 *
 * The daemon remains authoritative and performs the durable mutation, but it
 * must first wait for an active stream (and its provider-session cleanup) to
 * stop. Keeping the known-doomed suffix visible during that wait makes Ctrl-W
 * feel delayed even though the key and modal were handled synchronously.
 */
export function applyOptimisticEditMessageUnwind(
  state: RenderState,
  userMessageIndex: number,
): boolean {
  let visibleUserIndex = state.historyStartUserIndex;
  let spliceAt = -1;

  for (let i = 0; i < state.messages.length; i++) {
    if (state.messages[i]?.role !== "user") continue;
    if (visibleUserIndex === userMessageIndex) {
      spliceAt = i;
      break;
    }
    visibleUserIndex += 1;
  }

  // This can only happen for a stale modal or a local-only voice placeholder.
  // In either case, leave the current projection alone and let the daemon's
  // canonical response decide what should be displayed.
  if (spliceAt === -1) return false;

  const retainedHistoryEntries = state.messages
    .slice(0, spliceAt)
    .filter((message) => message.role !== "system_instructions")
    .length;

  state.messages.splice(spliceAt);
  clearPendingAI(state);
  clearStreamingTailMessages(state);
  if (state.convId) delete state.lastStreamSeqByConv[state.convId];
  state.scrollOffset = 0;
  state.historyTotalEntries = state.historyStartIndex + retainedHistoryEntries;
  state.historyHasOlder = state.historyStartIndex > 0;
  state.historyLoadingOlder = false;
  state.historyLoadingStartedAt = null;
  state.historyLoadingRequestId = null;
  return true;
}

/** Apply the daemon's targeted canonical unwind without replacing loaded history. */
export function applyConversationUnwound(
  state: RenderState,
  event: Extract<Event, { type: "conversation_unwound" }>,
): void {
  if (state.convId !== event.convId) return;
  if (event.status === "already_applied") return;

  let visibleUserIndex = state.historyStartUserIndex;
  let spliceAt = -1;
  for (let i = 0; i < state.messages.length; i++) {
    if (state.messages[i]?.role !== "user") continue;
    if (visibleUserIndex === event.userMessageIndex) {
      spliceAt = i;
      break;
    }
    visibleUserIndex += 1;
  }

  if (spliceAt >= 0) {
    state.messages.splice(spliceAt);
  } else if (event.userMessageIndex < state.historyStartUserIndex
      || event.historyTotalEntries < state.historyStartIndex) {
    // This client had only a newer page loaded and the boundary precedes it.
    // Keep pinned instructions; older retained history remains pageable.
    state.messages = state.messages.filter((message) => message.role === "system_instructions");
    state.historyStartIndex = event.historyTotalEntries;
    state.historyStartUserIndex = event.userMessageIndex;
  }

  clearPendingAI(state);
  clearStreamingTailMessages(state);
  delete state.lastStreamSeqByConv[event.convId];
  state.contextTokens = event.contextTokens;
  state.historyTotalEntries = event.historyTotalEntries;
  state.historyHasOlder = state.historyStartIndex > 0;
  state.historyLoadingOlder = false;
  state.historyLoadingStartedAt = null;
  state.historyLoadingRequestId = null;
  state.scrollOffset = 0;
}

export interface PendingEditMessageUnwind {
  convId: string;
  reqId: string;
}

export type PendingEditMessageUnwindEvent = "unrelated" | "ignore" | "complete" | "failed";

const EVENTS_SUPERSEDED_BY_PENDING_UNWIND: ReadonlySet<Event["type"]> = new Set([
  "conversation_loaded",
  "streaming_started",
  "block_start",
  "text_chunk",
  "thinking_chunk",
  "streaming_sync",
  "tool_call",
  "tool_result",
  "tokens_update",
  "context_update",
  "message_complete",
  "streaming_stopped",
  "stream_retry",
  "context_compaction_status",
  "user_message",
  "system_message",
  "history_updated",
]);

/**
 * Classify daemon events received while an optimistic unwind is in flight.
 * Stream-finalization events describe the suffix that is about to be deleted,
 * so applying them would briefly make the old tail reappear. The matching
 * conversation_unwound response ends the optimistic window and applies only
 * the requested suffix boundary.
 */
export function classifyPendingEditMessageUnwindEvent(
  pending: PendingEditMessageUnwind,
  event: Event,
): PendingEditMessageUnwindEvent {
  if (!("convId" in event) || event.convId !== pending.convId) return "unrelated";
  if ((event.type === "conversation_unwound" || event.type === "conversation_loaded")
      && event.reqId === pending.reqId) return "complete";
  if (event.type === "error" && event.reqId === pending.reqId) return "failed";
  if (EVENTS_SUPERSEDED_BY_PENDING_UNWIND.has(event.type)) return "ignore";
  return "unrelated";
}

/** Cancel the edit message modal. */
export function cancelEditMessage(state: RenderState): void {
  state.editMessagePrompt = null;
}
