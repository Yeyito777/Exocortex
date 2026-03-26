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
 * The actual queue lives in the daemon — the TUI sends a queue_message
 * command and keeps a local shadow copy for display (dimmed bubbles).
 */

import type { KeyEvent } from "./input";
import type { ImageAttachment } from "./messages";
import type { RenderState, QueueTiming, QueuedMessage } from "./state";
import { isStreaming } from "./state";

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
    case "ctrl-c":
      return { type: "cancel" };
    default:
      return { type: "handled" };
  }
}

// ── Confirm / cancel ───────────────────────────────────────────────

export type ConfirmResult =
  | { action: "send_direct"; text: string; images?: ImageAttachment[] }
  | { action: "queue"; convId: string; text: string; timing: QueueTiming; images?: ImageAttachment[] }
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

  // If streaming already finished while the overlay was showing, send directly
  if (!isStreaming(state) && convId) {
    const text = qp.text;
    const images = qp.images;
    state.queuePrompt = null;
    state.inputBuffer = "";
    state.cursorPos = 0;
    return { action: "send_direct", text, images };
  }

  if (!convId) {
    // No conversation — can't queue. Restore text to prompt.
    state.inputBuffer = qp.text;
    state.cursorPos = qp.text.length;
    state.queuePrompt = null;
    return { action: "cancel" };
  }

  // Queue the message — local shadow for display
  const images = qp.images;
  const queued: QueuedMessage = { convId, text: qp.text, timing, ...(images?.length ? { images } : {}) };
  state.queuedMessages.push(queued);
  state.queuePrompt = null;
  state.inputBuffer = "";
  state.cursorPos = 0;
  return { action: "queue", convId, text: qp.text, timing, images };
}

/**
 * Cancel the queue prompt — restore the text and images to the input buffer.
 */
export function cancelQueuePrompt(state: RenderState): void {
  const qp = state.queuePrompt!;
  state.inputBuffer = qp.text;
  state.cursorPos = qp.text.length;
  if (qp.images?.length) state.pendingImages = qp.images;
  state.queuePrompt = null;
}

// ── Drain (local shadow cleanup) ──────────────────────────────────

/**
 * Remove a single local shadow whose convId and text match.
 * Called when the daemon consumes a queued message (user_message event)
 * or when the user manually unqueues one (edit_message_confirm).
 */
export function removeLocalQueueEntry(state: RenderState, convId: string, text: string): void {
  const idx = state.queuedMessages.findIndex(
    qm => qm.convId === convId && qm.text === text,
  );
  if (idx !== -1) state.queuedMessages.splice(idx, 1);
}

/**
 * Remove all local shadow entries for a conversation.
 * Called on conversation switch/delete — NOT on streaming_stopped,
 * since the daemon drains queued messages one at a time (each
 * removal is handled individually by the user_message event handler).
 */
export function clearLocalQueue(state: RenderState, convId: string): void {
  state.queuedMessages = state.queuedMessages.filter(qm => qm.convId !== convId);
}
