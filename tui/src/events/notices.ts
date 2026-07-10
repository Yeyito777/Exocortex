import type { Event, SystemMessageEvent } from "../protocol";
import type { RenderState } from "../state";
import { resolveSystemMessageColor } from "../state";
import { commitPendingAISegment } from "./pending-ai";

export function pushInlineSystemNotice(
  state: RenderState,
  text: string,
  color: string | undefined,
  reconcileOnStop = false,
): void {
  const notice = { role: "system" as const, text, color: resolveSystemMessageColor(color), metadata: null };
  // An ordinary notice can arrive halfway through a provider block. Splitting
  // there makes later canonical rewrites impossible to reconcile without
  // rewriting history around the notice. Keep it in the live tail instead.
  // Retry notices still arrive after their completed prefix was explicitly
  // committed, so their pending block list is empty and they remain inline.
  if (state.pendingAI && !reconcileOnStop && state.pendingAI.blocks.length > 0) {
    state.streamingTailMessages.push(notice);
    return;
  }
  if (state.pendingAI) {
    const startedAt = state.pendingAI.metadata?.startedAt ?? null;
    const segmentBlockOffset = state.pendingAIBlockOffset;
    const localBlockIndex = state.pendingAIPartialCommittedBlocks.length;
    const finalized = commitPendingAISegment(state);
    if (finalized) {
      if (reconcileOnStop) finalized.metadata = state.pendingAI.metadata ? { ...state.pendingAI.metadata } : null;
      state.messages.push(finalized);
      if (reconcileOnStop) {
        state.pendingAICommittedIndex = state.messages.length - 1;
        state.pendingAICommittedBlockOffset = segmentBlockOffset;
        state.pendingAICommittedLocalBlockIndex = localBlockIndex;
      }
    } else if (reconcileOnStop) {
      state.suppressPendingAIMetadataStartedAt = startedAt;
    }
  }
  state.messages.push(notice);
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
