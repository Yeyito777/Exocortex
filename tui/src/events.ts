/**
 * Daemon event handler.
 *
 * Maps incoming daemon events to state mutations. The only file
 * that interprets Event payloads and updates RenderState accordingly.
 */

import type { RenderState } from "./state";
import { clearPendingAI, clearStreamingTailMessages, pushSystemMessage, resolveSystemMessageColor, resetNewConversationDefaults, resetToolOutputState, setCurrentConversationToolOutputAvailability, setLoadedConversationToolOutputState } from "./state";
import { preserveViewportAcrossHistoryMutation, toggleToolOutputPreservingViewport } from "./chatscroll";
import { DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER, ensureCurrentBlock, createMessageMetadata, createPendingAI, normalizeEffortForModel, truncateToCompletedRounds, splitPendingAI, replacePendingStreamingTail } from "./messages";
import type { AIMessage, ImageAttachment, Block } from "./messages";
import { syncChosenProvider } from "./providerselection";
import {
  focusConversationById,
  rememberEnteredConversation,
  updateConversationList,
  updateConversation,
  syncSelectedIndex,
} from "./sidebar";
import { theme } from "./theme";
import { clearLocalQueue, removeLocalQueueEntry } from "./queue";
import type { Event, DisplayEntry, SystemMessageEvent } from "./protocol";
import { log } from "./log";

// ── Display entry → TUI message conversion ─────────────────────────

/**
 * Map daemon display entries to TUI message objects and push them
 * onto state.messages.  Used by both conversation_loaded and
 * history_updated — keeps the mapping in one place.
 */
function pushDisplayEntries(state: RenderState, entries: DisplayEntry[]): void {
  for (const entry of entries) {
    switch (entry.type) {
      case "user":
        state.messages.push({ role: "user", text: entry.text, images: entry.images, metadata: entry.metadata ?? null });
        break;
      case "ai":
        state.messages.push({
          role: "assistant",
          blocks: entry.blocks,
          metadata: entry.metadata ?? null,
        });
        break;
      case "system":
        state.messages.push({ role: "system", text: entry.text, color: resolveSystemMessageColor(entry.color), metadata: null });
        break;
      case "system_instructions":
        state.messages.push({ role: "system_instructions", text: entry.text, metadata: null });
        break;
    }
  }
}

function textsCompatible(a: string, b: string): boolean {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function blocksMatch(a: Block, b: Block): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "text":
    case "thinking":
      return b.type === a.type && textsCompatible(a.text, b.text);
    case "tool_call":
      // Compact conversation loads regenerate summaries and may normalize tool
      // inputs, so the stable identity here is the tool call id.
      return b.type === "tool_call" && a.toolCallId === b.toolCallId;
    case "tool_result":
      // Compact conversation loads intentionally omit tool_result payloads, so
      // matching on output would make every reload fail to subtract completed
      // tool rounds and would duplicate them in pendingAI.
      return b.type === "tool_result"
        && a.toolCallId === b.toolCallId
        && a.isError === b.isError;
  }
}

interface SnapshotAlignment {
  pairs: Array<{ localIndex: number; snapshotIndex: number }>;
  strictlyNewer: boolean;
}

function cloneBlock(block: Block): Block {
  return structuredClone(block);
}

function toolResultOutputsCompatible(local: Extract<Block, { type: "tool_result" }>, snapshot: Extract<Block, { type: "tool_result" }>): boolean {
  return local.output === ""
    || snapshot.output === ""
    || local.output === snapshot.output
    || snapshot.output.startsWith(local.output)
    || local.output.startsWith(snapshot.output);
}

function snapshotBlockCanCoverLocal(local: Block, snapshot: Block): boolean {
  if (local.type !== snapshot.type) return false;
  switch (local.type) {
    case "text":
    case "thinking":
      return snapshot.type === local.type && snapshot.text.startsWith(local.text);
    case "tool_call":
      // Tool-call summaries/inputs may be normalized by the daemon, but the id
      // is stable. A matching daemon tool call is authoritative.
      return snapshot.type === "tool_call" && local.toolCallId === snapshot.toolCallId;
    case "tool_result":
      // Compact daemon snapshots intentionally omit historical tool output. Treat
      // an empty/shorter snapshot output as compatible so a later catch-up snapshot
      // can still repair missed blocks after the tool result; the merge step below
      // preserves the fuller local output instead of clobbering it.
      return snapshot.type === "tool_result"
        && local.toolCallId === snapshot.toolCallId
        && local.isError === snapshot.isError
        && toolResultOutputsCompatible(local, snapshot);
  }
}

function snapshotBlockStrictlyNewer(local: Block, snapshot: Block): boolean {
  if (local.type !== snapshot.type) return false;
  switch (local.type) {
    case "text":
    case "thinking":
      return snapshot.type === local.type && snapshot.text.length > local.text.length;
    case "tool_result":
      return snapshot.type === "tool_result" && snapshot.output.length > local.output.length;
    case "tool_call":
      return false;
  }
}

function findSnapshotAlignment(localBlocks: Block[], snapshotBlocks: Block[]): SnapshotAlignment | null {
  let snapshotCursor = 0;
  let strictlyNewer = false;
  const pairs: SnapshotAlignment["pairs"] = [];

  for (let localIndex = 0; localIndex < localBlocks.length; localIndex++) {
    const local = localBlocks[localIndex];
    const expectedSnapshotIndex = snapshotCursor;
    let matchedSnapshotIndex = -1;

    for (let i = snapshotCursor; i < snapshotBlocks.length; i++) {
      if (snapshotBlockCanCoverLocal(local, snapshotBlocks[i])) {
        matchedSnapshotIndex = i;
        break;
      }
    }

    if (matchedSnapshotIndex === -1) return null;
    if (matchedSnapshotIndex > expectedSnapshotIndex) strictlyNewer = true;
    if (snapshotBlockStrictlyNewer(local, snapshotBlocks[matchedSnapshotIndex])) strictlyNewer = true;
    pairs.push({ localIndex, snapshotIndex: matchedSnapshotIndex });
    snapshotCursor = matchedSnapshotIndex + 1;
  }

  if (snapshotCursor < snapshotBlocks.length) strictlyNewer = true;
  return { pairs, strictlyNewer };
}

function mergeSnapshotBlocksPreservingLocalDetails(
  localBlocks: Block[],
  snapshotBlocks: Block[],
  alignment = findSnapshotAlignment(localBlocks, snapshotBlocks),
): Block[] {
  if (!alignment) return snapshotBlocks.map(cloneBlock);

  const localBySnapshotIndex = new Map<number, Block>();
  for (const pair of alignment.pairs) {
    localBySnapshotIndex.set(pair.snapshotIndex, localBlocks[pair.localIndex]);
  }

  return snapshotBlocks.map((snapshot, snapshotIndex) => {
    const local = localBySnapshotIndex.get(snapshotIndex);
    if (local?.type === "tool_result" && snapshot.type === "tool_result") {
      const merged = cloneBlock(snapshot);
      if (merged.type === "tool_result") {
        if (local.output && (!snapshot.output || local.output.length > snapshot.output.length)) {
          merged.output = local.output;
        }
        if (!snapshot.toolName && local.toolName) merged.toolName = local.toolName;
      }
      return merged;
    }
    return cloneBlock(snapshot);
  });
}

function blockSignature(block: Block): string {
  switch (block.type) {
    case "text":
    case "thinking":
      return `${block.type}:${block.text.length}`;
    case "tool_call":
      return `tool_call:${block.toolName}:${block.toolCallId}`;
    case "tool_result":
      return `tool_result:${block.toolName}:${block.toolCallId}:${block.output.length}:${block.isError ? "err" : "ok"}`;
  }
}

function blockStats(blocks: Block[]): Record<string, unknown> {
  let textChars = 0;
  let thinkingChars = 0;
  let toolCalls = 0;
  let toolResults = 0;
  for (const block of blocks) {
    if (block.type === "text") textChars += block.text.length;
    else if (block.type === "thinking") thinkingChars += block.text.length;
    else if (block.type === "tool_call") toolCalls += 1;
    else if (block.type === "tool_result") toolResults += 1;
  }
  return {
    blocks: blocks.length,
    textChars,
    thinkingChars,
    toolCalls,
    toolResults,
    signature: blocks.map(blockSignature).join(","),
  };
}

function logStreamingRepair(
  source: string,
  convId: string | null,
  localBlocks: Block[],
  snapshotBlocks: Block[],
  mergedBlocks: Block[],
  alignment: SnapshotAlignment | null,
  localTokens: number | null | undefined,
  snapshotTokens: number | null | undefined,
  hydratedFromSnapshot: boolean,
  diagnostics: Record<string, unknown> = {},
): void {
  log("warn", `tui: streaming snapshot repaired ${JSON.stringify({
    source,
    convId,
    ...diagnostics,
    hydratedFromSnapshot,
    strictlyNewer: alignment?.strictlyNewer ?? false,
    matchedLocalBlocks: alignment?.pairs.length ?? 0,
    local: blockStats(localBlocks),
    snapshot: blockStats(snapshotBlocks),
    merged: blockStats(mergedBlocks),
    tokens: { local: localTokens ?? null, snapshot: snapshotTokens ?? null },
  })}`);
}

function subtractLoadedAssistantPrefix(localBlocks: Block[], entries: DisplayEntry[]): Block[] {
  if (localBlocks.length === 0) return [];
  let loadedAiBlocks: Block[] | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "ai") {
      loadedAiBlocks = entry.blocks;
      break;
    }
  }
  if (!loadedAiBlocks || loadedAiBlocks.length === 0) return [...localBlocks];
  if (loadedAiBlocks.length > localBlocks.length) return [...localBlocks];
  for (let i = 0; i < loadedAiBlocks.length; i++) {
    if (!blocksMatch(localBlocks[i], loadedAiBlocks[i])) return [...localBlocks];
  }
  return localBlocks.slice(loadedAiBlocks.length);
}

function clonePendingAI(msg: Pick<AIMessage, "blocks" | "metadata">): AIMessage {
  return {
    role: "assistant",
    blocks: [...msg.blocks],
    metadata: msg.metadata ? { ...msg.metadata } : null,
  };
}

function markPendingAILive(state: RenderState): AIMessage | null {
  if (!state.pendingAI) return null;
  state.pendingAIHydratedFromSnapshot = false;
  return state.pendingAI;
}

function hydratePendingAIFromSnapshot(
  state: RenderState,
  snapshot: Pick<AIMessage, "blocks" | "metadata">,
): void {
  state.pendingAI = clonePendingAI(snapshot);
  state.pendingAIHydratedFromSnapshot = true;
}

function applyToolOutputs(state: RenderState, outputs: Array<{ toolCallId: string; output: string }>): void {
  const byId = new Map(outputs.map((item) => [item.toolCallId, item.output]));
  const applyToBlocks = (blocks: Array<{ type: string; toolCallId?: string; output?: string }>) => {
    for (const block of blocks) {
      if (block.type !== "tool_result" || !block.toolCallId) continue;
      const next = byId.get(block.toolCallId);
      if (next !== undefined) block.output = next;
    }
  };

  for (const msg of state.messages) {
    if (msg.role === "assistant") applyToBlocks(msg.blocks as Array<{ type: string; toolCallId?: string; output?: string }>);
  }
  if (state.pendingAI) applyToBlocks(state.pendingAI.blocks as Array<{ type: string; toolCallId?: string; output?: string }>);
}

function fallbackProvider(state: RenderState): RenderState["provider"] {
  return state.providerRegistry[0]?.id ?? state.provider ?? DEFAULT_PROVIDER_ID;
}

function syncModelEffortSelection(state: RenderState): void {
  const provider = state.providerRegistry.find((candidate) => candidate.id === state.provider);
  const model = provider?.models.find((candidate) => candidate.id === state.model) ?? null;
  state.effort = normalizeEffortForModel(model, state.effort);
}

function pushInlineSystemNotice(
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

function formatStreamRetryNotice(event: Extract<Event, { type: "stream_retry" }>): string {
  if (event.kind === "usage_limit_reset") {
    const reset = event.resetAt != null ? ` at ${new Date(event.resetAt).toLocaleString()}` : "";
    return `${event.errorMessage} — retrying${reset}…`;
  }
  return `⟳ ${event.errorMessage} — retrying in ${event.delaySec}s (${event.attempt}/${event.maxAttempts})…`;
}

function shouldReconcileInlineSystemNoticeOnStop(event: SystemMessageEvent): boolean {
  // The daemon currently uses `system_message` both for durable stream
  // failures (timeouts, interrupts, hard errors) and for ordinary notices.
  // Only the durable failure class should claim the pending assistant slot
  // and get its final blocks reconciled when streaming_stopped arrives.
  return event.color === "error" || event.text.startsWith("✗");
}

// ── Daemon actions interface ────────────────────────────────────────
// Minimal interface so this file doesn't depend on DaemonClient.

export interface DaemonActions {
  subscribe(convId: string): void;
  unsubscribe(convId: string): void;
  sendMessage(convId: string, text: string, startedAt: number, images?: ImageAttachment[]): void;
  setSystemInstructions(convId: string, text: string): void;
  loadToolOutputs(convId: string): void;
}

// ── Conversation-scoped events ─────────────────────────────────────
// These events are silently ignored when their convId doesn't match
// the active conversation.  Centralised here so each case doesn't
// need its own guard.

const CONV_SCOPED: ReadonlySet<string> = new Set([
  "streaming_started", "block_start", "text_chunk", "thinking_chunk", "streaming_sync",
  "tool_call", "tool_result", "tokens_update", "context_update",
  "message_complete", "streaming_stopped", "user_message", "system_message",
  "stream_retry", "history_updated", "tool_outputs_loaded",
]);

const STREAM_SEQ_SCOPED: ReadonlySet<string> = new Set([
  "streaming_started", "block_start", "text_chunk", "thinking_chunk", "streaming_sync",
  "tool_call", "tool_result", "tokens_update", "context_update",
  "stream_retry", "user_message", "system_message", "history_updated",
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

function observeStreamSeq(event: Event, state: RenderState): void {
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

// ── Event handler ───────────────────────────────────────────────────

export function handleEvent(
  event: Event,
  state: RenderState,
  daemon: DaemonActions,
): void {
  // Early exit for conversation-scoped events targeting a different conversation
  if (CONV_SCOPED.has(event.type) && "convId" in event && event.convId !== state.convId) return;

  observeStreamSeq(event, state);

  switch (event.type) {
    case "conversation_created": {
      rememberEnteredConversation(state.sidebar, state.convId, event.convId);
      state.convId = event.convId;
      syncChosenProvider(state, event.provider ?? fallbackProvider(state));
      state.model = event.model ?? state.model;
      state.effort = event.effort ?? state.effort;
      state.fastMode = event.fastMode ?? state.fastMode;
      daemon.subscribe(event.convId);

      if (state.pendingSystemInstructions !== null) {
        daemon.setSystemInstructions(event.convId, state.pendingSystemInstructions);
        state.pendingSystemInstructions = null;
      }

      // If we had a pending message, send it now
      if (state.pendingSend.active && (state.pendingSend.text || state.pendingSend.images) && state.pendingAI) {
        daemon.sendMessage(event.convId, state.pendingSend.text, state.pendingAI.metadata!.startedAt, state.pendingSend.images);
        state.pendingSend.text = "";
        state.pendingSend.images = undefined;
        state.pendingSend.active = false;
      }
      break;
    }

    case "streaming_started": {
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
      if (!pending) break;
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
      break;
    }

    case "block_start": {
      const pending = markPendingAILive(state);
      if (pending) {
        pending.blocks.push({ type: event.blockType, text: "" });
      }
      break;
    }

    case "text_chunk": {
      const pending = markPendingAILive(state);
      if (pending) {
        const block = ensureCurrentBlock(pending, "text");
        if (block.type === "text") block.text += event.text;
      }
      break;
    }

    case "thinking_chunk": {
      const pending = markPendingAILive(state);
      if (pending) {
        const block = ensureCurrentBlock(pending, "thinking");
        if (block.type === "thinking") block.text += event.text;
      }
      break;
    }

    case "streaming_sync": {
      const pending = markPendingAILive(state);
      if (pending) {
        replacePendingStreamingTail(pending, event.blocks);
      }
      break;
    }

    case "tool_call": {
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
      break;
    }

    case "tool_result": {
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
      break;
    }

    case "tokens_update": {
      if (state.pendingAI) {
        state.pendingAI.metadata!.tokens = event.tokens;
      }
      break;
    }

    case "context_update": {
      state.contextTokens = event.contextTokens;
      break;
    }

    case "message_complete": {
      if (state.pendingAI) {
        // Use the daemon's canonical blocks — catches anything a late-joining
        // client missed during streaming.
        state.pendingAI.blocks = event.blocks;
        state.pendingAI.metadata!.endedAt = event.endedAt;
        state.pendingAI.metadata!.tokens = event.tokens;
        state.messages.push(state.pendingAI);
        clearPendingAI(state);
      }
      break;
    }

    case "streaming_stopped": {
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
      break;
    }

    case "error": {
      // Only show errors for the current conversation (or unscoped errors)
      if (event.convId && event.convId !== state.convId) break;
      pushSystemMessage(state, `✗ ${event.message}`, theme.error);
      break;
    }

    case "usage_update": {
      state.usageByProvider[event.provider] = event.usage;
      break;
    }

    case "token_stats": {
      state.tokenStats = event.stats;
      break;
    }

    case "conversations_list": {
      updateConversationList(state.sidebar, event.conversations);
      break;
    }

    case "conversation_updated": {
      const summary = event.summary;
      if (!summary) break;

      updateConversation(state.sidebar, summary);
      // Sync provider/model/effort if this is the active conversation
      if (summary.id === state.convId) {
        const nextProvider = summary.provider ?? fallbackProvider(state);
        const nextModel = summary.model ?? state.model;
        const providerOrModelChanged = nextProvider !== state.provider || nextModel !== state.model;
        syncChosenProvider(state, nextProvider);
        state.model = nextModel;
        state.effort = summary.effort ?? state.effort;
        state.fastMode = summary.fastMode ?? state.fastMode;
        if (providerOrModelChanged) state.contextTokens = null;
      }
      break;
    }

    case "conversation_restored": {
      const summary = event.summary;
      if (!summary) break;

      updateConversation(state.sidebar, summary);
      // Select the restored conversation in the sidebar
      focusConversationById(state.sidebar, summary.id);
      syncSelectedIndex(state.sidebar);
      break;
    }

    case "conversation_deleted": {
      // Remove from sidebar (in case another client deleted it)
      const idx = state.sidebar.conversations.findIndex(c => c.id === event.convId);
      if (idx !== -1) {
        state.sidebar.conversations.splice(idx, 1);
        syncSelectedIndex(state.sidebar);
      }
      // If this was the current conversation, clear the chat
      if (state.convId === event.convId) {
        state.convId = null;
        state.messages = [];
        clearPendingAI(state);
        delete state.lastStreamSeqByConv[event.convId];
        state.contextTokens = null;
        resetToolOutputState(state);
        resetNewConversationDefaults(state);
      }
      clearLocalQueue(state, event.convId);
      break;
    }

    case "conversation_marked": {
      const conv = state.sidebar.conversations.find(c => c.id === event.convId);
      if (conv) conv.marked = event.marked;
      break;
    }

    case "conversation_moved": {
      updateConversationList(state.sidebar, event.conversations);
      break;
    }

    case "conversation_loaded": {
      const previousConvId = state.convId;
      const preserveLivePendingAI = previousConvId === event.convId && state.pendingAI !== null;
      const preservedPendingAIBlocks = preserveLivePendingAI
        ? subtractLoadedAssistantPrefix(state.pendingAI!.blocks, event.entries)
        : [];
      const preservedPendingAI = preserveLivePendingAI && preservedPendingAIBlocks.length > 0
        ? clonePendingAI({ blocks: preservedPendingAIBlocks, metadata: state.pendingAI!.metadata })
        : null;
      // Unsubscribe from old conversation before switching
      if (previousConvId && previousConvId !== event.convId) {
        daemon.unsubscribe(previousConvId);
        delete state.lastStreamSeqByConv[previousConvId];
        // Clear stale queue shadows — the daemon owns the real queue
        // and will drain it regardless; we won't receive streaming_stopped
        // after unsubscribing, so clean up now.
        clearLocalQueue(state, previousConvId);
      }
      state.messages = [];
      clearPendingAI(state);
      clearStreamingTailMessages(state);
      rememberEnteredConversation(state.sidebar, previousConvId, event.convId);
      state.convId = event.convId;
      focusConversationById(state.sidebar, event.convId);
      syncChosenProvider(state, event.provider ?? fallbackProvider(state));
      state.model = event.model ?? state.model;
      state.effort = event.effort ?? state.effort;
      state.fastMode = event.fastMode ?? state.fastMode;
      state.scrollOffset = 0;
      state.contextTokens = event.contextTokens;
      setLoadedConversationToolOutputState(state, event.toolOutputsIncluded);

      // Entries arrive in display order — just map to TUI message types
      pushDisplayEntries(state, event.entries);

      if (preservedPendingAI) {
        const alignment = event.pendingAI
          ? findSnapshotAlignment(preservedPendingAI.blocks, event.pendingAI.blocks)
          : null;
        if (event.pendingAI && alignment?.strictlyNewer) {
          // Same-conversation reloads usually preserve local live state to avoid
          // clobbering newer chunks with an older snapshot. However, the daemon
          // snapshot may contain blocks this TUI missed while it was unfocused or
          // between load and subscribe. In that compatible-extension case, adopt
          // the daemon's fuller snapshot while preserving any full local tool
          // output omitted from the compact snapshot.
          const mergedBlocks = mergeSnapshotBlocksPreservingLocalDetails(preservedPendingAI.blocks, event.pendingAI.blocks, alignment);
          logStreamingRepair(
            "conversation_loaded",
            event.convId,
            preservedPendingAI.blocks,
            event.pendingAI.blocks,
            mergedBlocks,
            alignment,
            preservedPendingAI.metadata?.tokens,
            event.pendingAI.metadata?.tokens,
            false,
          );
          hydratePendingAIFromSnapshot(state, {
            ...event.pendingAI,
            blocks: mergedBlocks,
          });
        } else {
          state.pendingAI = preservedPendingAI;
          state.pendingAIHydratedFromSnapshot = false;
        }
      } else if (event.pendingAI) {
        hydratePendingAIFromSnapshot(state, event.pendingAI);
      }

      // Rebuild local queue shadows from daemon state
      clearLocalQueue(state, event.convId);
      if (event.queuedMessages && event.queuedMessages.length > 0) {
        for (const qm of event.queuedMessages) {
          state.queuedMessages.push({
            convId: event.convId, text: qm.text, timing: qm.timing,
            ...(qm.images?.length ? { images: qm.images } : {}),
          });
        }
      }
      break;
    }

    case "stream_retry": {
      // Transient stream error mid-stream. Split pendingAI so completed rounds
      // stay committed, then insert the retry notice inline before the next
      // attempt continues streaming.
      if (state.pendingAI) {
        truncateToCompletedRounds(state.pendingAI);
        const finalized = splitPendingAI(state.pendingAI);
        if (finalized) state.messages.push(finalized);
      }
      pushInlineSystemNotice(
        state,
        formatStreamRetryNotice(event),
        theme.warning,
      );
      break;
    }

    case "user_message": {
      // During streaming: split pendingAI so the user message appears
      // inline between tool rounds (after completed blocks, before new ones).
      // This is purely for visual correctness during streaming — after
      // completion, history_updated rebuilds from canonical daemon state.
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

      // Remove matching local shadow — the daemon already injected it
      removeLocalQueueEntry(state, event.convId, event.text);

      state.scrollOffset = 0;
      break;
    }

    case "system_message": {
      pushInlineSystemNotice(state, event.text, event.color, shouldReconcileInlineSystemNoticeOnStop(event));
      break;
    }

    case "tools_available": {
      if (Array.isArray(event.providers)) {
        state.providerRegistry = event.providers;
      }
      state.toolRegistry = Array.isArray(event.tools) ? event.tools : [];
      if (event.authByProvider) {
        state.authByProvider = event.authByProvider;
      }
      if (event.authInfoByProvider) {
        state.authInfoByProvider = event.authInfoByProvider;
      }
      state.externalToolStyles = event.externalToolStyles ?? [];
      const registry = state.providerRegistry ?? [];

      let provider = registry.find((p) => p.id === state.provider) ?? null;
      if (!state.hasChosenProvider) {
        const authenticated = registry.filter((candidate) => state.authByProvider[candidate.id]);
        if (authenticated.length === 1) {
          provider = authenticated[0];
          syncChosenProvider(state, provider.id);
          state.model = provider.defaultModel ?? DEFAULT_MODEL_BY_PROVIDER[provider.id];
        }
      }

      if (provider && state.hasChosenProvider) {
        const allowsCustomModels = provider.allowsCustomModels;
        if (!provider.models.some((m) => m.id === state.model) && !allowsCustomModels) {
          state.model = provider.defaultModel;
        }
        syncModelEffortSelection(state);
      }
      break;
    }

    case "history_updated": {
      // Context tool modified historical messages — replace committed messages
      // but preserve pendingAI (the active streaming response).
      // Flush buffered system messages — they reference pre-modification state.
      state.messages = [];
      clearStreamingTailMessages(state);
      state.contextTokens = event.contextTokens;
      setCurrentConversationToolOutputAvailability(state, event.toolOutputsIncluded);
      pushDisplayEntries(state, event.entries);
      if (state.showToolOutput && !state.toolOutputsLoaded && state.convId) {
        state.toolOutputsLoading = true;
        daemon.loadToolOutputs(state.convId);
      }
      break;
    }

    case "tool_outputs_loaded": {
      const apply = () => applyToolOutputs(state, event.outputs);
      if (state.showToolOutput) preserveViewportAcrossHistoryMutation(state, apply);
      else apply();
      state.toolOutputsLoaded = true;
      state.toolOutputsLoading = false;
      if (state.showToolOutputAfterLoad && !state.showToolOutput) {
        state.showToolOutputAfterLoad = false;
        toggleToolOutputPreservingViewport(state);
      }
      break;
    }

    case "auth_status": {
      if (event.message) {
        pushSystemMessage(state, event.message, theme.muted);
      }
      if (event.openUrl) {
        try {
          Bun.spawn(["xdg-open", event.openUrl], { stdout: "ignore", stderr: "ignore" }).unref();
        } catch {
          pushSystemMessage(state, "Could not automatically open a browser. Paste this URL into a browser instead:", theme.warning);
          pushSystemMessage(state, event.openUrl, theme.muted);
        }
      }
      break;
    }

    case "system_prompt": {
      pushSystemMessage(state, event.systemPrompt);
      break;
    }

    case "system_instructions_updated":
      // No-op — the daemon sends history_updated which rebuilds everything.
      break;

    case "llm_complete_result":
    case "ack":
    case "pong":
      break;
  }
}
