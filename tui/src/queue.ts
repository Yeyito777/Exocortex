/**
 * Message queue prompt — modal overlay for queuing messages during streaming.
 *
 * When the user submits a message while the AI is still streaming,
 * a modal appears letting them choose when to deliver it:
 * - "message end": sent after the current stream ends
 * - "next turn": injected between tool-use rounds if possible,
 *   otherwise sent after the stream ends
 *
 * j/k and arrow keys toggle the selection. Enter confirms, Escape cancels.
 *
 * The actual persistent queue and scheduler live in the daemon. The TUI sends
 * queue commands and keeps only optimistic shadows for immediate display.
 */

import type { KeyEvent } from "./input";
import { randomUUID } from "node:crypto";
import type { ImageAttachment } from "./messages";
import type { RenderState, QueueTiming, QueueWaitTarget, QueuedMessage } from "./state";
import { expandMacros } from "./macros";
import { isStreaming } from "./state";

export const GLOBAL_IDLE_QUEUE_LABEL = "queued: global idle";

export function isGlobalIdleQueuedMessage(message: QueuedMessage): boolean {
  return message.source === "global-idle";
}

export function isNewConversationQueuedMessage(message: QueuedMessage): boolean {
  return isGlobalIdleQueuedMessage(message) && message.target === "new-conversation";
}

export type GlobalIdleQueueOptions = Pick<QueuedMessage, "id" | "target" | "provider" | "model" | "effort" | "fastMode" | "folderId" | "waitTarget">;

export function queueWaitTargetOf(message: QueuedMessage): QueueWaitTarget {
  return message.waitTarget ?? { type: "global" };
}

export function queueTimingLabel(message: QueuedMessage): string {
  if (isGlobalIdleQueuedMessage(message)) {
    const waitTarget = queueWaitTargetOf(message);
    if (waitTarget.type === "conversation") return `queued: after ${waitTarget.label}`;
    if (waitTarget.type === "folder") return `queued: after folder ${waitTarget.label}`;
    return GLOBAL_IDLE_QUEUE_LABEL;
  }
  return message.timing === "next-turn" ? "queued: next turn" : "queued: message end";
}

function queueDisplayBucket(message: QueuedMessage): number {
  if (!isGlobalIdleQueuedMessage(message)) {
    return message.timing === "next-turn" ? 0 : 1;
  }
  return queueWaitTargetOf(message).type === "global" ? 3 : 2;
}

/**
 * Group queued messages by when they can run while retaining FIFO order inside
 * each group: next turn, message end, specific idle target, then global idle.
 * This is deliberately display-only; the daemon's canonical queue stays in
 * insertion order for scheduling and persistence.
 */
export function queuedMessagesInDisplayOrder(messages: readonly QueuedMessage[]): QueuedMessage[] {
  const buckets: QueuedMessage[][] = [[], [], [], []];
  for (const message of messages) buckets[queueDisplayBucket(message)].push(message);
  return buckets.flat();
}

export function enqueueGlobalIdleMessage(
  state: RenderState,
  convId: string,
  text: string,
  images?: ImageAttachment[],
  options: GlobalIdleQueueOptions = {},
): QueuedMessage {
  const queued: QueuedMessage = {
    id: options.id ?? randomUUID(),
    optimistic: true,
    convId,
    text,
    timing: "message-end",
    source: "global-idle",
    createdAt: Date.now(),
    ...(options.target ? { target: options.target } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(typeof options.fastMode === "boolean" ? { fastMode: options.fastMode } : {}),
    ...("folderId" in options ? { folderId: options.folderId ?? null } : {}),
    ...(options.waitTarget && options.waitTarget.type !== "global" ? { waitTarget: options.waitTarget } : {}),
    ...(images?.length ? { images } : {}),
  };
  state.queuedMessages.push(queued);
  return queued;
}

export function removeQueuedMessageByReference(state: RenderState, message: QueuedMessage): boolean {
  const idx = state.queuedMessages.indexOf(message);
  if (idx === -1) return false;
  state.queuedMessages.splice(idx, 1);
  return true;
}

export function removeNewConversationQueuedMessage(state: RenderState, convId: string): boolean {
  const idx = state.queuedMessages.findIndex(qm => isNewConversationQueuedMessage(qm) && qm.convId === convId);
  if (idx === -1) return false;
  state.queuedMessages.splice(idx, 1);
  return true;
}

/**
 * Open the queue prompt for the current prompt buffer.
 *
 * The text is intentionally stored unexpanded so canceling the modal restores
 * exactly what the user typed. Macros are expanded only on confirm, when the
 * message is actually sent or queued.
 *
 * Images are copied into the queue prompt so they travel with the queued
 * message, but they remain in state.pendingImages until the user actually
 * confirms queueing/sending. That keeps the promptline image indicator visible
 * while the modal is open.
 */
export function openQueuePrompt(state: RenderState, text: string): void {
  state.queuePrompt = {
    text,
    selection: "message-end",
    images: state.pendingImages.length > 0 ? [...state.pendingImages] : undefined,
  };
}

// ── Key handling ───────────────────────────────────────────────────

export interface QueueKeyResult {
  type: "handled" | "confirm" | "cancel";
}

/**
 * Handle a key event while the queue prompt overlay is active.
 * Returns "confirm" when the user picks a timing, "cancel" on Escape.
 */
export function handleQueuePromptKey(key: KeyEvent, state: RenderState): QueueKeyResult {
  const qp = state.queuePrompt!;

  switch (key.type) {
    case "char":
      if (key.char === "h" || key.char === "k") {
        qp.selection = "message-end";
      } else if (key.char === "l" || key.char === "j") {
        qp.selection = "next-turn";
      }
      return { type: "handled" };
    case "left":
    case "up":
      qp.selection = "message-end";
      return { type: "handled" };
    case "right":
    case "down":
      qp.selection = "next-turn";
      return { type: "handled" };
    case "tab":
      qp.selection = qp.selection === "message-end" ? "next-turn" : "message-end";
      return { type: "handled" };
    case "enter":
      return { type: "confirm" };
    case "escape":
      return { type: "cancel" };
    default:
      return { type: "handled" };
  }
}

// ── Confirm / cancel ───────────────────────────────────────────────

export type ConfirmResult =
  | { action: "send_direct"; text: string; images?: ImageAttachment[] }
  | { action: "queue"; queueId: string; convId: string; text: string; timing: QueueTiming; images?: ImageAttachment[] }
  | { action: "cancel" };

/**
 * Confirm the queued message. Returns what the caller should do:
 * - send_direct: streaming finished, send immediately
 * - queue: send queue_message to daemon + add local shadow
 * - cancel: no conversation, can't queue
 */
export function confirmQueueMessage(state: RenderState): ConfirmResult {
  const qp = state.queuePrompt!;
  const timing = qp.selection;
  const convId = state.convId;

  // If streaming already finished while the overlay was showing, send directly.
  // This is a real send path, so expand macros here rather than when the modal
  // opens (so cancel can still restore the raw prompt text).
  if (!isStreaming(state) && convId) {
    const text = expandMacros(qp.text);
    const images = qp.images;
    if (images?.length) state.pendingImages = [];
    state.queuePrompt = null;
    state.inputBuffer = "";
    state.cursorPos = 0;
    return { action: "send_direct", text, images };
  }

  if (!convId) {
    // No conversation — can't queue. Restore the raw text to prompt.
    state.inputBuffer = qp.text;
    state.cursorPos = qp.text.length;
    state.queuePrompt = null;
    return { action: "cancel" };
  }

  // Queue the message — local shadow for display. Store the expanded text so
  // the shadow matches what the daemon will later echo back as a user message.
  const images = qp.images;
  const text = expandMacros(qp.text);
  const queueId = randomUUID();
  const queued: QueuedMessage = { id: queueId, optimistic: true, convId, text, timing, images, source: "daemon", createdAt: Date.now() };
  if (images?.length) state.pendingImages = [];
  state.queuedMessages.push(queued);
  state.queuePrompt = null;
  state.inputBuffer = "";
  state.cursorPos = 0;
  return { action: "queue", queueId, convId, text, timing, images };
}

/**
 * Cancel the queue prompt — restore the text to the input buffer.
 *
 * Images stay in pendingImages while the modal is open, so there's nothing to
 * restore here.
 */
export function cancelQueuePrompt(state: RenderState): void {
  const qp = state.queuePrompt!;
  state.inputBuffer = qp.text;
  state.cursorPos = qp.text.length;
  state.queuePrompt = null;
}

// ── Drain (local shadow cleanup) ──────────────────────────────────

/**
 * Remove a single local shadow whose convId and text match.
 * Called when the daemon consumes a queued message (user_message event)
 * or when the user manually unqueues one (edit_message_confirm).
 */
export function removeLocalQueueEntry(state: RenderState, convId: string, text: string, queueId?: string): void {
  const idx = state.queuedMessages.findIndex(
    qm => queueId ? qm.id === queueId : (!isGlobalIdleQueuedMessage(qm) && qm.convId === convId && qm.text === text),
  );
  if (idx !== -1) state.queuedMessages.splice(idx, 1);
}

/** Optimistically remove every queued shadow for a deleted conversation. */
export function clearAllQueuedMessagesForConversation(state: RenderState, convId: string): void {
  state.queuedMessages = state.queuedMessages.filter(qm => qm.convId !== convId);
}
