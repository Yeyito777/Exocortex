import { splitPendingAI } from "../messages";
import type { Event, SystemMessageEvent } from "../protocol";
import type { RenderState } from "../state";
import { resolveSystemMessageColor } from "../state";

export function pushInlineSystemNotice(
  state: RenderState,
  text: string,
  color: string | undefined,
  reconcileOnStop = false,
): void {
  if (state.pendingAI) {
    const finalized = splitPendingAI(state.pendingAI);
    if (finalized) {
      if (reconcileOnStop) finalized.metadata = state.pendingAI.metadata ? { ...state.pendingAI.metadata } : null;
      state.messages.push(finalized);
      if (reconcileOnStop) state.pendingAICommittedIndex = state.messages.length - 1;
    }
  }
  state.messages.push({ role: "system", text, color: resolveSystemMessageColor(color), metadata: null });
}

export function formatStreamRetryNotice(event: Extract<Event, { type: "stream_retry" }>): string {
  if (event.kind === "usage_limit_reset") {
    const reset = event.resetAt != null ? ` at ${new Date(event.resetAt).toLocaleString()}` : "";
    return `${event.errorMessage} — retrying${reset}…`;
  }
  return `⟳ ${event.errorMessage} — retrying in ${event.delaySec}s (${event.attempt}/${event.maxAttempts})…`;
}

export function shouldReconcileInlineSystemNoticeOnStop(event: SystemMessageEvent): boolean {
  // The daemon currently uses `system_message` both for durable stream
  // failures (timeouts, interrupts, hard errors) and for ordinary notices.
  // Only the durable failure class should claim the pending assistant slot
  // and get its final blocks reconciled when streaming_stopped arrives.
  return event.color === "error" || event.text.startsWith("✗");
}
