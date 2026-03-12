/**
 * Message queue prompt — modal overlay for queuing messages during streaming.
 *
 * When the user submits a message while the AI is still streaming,
 * a modal appears letting them choose when to deliver it:
 * - "next turn": injected between tool-use rounds (ASAP)
 * - "message end": sent after the full AI turn finishes
 *
 * j/k and arrow keys toggle the selection. Enter confirms, Escape cancels.
 *
 * The actual queue lives in the daemon — the TUI sends a queue_message
 * command and keeps a local shadow copy for display (dimmed bubbles).
 */

import type { KeyEvent } from "./input";
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
  | { action: "send_direct"; text: string }
  | { action: "queue"; convId: string; text: string; timing: QueueTiming }
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
    state.queuePrompt = null;
    state.inputBuffer = "";
    state.cursorPos = 0;
    return { action: "send_direct", text };
  }

  if (!convId) {
    // No conversation — can't queue. Restore text to prompt.
    state.inputBuffer = qp.text;
    state.cursorPos = qp.text.length;
    state.queuePrompt = null;
    return { action: "cancel" };
  }

  // Queue the message — local shadow for display
  const queued: QueuedMessage = { convId, text: qp.text, timing };
  state.queuedMessages.push(queued);
  state.queuePrompt = null;
  state.inputBuffer = "";
  state.cursorPos = 0;
  return { action: "queue", convId, text: qp.text, timing };
}

/**
 * Cancel the queue prompt — restore the text to the input buffer.
 */
export function cancelQueuePrompt(state: RenderState): void {
  const qp = state.queuePrompt!;
  state.inputBuffer = qp.text;
  state.cursorPos = qp.text.length;
  state.queuePrompt = null;
}

// ── Drain (local shadow cleanup) ──────────────────────────────────

/**
 * Remove local shadow entries for a conversation.
 * Called when streaming_stopped arrives — the daemon already drained.
 */
export function clearLocalQueue(state: RenderState, convId: string): void {
  state.queuedMessages = state.queuedMessages.filter(qm => qm.convId !== convId);
}
