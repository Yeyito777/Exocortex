import { log } from "../log";
import type { Event } from "../protocol";
import type { RenderState } from "../state";
import { blockStats } from "./streaming-snapshot";

export const CONV_SCOPED: ReadonlySet<string> = new Set([
  "streaming_started", "block_start", "text_chunk", "thinking_chunk", "streaming_sync",
  "tool_call", "tool_result", "tokens_update", "context_update",
  "message_complete", "streaming_stopped", "user_message", "system_message",
  "stream_retry", "history_updated", "tool_outputs_loaded", "goal_updated",
  "context_compaction_status",
]);

const STREAM_SEQ_SCOPED: ReadonlySet<string> = new Set([
  "streaming_started", "block_start", "text_chunk", "thinking_chunk", "streaming_sync",
  "tool_call", "tool_result", "tokens_update", "context_update",
  "stream_retry", "user_message", "system_message", "history_updated",
  "context_compaction_status",
  "message_complete", "streaming_stopped",
]);

type StreamSeqEvent = Event & { convId?: string; streamSeq?: number; snapshotKind?: string };

function streamSeqLogPayload(
  event: StreamSeqEvent,
  state: RenderState,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    convId: event.convId ?? null,
    eventType: event.type,
    streamSeq: event.streamSeq ?? null,
    snapshotKind: event.snapshotKind ?? null,
    pending: state.pendingAI ? blockStats(state.pendingAI.blocks) : null,
    pendingTokens: state.pendingAI?.metadata?.tokens ?? null,
    ...extra,
  };
}

export function observeStreamSeq(event: Event, state: RenderState): void {
  if (!STREAM_SEQ_SCOPED.has(event.type)) return;
  const sequenced = event as StreamSeqEvent;
  if (typeof sequenced.convId !== "string") return;
  if (typeof sequenced.streamSeq !== "number" || !Number.isFinite(sequenced.streamSeq)) return;

  const convId = sequenced.convId;
  const received = sequenced.streamSeq;
  const last = state.lastStreamSeqByConv[convId];
  const isStartSnapshot = sequenced.type === "streaming_started" && sequenced.snapshotKind === "start";
  const isCatchupSnapshot = sequenced.type === "streaming_started" && sequenced.snapshotKind === "catchup";

  // A targeted catch-up snapshot is intentionally sent with the current sequence
  // number without incrementing it, so late joiners establish a baseline without
  // making already-subscribed clients see a false gap.
  if (isCatchupSnapshot) {
    if (last === undefined || received > last) state.lastStreamSeqByConv[convId] = received;
    return;
  }

  // Each daemon stream resets at 1. If we missed the previous streaming_stopped,
  // a new start snapshot should reset the local baseline rather than look like a
  // giant backwards jump.
  if (isStartSnapshot) {
    state.lastStreamSeqByConv[convId] = received;
    return;
  }

  if (last === undefined) {
    if (received > 1) {
      log("warn", `tui: first observed stream event was not stream start ${JSON.stringify(streamSeqLogPayload(sequenced, state, {
        firstObservedSeq: received,
        missedBeforeFirstObservation: received - 1,
      }))}`);
    }
    state.lastStreamSeqByConv[convId] = received;
    return;
  }

  const expected = last + 1;
  if (received > expected) {
    log("warn", `tui: stream event sequence gap ${JSON.stringify(streamSeqLogPayload(sequenced, state, {
      previousSeq: last,
      expectedSeq: expected,
      receivedSeq: received,
      missedCount: received - expected,
    }))}`);
  } else if (received <= last) {
    log("warn", `tui: stream event sequence non-monotonic ${JSON.stringify(streamSeqLogPayload(sequenced, state, {
      previousSeq: last,
      expectedSeq: expected,
      receivedSeq: received,
    }))}`);
  }

  if (received > last) state.lastStreamSeqByConv[convId] = received;
}
