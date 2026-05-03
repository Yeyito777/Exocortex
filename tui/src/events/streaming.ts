import { log } from "../log";
import { theme } from "../theme";
import { clearPendingAI, clearStreamingTailMessages } from "../state";
import type { RenderState } from "../state";
import {
  createMessageMetadata,
  createPendingAI,
  ensureCurrentBlock,
  replacePendingStreamingTail,
  splitPendingAI,
  truncateToCompletedRounds,
} from "../messages";
import { syncChosenProvider } from "../providerselection";
import type { Event } from "../protocol";
import { removeLocalQueueEntry } from "../queue";
import { formatStreamRetryNotice, pushInlineSystemNotice, shouldReconcileInlineSystemNoticeOnStop } from "./notices";
import { hydratePendingAIFromSnapshot, markPendingAILive } from "./pending-ai";
import { fallbackProvider } from "./provider";
import {
  blockStats,
  findSnapshotAlignment,
  logStreamingRepair,
  mergeSnapshotBlocksPreservingLocalDetails,
} from "./streaming-snapshot";

function displayedAssistantBlocks(state: RenderState) {
  const blocks = [] as NonNullable<RenderState["pendingAI"]>["blocks"];
  for (const msg of state.messages) {
    if (msg.role === "assistant") blocks.push(...msg.blocks);
  }
  if (state.pendingAI) blocks.push(...state.pendingAI.blocks);
  return blocks;
}

function recentBlockSignatures(blocks: ReturnType<typeof displayedAssistantBlocks>, count = 8): string[] {
  return blocks.slice(-count).map((block) => {
    switch (block.type) {
      case "text":
      case "thinking":
        return `${block.type}:${block.text.length}`;
      case "tool_call":
        return `tool_call:${block.toolName}:${block.toolCallId}`;
      case "tool_result":
        return `tool_result:${block.toolName}:${block.toolCallId}:${block.output.length}:${block.isError ? "err" : "ok"}`;
    }
  });
}

function logOrphanToolResult(event: Extract<Event, { type: "tool_result" }>, state: RenderState): void {
  const blocks = displayedAssistantBlocks(state);
  const hasMatchingToolCall = blocks.some((block) => block.type === "tool_call" && block.toolCallId === event.toolCallId);
  if (hasMatchingToolCall) return;
  log("warn", `tui: stream tool_result without matching tool_call ${JSON.stringify({
    convId: event.convId,
    streamSeq: event.streamSeq ?? null,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    pending: state.pendingAI ? blockStats(state.pendingAI.blocks) : null,
    displayed: blockStats(blocks),
    recentBlocks: recentBlockSignatures(blocks),
  })}`);
}

export function handleStreamingStarted(event: Extract<Event, { type: "streaming_started" }>, state: RenderState): void {
  // Late-joining client: create pendingAI so future chunks are captured.
  // Original client already has pendingAI from handleSubmit.
  if (!state.pendingAI) {
    syncChosenProvider(state, event.provider ?? fallbackProvider(state));
    hydratePendingAIFromSnapshot(state, createPendingAI(event.startedAt, event.model));
  } else if (!state.pendingAI.metadata) {
    state.pendingAI.metadata = createMessageMetadata(event.startedAt, event.model);
  } else {
    state.pendingAI.metadata.startedAt = event.startedAt;
    state.pendingAI.metadata.model = event.model;
    state.pendingAI.metadata.endedAt = null;
  }
  const pending = state.pendingAI;
  if (!pending) return;
  if (pending.metadata?.startedAt !== state.suppressPendingAIMetadataStartedAt || event.snapshotKind === "start") {
    state.suppressPendingAIMetadataStartedAt = null;
  }
  // Only replace blocks when we do not already have live local state. A
  // same-conversation reload can deliver an older snapshot after newer local
  // chunks were already rendered; clobbering with that stale snapshot makes
  // already-streamed text disappear until completion. The exception is a
  // compatible strict extension: if the daemon snapshot contains all local
  // blocks plus more (commonly a missed just-started tool_call), use it to
  // repair the live tail.
  if (event.blocks) {
    const alignment = findSnapshotAlignment(pending.blocks, event.blocks);
    if (
      state.pendingAIHydratedFromSnapshot
      || pending.blocks.length === 0
      || alignment?.strictlyNewer
    ) {
      const localBlocks = [...pending.blocks];
      const localTokens = pending.metadata?.tokens;
      const wasHydratedFromSnapshot = state.pendingAIHydratedFromSnapshot;
      const mergedBlocks = mergeSnapshotBlocksPreservingLocalDetails(localBlocks, event.blocks, alignment);
      pending.blocks = mergedBlocks;
      state.pendingAIHydratedFromSnapshot = true;
      if (alignment?.strictlyNewer && localBlocks.length > 0) {
        logStreamingRepair(
          "streaming_started",
          event.convId,
          localBlocks,
          event.blocks,
          mergedBlocks,
          alignment,
          localTokens,
          event.tokens,
          wasHydratedFromSnapshot,
          { streamSeq: event.streamSeq ?? null, snapshotKind: event.snapshotKind ?? null },
        );
      }
    }
  }
  // Restore accumulated token count for late-joining clients.
  if (typeof event.tokens === "number") {
    if (state.pendingAIHydratedFromSnapshot || pending.metadata!.tokens === 0 || event.tokens >= pending.metadata!.tokens) {
      pending.metadata!.tokens = event.tokens;
    }
  }
}

export function handleBlockStart(event: Extract<Event, { type: "block_start" }>, state: RenderState): void {
  const pending = markPendingAILive(state);
  if (pending) pending.blocks.push({ type: event.blockType, text: "" });
}

export function handleTextChunk(event: Extract<Event, { type: "text_chunk" }>, state: RenderState): void {
  const pending = markPendingAILive(state);
  if (pending) {
    const block = ensureCurrentBlock(pending, "text");
    if (block.type === "text") block.text += event.text;
  }
}

export function handleThinkingChunk(event: Extract<Event, { type: "thinking_chunk" }>, state: RenderState): void {
  const pending = markPendingAILive(state);
  if (pending) {
    const block = ensureCurrentBlock(pending, "thinking");
    if (block.type === "thinking") block.text += event.text;
  }
}

export function handleStreamingSync(event: Extract<Event, { type: "streaming_sync" }>, state: RenderState): void {
  const pending = markPendingAILive(state);
  if (pending) replacePendingStreamingTail(pending, event.blocks);
}

export function handleToolCall(event: Extract<Event, { type: "tool_call" }>, state: RenderState): void {
  const pending = markPendingAILive(state);
  if (pending) {
    pending.blocks.push({
      type: "tool_call",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      summary: event.summary,
    });
  }
}

export function handleToolResult(event: Extract<Event, { type: "tool_result" }>, state: RenderState): void {
  logOrphanToolResult(event, state);
  const pending = markPendingAILive(state);
  if (pending) {
    pending.blocks.push({
      type: "tool_result",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      output: event.output,
      isError: event.isError,
    });
  }
}

export function handleTokensUpdate(event: Extract<Event, { type: "tokens_update" }>, state: RenderState): void {
  if (state.pendingAI) state.pendingAI.metadata!.tokens = event.tokens;
}

export function handleContextUpdate(event: Extract<Event, { type: "context_update" }>, state: RenderState): void {
  state.contextTokens = event.contextTokens;
}

export function handleMessageComplete(event: Extract<Event, { type: "message_complete" }>, state: RenderState): void {
  if (state.pendingAI) {
    // Use the daemon's canonical blocks — catches anything a late-joining
    // client missed during streaming.
    state.pendingAI.blocks = event.blocks;
    state.pendingAI.metadata!.endedAt = event.endedAt;
    state.pendingAI.metadata!.tokens = event.tokens;
    state.messages.push(state.pendingAI);
    clearPendingAI(state);
  }
}

export function handleStreamingStopped(event: Extract<Event, { type: "streaming_stopped" }>, state: RenderState): void {
  // On normal completion, message_complete already finalized pendingAI.
  // On abort/error, pendingAI is still live — finalize with persisted blocks.
  if (state.pendingAI) {
    const committedIndex = state.pendingAICommittedIndex;
    if (committedIndex !== null) {
      const committed = state.messages[committedIndex];
      if (committed?.role === "assistant") {
        if (event.persistedBlocks !== undefined) committed.blocks = event.persistedBlocks;
        if (state.pendingAI.metadata) {
          committed.metadata = {
            ...state.pendingAI.metadata,
            endedAt: state.pendingAI.metadata.endedAt ?? Date.now(),
          };
        }
      }
    } else {
      if (event.persistedBlocks !== undefined) {
        state.pendingAI.blocks = event.persistedBlocks;
      }
      if (state.pendingAI.blocks.length > 0) {
        state.pendingAI.metadata!.endedAt ??= Date.now();
        state.messages.push(state.pendingAI);
      }
    }
  }
  clearPendingAI(state);
  delete state.lastStreamSeqByConv[event.convId];

  // Flush user-invoked notices that were intentionally kept in the live tail.
  for (const msg of state.streamingTailMessages) {
    state.messages.push(msg);
  }
  clearStreamingTailMessages(state);
}

export function handleStreamRetry(event: Extract<Event, { type: "stream_retry" }>, state: RenderState): void {
  // Transient stream error mid-stream. Split pendingAI so completed rounds stay
  // committed, then insert the retry notice inline before the next attempt
  // continues streaming.
  if (state.pendingAI) {
    truncateToCompletedRounds(state.pendingAI);
    const finalized = splitPendingAI(state.pendingAI);
    if (finalized) state.messages.push(finalized);
  }
  pushInlineSystemNotice(state, formatStreamRetryNotice(event), theme.warning);
}

export function handleUserMessage(event: Extract<Event, { type: "user_message" }>, state: RenderState): void {
  // During streaming: split pendingAI so the user message appears inline between
  // tool rounds (after completed blocks, before new ones). This is purely for
  // visual correctness during streaming — after completion, history_updated
  // rebuilds from canonical daemon state.
  if (state.pendingAI) {
    const finalized = splitPendingAI(state.pendingAI);
    if (finalized) state.messages.push(finalized);
  }

  state.messages.push({
    role: "user",
    text: event.text,
    images: event.images,
    metadata: typeof event.startedAt === "number"
      ? createMessageMetadata(event.startedAt, state.model, { endedAt: event.startedAt })
      : null,
  });

  // Remove matching local shadow — the daemon already injected it.
  removeLocalQueueEntry(state, event.convId, event.text);

  state.scrollOffset = 0;
}

export function handleSystemMessage(event: Extract<Event, { type: "system_message" }>, state: RenderState): void {
  pushInlineSystemNotice(state, event.text, event.color, shouldReconcileInlineSystemNoticeOnStop(event));
}
