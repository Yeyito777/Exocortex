/**
 * Streaming orchestration for exocortexd.
 *
 * Wires the agent loop to the IPC layer: sets up callbacks,
 * runs the loop, handles errors/abort, flushes persistence,
 * and broadcasts events. The only file that connects agent.ts
 * to the server's event dispatch.
 */

import { log } from "./log";
import { hasConfiguredCredentials } from "./auth";
import { runAgentLoop, type AgentCallbacks, type AgentState } from "./agent";
import { buildSystemPrompt } from "./system";
import { getMaxContext, supportsImageInputs } from "./providers/registry";
import { getToolDefs, buildExecutor, summarizeTool, toolCallsRequireWatchdogPause } from "./tools/registry";
import * as convStore from "./conversations";
import type { DaemonServer, ConnectedClient } from "./server";
import { CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT, MAX_EXO_SUBAGENT_DEPTH, createStoredUserContextCheckpoint, createStoredUserMessage, historyPrefixHash, isHistoryMessage, isReplayHistoryMessage, isValidActiveContext, type ActiveContext, type StoredMessage, type ApiContentBlock, type ApiMessage, type Block } from "./messages";
import type { ContentBlock as ProviderContentBlock, StreamRetryMetadata } from "./providers/types";
import type { ImageAttachment } from "@exocortex/shared/messages";
import type { BackgroundTaskCompletion, ExocortexToolRuntime, ToolExecutionContext } from "./tools/types";
import { broadcastConversationUpdated } from "./conversation-events";
import { goalContinuationUserMessage } from "./goals";
import { createProviderTurnSession } from "./api";
import { annotateApiMessagesContextTokens, copyContextTokenAttributionsToStoredHistory } from "./context-token-attribution";
import type { StreamingStopReason } from "./protocol";
import {
  buildConversationApiContext,
  compactContextMessages,
  estimateContextTokens,
  isActiveContextCompatible,
  shouldAutoCompact,
  type CompactionReason,
} from "./context-compaction";
import { getCurrentAccountScope as getCurrentOpenAIAccountScope } from "./providers/openai/auth";
import { buildCodexWindowId } from "./providers/openai/identity";
import { setBackgroundTaskActive as setConversationBackgroundTaskActive } from "./conversation-activity";
import { acknowledgeSubagentNotification, settlePendingSubagentNotifications } from "./subagent-notifications";
import { getDaemonShutdownMode } from "./daemon-lifecycle";
import { buildHistoryUpdatedEvents } from "./history-pagination";

// ── Transcript marker helpers ──────────────────────────────────────

/**
 * Interleave status markers into a message array at the correct positions.
 * Each marker's `afterIndex` indicates how many messages should precede it.
 *
 * Example: marker at afterIndex=6 goes between messages[5] and messages[6].
 *
 * Markers must be sorted by afterIndex (ascending). This holds naturally
 * since they're appended chronologically and completed-round counts are
 * monotonically non-decreasing.
 */
interface TranscriptMarker {
  afterIndex: number;
  message: StoredMessage;
}

function formatRetryNotice(
  attempt: number,
  maxAttempts: number,
  errorMessage: string,
  delaySec: number,
  metadata?: StreamRetryMetadata,
): string {
  if (metadata?.kind === "usage_limit_reset") {
    const reset = metadata.resetAt != null ? ` at ${new Date(metadata.resetAt).toLocaleString()}` : "";
    return `${errorMessage} — retrying${reset}…`;
  }
  if (delaySec <= 0) {
    return `⟳ ${errorMessage} — retrying (${attempt}/${maxAttempts})…`;
  }
  return `⟳ ${errorMessage} — retrying in ${delaySec}s (${attempt}/${maxAttempts})…`;
}

function interleaveTranscriptMarkers(
  messages: StoredMessage[],
  markers: TranscriptMarker[],
): StoredMessage[] {
  if (markers.length === 0) return messages;
  const result: StoredMessage[] = [];
  let mi = 0;
  for (let i = 0; i < messages.length; i++) {
    while (mi < markers.length && markers[mi].afterIndex <= i) {
      result.push(markers[mi].message);
      mi++;
    }
    result.push(messages[i]);
  }
  // Trailing markers (after all messages)
  while (mi < markers.length) {
    result.push(markers[mi].message);
    mi++;
  }
  return result;
}

const STREAMING_SNAPSHOT_INTERVAL_MS = 5_000;

// ── Types ──────────────────────────────────────────────────────────

export interface OrchestrationCallbacks {
  /** Called with response headers (for usage/rate-limit parsing). */
  onHeaders(headers: Headers): void;
  /** Called after the message completes (for usage refresh). */
  onComplete(): void;
  /** Native current-daemon operations exposed to the model-facing exo tool. */
  exocortex?: ExocortexToolRuntime;
  /** Deliver completion of a detached tool process to its owning conversation. */
  onBackgroundTaskComplete?: (completion: BackgroundTaskCompletion) => void;
}

// ── Message history/replay helpers ─────────────────────────────────

/** Convert API messages to stored-message shape for transient display state. */
function toStoredMessages(messages: import("./messages").ApiMessage[]): StoredMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    metadata: m.metadata ?? null,
    providerData: m.providerData,
    contextTokens: m.contextTokens ?? null,
    ...(m.contextCheckpoint ? { contextCheckpoint: m.contextCheckpoint } : {}),
  }));
}

function hasReplayableHistory(messages: StoredMessage[]): boolean {
  return messages.some(isHistoryMessage);
}

/**
 * Whether a partially streamed thinking block is safe to persist on abort/error.
 *
 * Empty thinking blocks are junk on replay; non-empty reasoning summaries are
 * worth preserving even when the provider does not attach transport metadata.
 */
function isPersistableThinkingBlock(block: Extract<ApiContentBlock, { type: "thinking" }>): boolean {
  return Boolean(block.thinking && (block.signature || block.thinking.trim().length > 0));
}

// ── Orchestrate assistant turns ────────────────────────────────────

export interface AssistantTurnOutcome {
  ok: boolean;
  blocks: Block[];
  tokens: number;
  durationMs: number;
  endedAt: number;
  error?: string;
  aborted?: boolean;
  watchdog?: boolean;
  /** The abort intentionally handed this stream to restart recovery. */
  daemonRestart?: boolean;
}

interface AssistantTurnOptions {
  userMessage?: {
    text: string;
    images?: ImageAttachment[];
  };
  goalContinuation?: boolean;
  /**
   * Explicitly install a delegation budget for this turn. Omission inherits the
   * conversation's persisted budget for automatic replay/goal continuations.
   */
  subagentMaxDepth?: number | null;
  /** Durable detached-child notification accepted by this user turn. */
  subagentNotificationId?: string;
}

export type SubagentTurnPolicy = Pick<AssistantTurnOptions, "subagentMaxDepth" | "subagentNotificationId">;

export async function orchestrateSendMessage(
  server: DaemonServer,
  client: ConnectedClient | null,
  reqId: string | undefined,
  convId: string,
  text: string,
  startedAt: number,
  ext: OrchestrationCallbacks,
  images?: ImageAttachment[],
  policy: SubagentTurnPolicy = {},
): Promise<AssistantTurnOutcome> {
  return await orchestrateAssistantTurn(server, client, reqId, convId, startedAt, ext, {
    ...policy,
    userMessage: { text, images },
  });
}

export async function orchestrateReplayConversation(
  server: DaemonServer,
  client: ConnectedClient | null,
  reqId: string | undefined,
  convId: string,
  startedAt: number,
  ext: OrchestrationCallbacks,
  policy: SubagentTurnPolicy = {},
): Promise<AssistantTurnOutcome> {
  return await orchestrateAssistantTurn(server, client, reqId, convId, startedAt, ext, policy);
}

export async function orchestrateGoalContinuation(
  server: DaemonServer,
  convId: string,
  ext: OrchestrationCallbacks,
  policy: SubagentTurnPolicy = {},
): Promise<AssistantTurnOutcome> {
  return await orchestrateAssistantTurn(server, null, undefined, convId, Date.now(), ext, {
    ...policy,
    goalContinuation: true,
  });
}

async function orchestrateAssistantTurn(
  server: DaemonServer,
  client: ConnectedClient | null,
  reqId: string | undefined,
  convId: string,
  startedAt: number,
  ext: OrchestrationCallbacks,
  options: AssistantTurnOptions = {},
): Promise<AssistantTurnOutcome> {
  const conv = convStore.get(convId);
  if (!conv) {
    const message = `Conversation ${convId} not found`;
    if (client) server.sendTo(client, { type: "error", reqId, convId, message });
    return { ok: false, blocks: [], tokens: 0, durationMs: 0, endedAt: Date.now(), error: message };
  }
  const liveConv = conv;

  if (Object.prototype.hasOwnProperty.call(options, "subagentMaxDepth")) {
    const requestedDepth = options.subagentMaxDepth;
    conv.subagentMaxDepth = typeof requestedDepth === "number"
      && Number.isInteger(requestedDepth)
      && requestedDepth >= 0
      && requestedDepth <= MAX_EXO_SUBAGENT_DEPTH
      ? requestedDepth
      : null;
  }
  const subagentMaxDepth = conv.subagentMaxDepth ?? null;

  const { userMessage: requestedUserMessage, goalContinuation = false } = options;
  // Goal continuations are daemon-authored notification turns, just like
  // background-task and subagent completion notifications. Persist and
  // broadcast them through the ordinary user-message path so the TUI shows
  // the prompt instead of keeping it as provider-only synthetic context.
  const userMessage = goalContinuation && conv.goal?.status === "active"
    ? { text: goalContinuationUserMessage(conv.goal) }
    : requestedUserMessage;
  const replaying = !userMessage;

  // ── Preflight/error helpers ───────────────────────────────────────

  const buildErrorOutcome = (message: string): AssistantTurnOutcome => ({
    ok: false,
    blocks: [],
    tokens: 0,
    durationMs: Date.now() - startedAt,
    endedAt: Date.now(),
    error: message,
  });

  const reportSendError = (message: string): AssistantTurnOutcome => {
    if (client) {
      server.sendTo(client, { type: "error", reqId, convId, message });
      return buildErrorOutcome(message);
    }

    const text = `✗ ${message}`;
    conv.messages.push({ role: "system", content: text, metadata: null });
    conv.updatedAt = Date.now();
    convStore.bumpToTop(convId);
    convStore.flush(convId);
    broadcastConversationUpdated(server, convId);
    server.sendToSubscribers(convId, { type: "system_message", convId, text, color: "error" });
    return buildErrorOutcome(text);
  };

  const shutdownModeAtStart = getDaemonShutdownMode();
  if (shutdownModeAtStart) {
    const message = `Daemon is shutting down (${shutdownModeAtStart}); refusing to start another turn.`;
    if (client) server.sendTo(client, { type: "error", reqId, convId, message });
    return buildErrorOutcome(message);
  }

  if (!hasConfiguredCredentials(conv.provider)) {
    const message = `Not authenticated for provider ${conv.provider}. Run: bun run src/main.ts login ${conv.provider}`;
    if (client) server.sendTo(client, {
      type: "error",
      reqId,
      convId,
      message,
    });
    return buildErrorOutcome(message);
  }
  if (convStore.isStreaming(convId)) {
    const message = "Already streaming";
    if (client) server.sendTo(client, { type: "error", reqId, convId, message });
    return buildErrorOutcome(message);
  }
  if (userMessage?.images?.length && !supportsImageInputs(conv.provider, conv.model)) {
    return reportSendError(`Image inputs are not supported by ${conv.provider}/${conv.model}. Remove the attachment or switch to a vision-capable model.`);
  }
  if (replaying && !goalContinuation && !hasReplayableHistory(conv.messages)) {
    return reportSendError("No conversation history to replay.");
  }

  if (goalContinuation && conv.goal?.status !== "active") {
    return buildErrorOutcome("No active goal to continue.");
  }
  const hadGoalAtStart = !!conv.goal;

  // ── Start stream and broadcast initial state ──────────────────────

  if (userMessage) {
    const contextCheckpoint = createStoredUserContextCheckpoint(conv);
    conv.messages.push(createStoredUserMessage(userMessage.text, conv.model, startedAt, userMessage.images, {
      subagentNotificationId: options.subagentNotificationId,
      contextCheckpoint,
    }));

    // Notify subscribers about the user message.
    // When client is set, it already added the message locally — skip it.
    // When client is null (daemon-initiated, e.g. queued message drain), notify everyone.
    if (client) {
      server.sendToSubscribersExcept(convId, {
        type: "user_message",
        convId,
        text: userMessage.text,
        startedAt,
        images: userMessage.images,
      }, client);
    } else {
      server.sendToSubscribers(convId, {
        type: "user_message",
        convId,
        text: userMessage.text,
        startedAt,
        images: userMessage.images,
      });
    }
  }
  const turnTranscriptAnchor = conv.messages.at(-1);
  const initialTurnTranscriptStartIndex = conv.messages.length;

  function currentTurnTranscriptStartIndex(): number {
    if (turnTranscriptAnchor) {
      const anchorIndex = liveConv.messages.indexOf(turnTranscriptAnchor);
      if (anchorIndex >= 0) return anchorIndex + 1;
    }
    return Math.min(initialTurnTranscriptStartIndex, liveConv.messages.length);
  }

  conv.updatedAt = Date.now();
  convStore.bumpToTop(convId);
  // Persist the user turn before any potentially long pre-turn compaction.
  // A daemon crash before the first streamed block must not lose visible chat.
  convStore.markDirty(convId);
  convStore.flush(convId);
  if (options.subagentNotificationId) acknowledgeSubagentNotification(options.subagentNotificationId);

  const ac = new AbortController();
  convStore.setActiveJob(convId, ac, startedAt);
  convStore.initStreamingState(convId);

  // Broadcast sidebar update (streaming indicator)
  broadcastConversationUpdated(server, convId);
  server.sendToSubscribers(convId, {
    type: "streaming_started",
    convId,
    provider: conv.provider,
    model: conv.model,
    streamSeq: convStore.nextStreamSeq(convId),
    snapshotKind: "start",
    startedAt,
  });

  // Goal-specific content belongs in the synthetic user turn below. Keeping it
  // out of the system prompt preserves the stable prefix used by prompt caches.
  const systemInstructionsText = convStore.getEffectiveSystemInstructions(convId);

  // The visible transcript remains append-only. Provider replay may start from
  // a compact checkpoint and append only the transcript tail written since it.
  if (conv.activeContext && !isValidActiveContext(conv.activeContext, conv.messages)) {
    log("warn", `orchestrator: discarded invalid active context for ${convId}; replaying the complete transcript`);
    conv.activeContext = null;
    conv.lastContextTokens = null;
    convStore.markDirty(convId);
    convStore.flush(convId);
  }
  const accountScope = conv.provider === "openai" ? getCurrentOpenAIAccountScope() ?? undefined : undefined;
  const initialContext = buildConversationApiContext(conv, accountScope);
  let apiMessages: ApiMessage[] = initialContext.messages;

  // Track whether any next-turn messages were injected mid-stream.
  // When true, the success path sends history_updated so the TUI
  // rebuilds its display with correct interleaving.
  let hadNextTurnInjections = false;

  // Status markers are tracked with their position (number of completed
  // messages at the time) so retries and compaction boundaries remain in
  // chronological order in both live snapshots and persisted history.
  const transcriptMarkers: TranscriptMarker[] = [];

  const toolContext: ToolExecutionContext = {
    provider: conv.provider,
    conversationId: convId,
    subagentMaxDepth,
    model: conv.model,
    exocortex: ext.exocortex,
    setBackgroundTaskActive: (taskId, active, details) => {
      if (setConversationBackgroundTaskActive(convId, taskId, active, details)) {
        broadcastConversationUpdated(server, convId);
      }
    },
    onBackgroundTaskComplete: ext.onBackgroundTaskComplete,
    registerBackgrounder: (backgrounder) => {
      if (backgrounder) convStore.setActiveToolBackgrounder(convId, backgrounder);
      else convStore.clearActiveToolBackgrounder(convId);
    },
  };

  // ── Streaming runtime state ───────────────────────────────────────

  // Agent state for abort recovery — the agent populates completedMessages
  // after each full round. partialContent tracks the in-flight round only
  // (cleared via onRoundComplete between rounds).
  const agentState: AgentState = {
    completedMessages: [],
    completedBlocks: [],
    contextMessages: [...apiMessages],
    contextCompacted: false,
    tokens: 0,
  };
  const partialContent: import("./messages").ApiContentBlock[] = [];
  /** Blocks that survived persistence on abort/error — sent to TUI so it can trim display. */
  let abortPersistedBlocks: import("./messages").Block[] | undefined;
  let outcome: AssistantTurnOutcome | undefined;
  let streamingSnapshotTimer: ReturnType<typeof setInterval> | null = null;

  // One provider turn session spans pre-turn compaction and every subsequent
  // model/tool round. OpenAI can therefore append compaction_trigger as an
  // incremental item, then safely falls back to full replay of the checkpoint.
  const providerTurnSession = createProviderTurnSession(conv.provider);
  const codexTurnId = `${convId}:${startedAt}`;
  // Delegation depth stays in daemon-owned turn metadata/tool context. Keeping
  // it out of the prompt preserves the stable prefix used by provider caches.
  const systemPrompt = buildSystemPrompt({
    conversationInstructions: systemInstructionsText || undefined,
    conversationId: convId,
  });
  const toolDefs = getToolDefs();
  const contextLimit = getMaxContext(conv.provider, conv.model);
  const startingCompactionCount = conv.activeContext?.compactionCount ?? 0;
  let currentWindowNumber = conv.activeContext?.windowNumber ?? 0;
  let currentWindowId = conv.activeContext?.windowId ?? buildCodexWindowId(convId);
  let compactionsThisTurn = 0;
  let latestCompactionKind: ActiveContext["kind"] | null = null;
  let latestCompactionAccountScope: string | undefined;
  let latestCompactedAt: number | null = null;

  async function performAutomaticCompaction(
    messages: ApiMessage[],
    reason: CompactionReason,
    projectedTokens: number,
  ): Promise<ApiMessage[]> {
    convStore.pauseActivity(convId);
    let nativeStatusActive = false;
    const stopNativeStatus = () => {
      if (!nativeStatusActive) return;
      nativeStatusActive = false;
      setContextCompactionStatus(false);
    };
    try {
      log("info", `orchestrator: automatic context compaction starting for ${convId} (reason=${reason}, projected=${Number.isFinite(projectedTokens) ? projectedTokens : "overflow"}, limit=${contextLimit ?? "unknown"})`);
      if (liveConv.provider === "openai") {
        nativeStatusActive = true;
        setContextCompactionStatus(true);
      }
      const result = await compactContextMessages(messages, {
        provider: liveConv.provider,
        model: liveConv.model,
        system: systemPrompt,
        signal: ac.signal,
        tools: toolDefs,
        effort: liveConv.effort,
        serviceTier: liveConv.fastMode ? "fast" : undefined,
        promptCacheKey: convId,
        tracking: { source: "context_compaction", conversationId: convId },
        turnSession: providerTurnSession ?? undefined,
        contextLimit,
        accountScope,
        codexWindowId: currentWindowId,
        codexTurnId,
        codexTurnStartedAtMs: startedAt,
        reason,
        onHeaders: ext.onHeaders,
        onNativeRetry: (attempt, maxAttempts, errorMessage, delaySec, metadata) => {
          recordStreamRetry(attempt, maxAttempts, errorMessage, delaySec, metadata, true);
        },
        onPlaintextFallback: (warning) => {
          // Plaintext fallback intentionally has no progress UI of its own.
          stopNativeStatus();
          transcriptMarkers.push({
            afterIndex: agentState.completedMessages.length,
            message: { role: "system", content: warning, metadata: null },
          });
          // The warning describes a semantic context transition. Persist it
          // before starting the potentially long plaintext summary so a crash
          // cannot make that transition invisible in the canonical transcript.
          persistCompletedTurnPrefix();
          syncCompletedStreamingDisplayMessages();
          server.sendToSubscribers(convId, {
            type: "system_message",
            convId,
            streamSeq: convStore.nextStreamSeq(convId),
            text: warning,
            color: "warning",
          });
        },
      });
      // Session invalidation is part of the atomic install. If it fails, leave
      // the previous active replay/counters untouched and recover from transcript.
      await providerTurnSession?.resetAfterCompaction?.();
      compactionsThisTurn += 1;
      latestCompactionKind = result.kind;
      latestCompactionAccountScope = result.accountScope;
      const completedAt = Date.now();
      latestCompactedAt = completedAt;
      currentWindowNumber += 1;
      currentWindowId = `${convId}:${currentWindowNumber}`;
      liveConv.lastContextTokens = null;
      transcriptMarkers.push({
        afterIndex: agentState.completedMessages.length,
        message: {
          role: "system",
          content: CONTEXT_COMPACTION_FINISHED_TEXT,
          metadata: {
            startedAt: completedAt,
            endedAt: completedAt,
            model: liveConv.model,
            tokens: 0,
            kind: CONTEXT_COMPACTION_FINISHED_KIND,
          },
        },
      });
      // Make the successful boundary durable before the next provider request,
      // together with the replay it identifies, then replace the spinner with
      // the matching live divider.
      syncActiveContext(result.messages);
      persistCompletedTurnPrefix();
      syncCompletedStreamingDisplayMessages();
      nativeStatusActive = false;
      setContextCompactionStatus(false, completedAt);
      log("info", `orchestrator: automatic context compaction complete for ${convId} (kind=${result.kind}, messages=${messages.length}->${result.messages.length})`);
      return result.messages;
    } finally {
      stopNativeStatus();
      convStore.resumeActivity(convId);
    }
  }

  function syncActiveContext(messages: ApiMessage[]): void {
    const previous = liveConv.activeContext;
    // activeContext is the immutable output of the latest compaction, not a
    // second copy of all later turns. Ordinary success/abort paths call this
    // helper too, but their canonical transcript tail is replayed directly by
    // buildConversationApiContext and must not overwrite the rewind base.
    const installingNewCompaction = compactionsThisTurn > 0
      && previous?.windowId !== currentWindowId;
    if (!installingNewCompaction) return;
    const checkpointAccountScope = compactionsThisTurn > 0
      ? latestCompactionAccountScope
      : previous?.accountScope ?? accountScope;
    const transcriptHistoryCount = liveConv.messages.filter(isReplayHistoryMessage).length;
    liveConv.activeContext = {
      version: 1,
      kind: latestCompactionKind ?? previous!.kind,
      provider: liveConv.provider,
      model: liveConv.model,
      ...(checkpointAccountScope ? { accountScope: checkpointAccountScope } : {}),
      messages: structuredClone(messages),
      transcriptHistoryCount,
      transcriptPrefixHash: historyPrefixHash(liveConv.messages, transcriptHistoryCount),
      compactionHistoryCount: transcriptHistoryCount,
      compactionPrefixHash: historyPrefixHash(liveConv.messages, transcriptHistoryCount),
      windowId: currentWindowId,
      windowNumber: currentWindowNumber,
      compactedAt: latestCompactedAt ?? previous!.compactedAt,
      compactionCount: startingCompactionCount + compactionsThisTurn,
    };
  }

  function completedDisplayMessages(): StoredMessage[] {
    return toStoredMessages(agentState.completedMessages);
  }

  function syncStreamingDisplayMessages(messages: StoredMessage[]): void {
    convStore.replaceStreamingDisplayMessages(convId, interleaveTranscriptMarkers(messages, transcriptMarkers));
  }

  function syncCompletedStreamingDisplayMessages(): void {
    syncStreamingDisplayMessages(completedDisplayMessages());
  }

  function persistCompletedTurnPrefix(additionalMessages: StoredMessage[] = []): void {
    const completed = [
      ...interleaveTranscriptMarkers(completedDisplayMessages(), transcriptMarkers),
      ...additionalMessages,
    ];
    const turnTranscriptStartIndex = currentTurnTranscriptStartIndex();
    liveConv.messages.splice(
      turnTranscriptStartIndex,
      liveConv.messages.length - turnTranscriptStartIndex,
      ...completed,
    );
    liveConv.updatedAt = Date.now();
    convStore.markDirty(convId);
    convStore.flush(convId);
  }

  function setContextCompactionStatus(active: boolean, completedAt?: number): void {
    const compactionStartedAt = active ? Date.now() : null;
    convStore.setContextCompactionStartedAt(convId, compactionStartedAt);
    server.sendToSubscribers(convId, {
      type: "context_compaction_status",
      convId,
      streamSeq: convStore.nextStreamSeq(convId),
      active,
      ...(compactionStartedAt != null ? { startedAt: compactionStartedAt } : {}),
      ...(completedAt != null ? { completedAt } : {}),
    });
  }

  function recordStreamRetry(
    attempt: number,
    maxAttempts: number,
    errorMessage: string,
    delaySec: number,
    metadata?: StreamRetryMetadata,
    persistImmediately = false,
  ): void {
    convStore.touchActivity(convId);
    // Provider retry → clear partial state so the retry starts clean.
    // Completed rounds stay visible via streamingDisplayMessages.
    partialContent.length = 0;
    convStore.initStreamingState(convId);
    convStore.setStreamingCommittedBlockCount(convId, agentState.completedBlocks.length);
    const sysText = formatRetryNotice(attempt, maxAttempts, errorMessage, delaySec, metadata);
    transcriptMarkers.push({
      afterIndex: agentState.completedMessages.length,
      message: { role: "system", content: sysText, metadata: null },
    });
    if (persistImmediately) persistCompletedTurnPrefix();
    syncCompletedStreamingDisplayMessages();
    server.sendToSubscribers(convId, {
      type: "stream_retry",
      convId,
      streamSeq: convStore.nextStreamSeq(convId),
      attempt,
      maxAttempts,
      errorMessage,
      delaySec,
      ...(metadata?.kind ? { kind: metadata.kind } : {}),
      ...(metadata?.resetAt != null ? { resetAt: metadata.resetAt } : {}),
    });
  }

  function sendStreamingSnapshot(): void {
    if (!server.hasSubscribers(convId) || !convStore.isStreaming(convId)) return;
    const snapshot = convStore.getRenderSnapshot(convId, false);
    const pendingAI = snapshot?.pendingAI;
    if (!snapshot || !pendingAI) return;

    server.sendToSubscribers(convId, {
      type: "streaming_started",
      convId,
      provider: snapshot.provider,
      model: snapshot.model,
      streamSeq: convStore.nextStreamSeq(convId),
      snapshotKind: "heartbeat",
      startedAt: pendingAI.metadata?.startedAt ?? startedAt,
      blocks: pendingAI.blocks,
      blockOffset: pendingAI.blockOffset,
      tokens: pendingAI.metadata?.tokens ?? 0,
      compactionStartedAt: convStore.getContextCompactionStartedAt(convId) ?? null,
    });
  }

  function startStreamingSnapshotHeartbeat(): void {
    if (streamingSnapshotTimer) return;
    streamingSnapshotTimer = setInterval(sendStreamingSnapshot, STREAMING_SNAPSHOT_INTERVAL_MS);
    if (typeof streamingSnapshotTimer === "object" && "unref" in streamingSnapshotTimer) {
      (streamingSnapshotTimer as { unref(): void }).unref();
    }
  }

  function stopStreamingSnapshotHeartbeat(): void {
    if (!streamingSnapshotTimer) return;
    clearInterval(streamingSnapshotTimer);
    streamingSnapshotTimer = null;
  }

  function ensurePartialContentTail(type: "text" | "thinking"): ApiContentBlock {
    const last = partialContent[partialContent.length - 1];
    if (type === "text") {
      if (last?.type === "text") return last;
      const block: ApiContentBlock = { type: "text", text: "" };
      partialContent.push(block);
      return block;
    }
    if (last?.type === "thinking") return last;
    const block: ApiContentBlock = { type: "thinking", thinking: "", signature: "" };
    partialContent.push(block);
    return block;
  }

  function replacePartialContentFromBlocks(blocks: ProviderContentBlock[]): void {
    partialContent.length = 0;
    for (const block of blocks) {
      if (block.type === "thinking") {
        partialContent.push({ type: "thinking", thinking: block.text, signature: block.signature });
      } else if (block.type === "text") {
        partialContent.push({ type: "text", text: block.text });
      }
    }
  }

  function toStreamingSyncBlocks(blocks: ProviderContentBlock[]): Array<{ type: "text" | "thinking"; text: string }> {
    return blocks
      .filter((block): block is Extract<ProviderContentBlock, { type: "text" | "thinking" }> => block.type === "text" || block.type === "thinking")
      .map((block) => ({ type: block.type, text: block.text }));
  }

  // ── Agent callbacks: stream events and live display state ─────────

  const callbacks: AgentCallbacks = {
    onBlockStart(blockType) {
      convStore.touchActivity(convId);
      server.sendToSubscribers(convId, { type: "block_start", convId, streamSeq: convStore.nextStreamSeq(convId), blockType });
      if (blockType === "text") {
        partialContent.push({ type: "text", text: "" });
      } else if (blockType === "thinking") {
        partialContent.push({ type: "thinking", thinking: "", signature: "" });
      }
      // Track for late-joining clients
      convStore.pushStreamingBlock(convId, { type: blockType, text: "" });
      convStore.markDirty(convId);
      convStore.flush(convId);
      convStore.resetChunkCounter(convId);
    },
    onTextChunk(chunk) {
      server.sendToSubscribers(convId, { type: "text_chunk", convId, streamSeq: convStore.nextStreamSeq(convId), text: chunk });
      const block = ensurePartialContentTail("text");
      if (block.type === "text") block.text += chunk;
      convStore.appendToStreamingBlock(convId, "text", chunk);
      // touchActivity piggybacks on the chunk counter — fires every CHUNK_SAVE_INTERVAL
      // chunks rather than on every single SSE event, keeping overhead negligible.
      if (convStore.onChunk(convId)) convStore.touchActivity(convId);
    },
    onThinkingChunk(chunk) {
      server.sendToSubscribers(convId, { type: "thinking_chunk", convId, streamSeq: convStore.nextStreamSeq(convId), text: chunk });
      const block = ensurePartialContentTail("thinking");
      if (block.type === "thinking") block.thinking += chunk;
      convStore.appendToStreamingBlock(convId, "thinking", chunk);
      if (convStore.onChunk(convId)) convStore.touchActivity(convId);
    },
    onBlocksUpdate(blocks) {
      const syncedBlocks = toStreamingSyncBlocks(blocks);
      convStore.touchActivity(convId);
      replacePartialContentFromBlocks(blocks);
      convStore.replaceCurrentStreamingBlocks(convId, syncedBlocks);
      server.sendToSubscribers(convId, { type: "streaming_sync", convId, streamSeq: convStore.nextStreamSeq(convId), blocks: syncedBlocks });
    },
    onSignature(signature) {
      for (let i = partialContent.length - 1; i >= 0; i--) {
        if (partialContent[i].type === "thinking") {
          (partialContent[i] as { type: "thinking"; thinking: string; signature: string }).signature = signature;
          break;
        }
      }
    },
    onToolCall(block) {
      convStore.touchActivity(convId);
      server.sendToSubscribers(convId, {
        type: "tool_call", convId,
        streamSeq: convStore.nextStreamSeq(convId),
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        input: block.input,
        summary: block.summary,
      });
      convStore.pushStreamingBlock(convId, {
        type: "tool_call",
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        input: block.input,
        summary: block.summary,
      });
    },
    onToolResult(block) {
      convStore.touchActivity(convId);
      server.sendToSubscribers(convId, {
        type: "tool_result", convId,
        streamSeq: convStore.nextStreamSeq(convId),
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        output: block.output,
        isError: block.isError,
      });
      convStore.pushStreamingBlock(convId, {
        type: "tool_result",
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        output: block.output,
        isError: block.isError,
      });
    },
    onTokensUpdate(tokens) {
      convStore.setStreamingTokens(convId, tokens);
      server.sendToSubscribers(convId, { type: "tokens_update", convId, streamSeq: convStore.nextStreamSeq(convId), tokens });
    },
    onContextUpdate(contextTokens, inputMessages) {
      conv.lastContextTokens = contextTokens;
      if (inputMessages) {
        annotateApiMessagesContextTokens(inputMessages, contextTokens, conv.provider, conv.model);
        // Once a checkpoint exists, inputMessages is a compact replay rather
        // than a positional mirror of the visible transcript.
        const copied = !conv.activeContext && compactionsThisTurn === 0
          ? copyContextTokenAttributionsToStoredHistory(conv.messages, inputMessages)
          : 0;
        if (copied > 0) convStore.markDirty(convId);
        log("info", `orchestrator: context token attribution updated for ${copied} persisted history turns (provider=${conv.provider}, model=${conv.model}, total=${contextTokens}, compactReplay=${Boolean(conv.activeContext || compactionsThisTurn > 0)})`);
      }
      server.sendToSubscribers(convId, { type: "context_update", convId, streamSeq: convStore.nextStreamSeq(convId), contextTokens });
    },
    onHeaders(headers) {
      convStore.touchActivity(convId);
      ext.onHeaders(headers);
    },
    onRetry(attempt, maxAttempts, errorMessage, delaySec, metadata) {
      recordStreamRetry(attempt, maxAttempts, errorMessage, delaySec, metadata);
    },
    onRetryWaitStart() {
      convStore.pauseActivity(convId);
    },
    onRetryWaitEnd() {
      convStore.resumeActivity(convId);
    },
    onRoundComplete() {
      // Clear partial content — completed rounds are tracked via agentState.completedMessages.
      // Without this, partialContent accumulates across rounds and abort would double-persist.
      partialContent.length = 0;
      convStore.clearCurrentStreamingBlocks(convId);
      syncCompletedStreamingDisplayMessages();
      convStore.setStreamingCommittedBlockCount(convId, agentState.completedBlocks.length);
      // Persist the structurally complete tool-call/result prefix before any
      // potentially long mid-turn compaction or next provider request.
      persistCompletedTurnPrefix();
    },
    drainNextTurnMessages() {
      const drained = convStore.drainQueuedMessages(convId, "next-turn");
      if (drained.length === 0) return [];

      hadNextTurnInjections = true;
      const apiMsgs: import("./messages").ApiMessage[] = [];
      const injectedStored: StoredMessage[] = [];
      // Multiple queued prompts can be accepted in one drain. Build each rewind
      // cursor against the preceding accepted prompt, even though persistence is
      // intentionally batched below.
      const checkpointTranscript = [...liveConv.messages];
      let checkpointContextTokens = Math.max(
        liveConv.lastContextTokens ?? 0,
        estimateContextTokens(agentState.contextMessages, liveConv.provider),
      );
      for (const qm of drained) {
        const injectedStartedAt = Date.now();
        const contextCheckpoint = createStoredUserContextCheckpoint(
          liveConv,
          checkpointTranscript,
          checkpointContextTokens,
        );
        const storedUser = createStoredUserMessage(qm.text, conv.model, injectedStartedAt, qm.images, {
          subagentNotificationId: qm.subagentNotificationId,
          contextCheckpoint,
        });
        apiMsgs.push({
          role: "user",
          content: storedUser.content,
          metadata: storedUser.metadata,
          contextCheckpoint: storedUser.contextCheckpoint,
        });
        injectedStored.push(storedUser);
        checkpointTranscript.push(storedUser);
        checkpointContextTokens += estimateContextTokens([apiMsgs.at(-1)!], liveConv.provider);
        log("info", `orchestrator: injected next-turn message: "${qm.text.slice(0, 50)}"`);
      }

      // Draining removes the only queue copy. Commit the accepted user prompts
      // to the canonical transcript before broadcasting them or returning to the
      // agent; a process kill at any subsequent instruction must not lose them.
      persistCompletedTurnPrefix(injectedStored);
      for (const qm of drained) {
        if (qm.subagentNotificationId) acknowledgeSubagentNotification(qm.subagentNotificationId);
      }
      for (let index = 0; index < drained.length; index++) {
        const qm = drained[index];
        const storedUser = injectedStored[index];
        server.sendToSubscribers(convId, {
          type: "user_message",
          convId,
          streamSeq: convStore.nextStreamSeq(convId),
          text: qm.text,
          startedAt: storedUser.metadata?.startedAt ?? Date.now(),
          images: qm.images,
        });
      }
      syncStreamingDisplayMessages([...toStoredMessages(agentState.completedMessages), ...injectedStored]);
      return apiMsgs;
    },
    onRecoveryStateUpdate() {
      // The agent invokes this again after queued next-turn messages have been
      // folded into completedMessages, closing the crash window before compact.
      persistCompletedTurnPrefix();
    },
    async compactContext(messages, reason, projectedTokens) {
      return performAutomaticCompaction(messages, reason, projectedTokens);
    },
  };

  // ── Tool executor wrapper ─────────────────────────────────────────

  // Bounded tools retain the stream watchdog as a second line of defense.
  // Pause it only for tools such as bash that intentionally own a separate
  // long-running/background lifecycle.
  const rawExecutor = buildExecutor(toolContext);
  const executor: typeof rawExecutor = async (calls, signal?) => {
    const pauseWatchdog = toolCallsRequireWatchdogPause(calls);
    if (pauseWatchdog) convStore.pauseActivity(convId);
    try {
      return await rawExecutor(calls, signal);
    } finally {
    // ── Final cleanup/broadcast/queue drain ─────────────────────────
      if (pauseWatchdog) convStore.resumeActivity(convId);
      else convStore.touchActivity(convId);
    }
  };

  // ── Run provider/agent loop ───────────────────────────────────────

  startStreamingSnapshotHeartbeat();

  try {
    const requestOverheadTokens = Math.ceil((systemPrompt.length + JSON.stringify(toolDefs).length) / 4);
    const estimatedMessages = estimateContextTokens(apiMessages, conv.provider);
    let projectedTokens = estimatedMessages + requestOverheadTokens;
    if (!conv.activeContext || isActiveContextCompatible(conv.activeContext, conv.provider, conv.model, accountScope)) {
      projectedTokens = Math.max(conv.lastContextTokens ?? 0, projectedTokens);
      if (userMessage) {
        const latestUser = [...conv.messages].reverse().find(isHistoryMessage);
        if (latestUser?.role === "user" && conv.lastContextTokens != null) {
          projectedTokens = Math.max(
            projectedTokens,
            conv.lastContextTokens + estimateContextTokens([{
              role: "user",
              content: latestUser.content,
              metadata: latestUser.metadata,
              providerData: latestUser.providerData,
            }], conv.provider),
          );
        }
      }
    }

    const incompatibleCheckpoint = conv.activeContext != null
      && !isActiveContextCompatible(conv.activeContext, conv.provider, conv.model, accountScope);
    if (incompatibleCheckpoint) {
      // Never leak an opaque OpenAI checkpoint into another provider. The
      // context builder returned sanitized transcript history. Preserve that
      // exact transcript when it fits; summarize with the destination provider
      // only when its own window actually requires a checkpoint.
      if (shouldAutoCompact(projectedTokens, contextLimit)) {
        apiMessages = await performAutomaticCompaction(apiMessages, "provider_switch", projectedTokens);
        syncActiveContext(apiMessages);
      } else {
        liveConv.activeContext = null;
        liveConv.lastContextTokens = null;
        log("info", `orchestrator: discarded incompatible checkpoint for ${convId}; sanitized transcript fits destination context (${projectedTokens}/${contextLimit ?? "unknown"})`);
      }
      convStore.markDirty(convId);
      convStore.flush(convId);
    } else if (shouldAutoCompact(projectedTokens, contextLimit)) {
      apiMessages = await performAutomaticCompaction(apiMessages, "pre_turn", projectedTokens);
      syncActiveContext(apiMessages);
      convStore.markDirty(convId);
      convStore.flush(convId);
    }

    const result = await runAgentLoop(apiMessages, conv.provider, conv.model, callbacks, {
      system: systemPrompt,
      signal: ac.signal,
      tools: toolDefs,
      executor,
      summarizer: (name, input) => {
        const s = summarizeTool(name, input);
        return s.detail || s.label;
      },
      effort: conv.effort,
      serviceTier: conv.fastMode ? "fast" : undefined,
      promptCacheKey: convId,
      tracking: { source: "conversation", conversationId: convId },
      turnSession: providerTurnSession ?? undefined,
      getCodexWindowId: () => currentWindowId,
      accountScope,
      codexTurnId,
      codexTurnStartedAtMs: startedAt,
      state: agentState,
    });

    const endedAt = Date.now();
    if (conv.lastContextTokens != null && result.lastOutputTokens > 0) {
      conv.lastContextTokens += result.lastOutputTokens;
      server.sendToSubscribers(convId, {
        type: "context_update",
        convId,
        streamSeq: convStore.nextStreamSeq(convId),
        contextTokens: conv.lastContextTokens,
      });
    }
    outcome = {
      ok: true,
      blocks: result.blocks,
      tokens: result.tokens,
      durationMs: endedAt - startedAt,
      endedAt,
    };

    // ── Success path: persist assistant turn ────────────────────────

    // Convert ApiMessage[] → StoredMessage[], stamp metadata on last assistant
    const storedMessages: StoredMessage[] = result.newMessages.map(m => ({
      role: m.role,
      content: m.content,
      metadata: m.metadata ?? null,
      providerData: m.providerData,
      contextTokens: m.contextTokens ?? null,
      ...(m.contextCheckpoint ? { contextCheckpoint: m.contextCheckpoint } : {}),
    }));
    const lastAssistant = [...storedMessages].reverse().find(m => m.role === "assistant");
    if (lastAssistant) {
      lastAssistant.metadata = {
        startedAt,
        endedAt,
        model: conv.model,
        tokens: result.tokens,
      };
    }

    // Push the actual conversation messages — preserves the full
    // multi-turn structure (assistant → user[tool_result] → assistant → ...)
    // Interleave status markers at the correct positions so system messages
    // appear between the rounds where they actually occurred.
    const interleavedMessages = interleaveTranscriptMarkers(storedMessages, transcriptMarkers);
    const successTurnTranscriptStartIndex = currentTurnTranscriptStartIndex();
    conv.messages.splice(
      successTurnTranscriptStartIndex,
      conv.messages.length - successTurnTranscriptStartIndex,
      ...interleavedMessages,
    );
    syncActiveContext(result.contextMessages);
    conv.updatedAt = Date.now();
    // Do not bump on completion. The conversation was already brought to the
    // top when the user/queued message started; bumping again here can race with
    // manual sidebar reordering performed while the stream is ending.

    server.sendToSubscribers(convId, {
      type: "message_complete",
      convId,
      streamSeq: convStore.nextStreamSeq(convId),
      blocks: result.blocks,
      endedAt,
      tokens: result.tokens,
    });

    log("info", `orchestrator: message complete for ${convId} (${result.tokens} tokens, ${result.blocks.length} blocks, ${endedAt - startedAt}ms)`);

    if (goalContinuation && conv.goal?.status === "active") {
      conv.goal.turns += 1;
      conv.goal.updatedAt = endedAt;
    }

    // Mark unread if no client is viewing this conversation
    if (!server.hasSubscribers(convId)) {
      convStore.markUnread(convId);
    }

    // Persist and notify sidebar
    convStore.markDirty(convId);
    convStore.flush(convId);
    broadcastConversationUpdated(server, convId);

  } catch (err) {
    // ── Error/abort path: persist salvageable state ─────────────────
    const isAbort = ac.signal.aborted;

    const isWatchdog = isAbort && ac.signal.reason === "watchdog";
    const isDaemonRestart = isAbort && ac.signal.reason === "daemon-restart";

    if (!isAbort) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", `orchestrator: stream error for ${convId}: ${msg}`);
      // Don't also emit a conversation-scoped `error` event here: the catch
      // path already persists and broadcasts a canonical `system_message`
      // below, and sending both makes the TUI render the same failure twice.
    } else if (isWatchdog) {
      log("warn", `orchestrator: stream timed out for ${convId} (watchdog)`);
    } else if (isDaemonRestart) {
      log("info", `orchestrator: stream interrupted for daemon restart for ${convId}`);
    } else {
      log("info", `orchestrator: stream interrupted for ${convId}`);
    }

    // Persist completed rounds from the agent (full tool-use exchanges),
    // interleaving retry markers at the correct positions.
    const completedStored: StoredMessage[] = agentState.completedMessages.map(m => ({
      role: m.role,
      content: m.content,
      metadata: m.metadata ?? null,
      providerData: m.providerData,
      contextTokens: m.contextTokens ?? null,
      ...(m.contextCheckpoint ? { contextCheckpoint: m.contextCheckpoint } : {}),
    }));
    if (completedStored.length > 0) {
      // Stamp metadata on the last completed assistant — mirrors the success path.
      // Without this, when a tool round completed before abort took effect,
      // onRoundComplete cleared partialContent and metadata would be lost.
      const lastAssistant = [...completedStored].reverse().find(m => m.role === "assistant");
      if (lastAssistant) {
        lastAssistant.metadata = {
          startedAt,
          endedAt: Date.now(),
          model: conv.model,
          tokens: agentState.tokens,
        };
      }
    }
    const interleavedCompleted = interleaveTranscriptMarkers(completedStored, transcriptMarkers);
    const recoveryTurnTranscriptStartIndex = currentTurnTranscriptStartIndex();
    conv.messages.splice(
      recoveryTurnTranscriptStartIndex,
      conv.messages.length - recoveryTurnTranscriptStartIndex,
      ...interleavedCompleted,
    );

    // Persist the in-flight partial response (current round's streamed content),
    // dropping empty thinking placeholders while keeping non-empty reasoning text.
    const safeContent = partialContent.filter(b => {
      if (b.type === "thinking") return isPersistableThinkingBlock(b);
      return true;
    });
    const hasContent = safeContent.some(b =>
      (b.type === "text" && b.text) || (b.type === "thinking" && b.thinking)
    );
    // Convert safe content to display blocks for the TUI.
    // Start with blocks from fully completed rounds (already persisted via
    // completedMessages above), then append any salvageable in-flight content.
    const partialBlocks: import("./messages").Block[] = safeContent
      .filter(b => (b.type === "text" && b.text) || (b.type === "thinking" && b.thinking))
      .map(b => {
        if (b.type === "thinking") return { type: "thinking" as const, text: b.thinking };
        if (b.type === "text") return { type: "text" as const, text: b.text };
        return { type: "text" as const, text: "" };
      });
    abortPersistedBlocks = [...agentState.completedBlocks, ...partialBlocks];

    if (hasContent) {
      conv.messages.push({
        role: "assistant",
        content: safeContent,
        metadata: {
          startedAt,
          endedAt: Date.now(),
          model: conv.model,
          tokens: agentState.tokens,
        },
        providerData: undefined,
      });
    }

    const canAdvanceExistingContext = conv.activeContext != null
      && isActiveContextCompatible(conv.activeContext, conv.provider, conv.model, accountScope);
    if (canAdvanceExistingContext || compactionsThisTurn > 0) {
      const recoveredContext = [...agentState.contextMessages];
      if (hasContent) {
        recoveredContext.push({ role: "assistant", content: safeContent });
      }
      syncActiveContext(recoveredContext);
    }

    // Persist and broadcast system message
    let outcomeError: string;
    if (isWatchdog) {
      const sysText = "✗ Timed out (stale stream)";
      outcomeError = sysText;
      conv.messages.push({ role: "system", content: sysText, metadata: null });
      server.sendToSubscribers(convId, { type: "system_message", convId, streamSeq: convStore.nextStreamSeq(convId), text: sysText, color: "error" });
    } else if (isDaemonRestart) {
      const sysText = "✗ Daemon restarted";
      outcomeError = sysText;
      conv.messages.push({ role: "system", content: sysText, metadata: null });
      server.sendToSubscribers(convId, { type: "system_message", convId, streamSeq: convStore.nextStreamSeq(convId), text: sysText, color: "error" });
    } else if (isAbort) {
      const sysText = "✗ Interrupted";
      outcomeError = sysText;
      conv.messages.push({ role: "system", content: sysText, metadata: null });
      server.sendToSubscribers(convId, { type: "system_message", convId, streamSeq: convStore.nextStreamSeq(convId), text: sysText, color: "error" });
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      const sysText = `✗ ${errMsg}`;
      outcomeError = sysText;
      conv.messages.push({ role: "system", content: sysText, metadata: null });
      server.sendToSubscribers(convId, { type: "system_message", convId, streamSeq: convStore.nextStreamSeq(convId), text: sysText, color: "error" });
    }
    const endedAt = Date.now();
    outcome = {
      ok: false,
      blocks: abortPersistedBlocks ?? [...agentState.completedBlocks],
      tokens: agentState.tokens,
      durationMs: endedAt - startedAt,
      endedAt,
      error: outcomeError,
      aborted: isAbort,
      watchdog: isWatchdog,
      daemonRestart: isDaemonRestart,
    };
  } finally {
    if (providerTurnSession) {
      try {
        if (outcome?.ok) await providerTurnSession.close();
        else if (providerTurnSession.destroy) await providerTurnSession.destroy();
        else await providerTurnSession.close();
      } catch (err) {
        log("warn", `orchestrator: provider turn-session cleanup failed for ${convId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    stopStreamingSnapshotHeartbeat();
    const stoppedStreamSeq = convStore.nextStreamSeq(convId);
    const streamStopReason: StreamingStopReason | undefined = ac.signal.aborted && ac.signal.reason === "daemon-restart"
      ? "daemon-restart"
      : undefined;
    convStore.clearActiveJob(convId);
    convStore.clearCurrentStreamingBlocks(convId);
    convStore.resetChunkCounter(convId);
    if (outcome) settlePendingSubagentNotifications(convId, outcome);
    convStore.markDirty(convId);
    convStore.flush(convId);
    server.sendToSubscribers(convId, {
      type: "streaming_stopped",
      convId,
      streamSeq: stoppedStreamSeq,
      ...(streamStopReason ? { reason: streamStopReason } : {}),
      persistedBlocks: abortPersistedBlocks,
    });
    // Broadcast updated summary (streaming=false, possibly unread=true)
    broadcastConversationUpdated(server, convId, streamStopReason);

    // When the active stream built up any transient display-only history
    // (completed rounds for late joiners, retries, or next-turn injections),
    // the TUI may be showing an approximate live view. Now that conv.messages
    // has the canonical interleaved structure, send history_updated so every
    // client rebuilds from the persisted ordering.
    if (agentState.completedMessages.length > 0 || transcriptMarkers.length > 0 || hadNextTurnInjections) {
      const displayData = convStore.getRenderSnapshot(convId, false);
      if (displayData) {
        const events = buildHistoryUpdatedEvents(displayData);
        server.sendHistoryUpdatedToSubscribers(convId, events.legacy, events.paginated);
      }
    }

    if (hadGoalAtStart || conv.goal) {
      server.sendToSubscribers(convId, { type: "goal_updated", convId, goal: conv.goal ?? null });
    }

    ext.onComplete();

    // Drain remaining queued messages. "next-turn" messages that weren't
    // injected mid-stream (e.g. no tool rounds, or queued too late) end up
    // here alongside "message-end" messages. Send the first as a new turn,
    // re-queue the rest — they'll drain on the next streaming_stopped.
    const shutdownMode = getDaemonShutdownMode();
    if (shutdownMode) {
      convStore.clearQueuedMessages(convId);
      convStore.clearGoalContinuationAfterStream(convId);
      log("info", `orchestrator: discarded autonomous continuations for ${convId} during daemon ${shutdownMode}`);
    }
    const allQueued = shutdownMode ? [] : convStore.drainQueuedMessages(convId);
    if (allQueued.length > 0) {
      const first = allQueued[0];
      // Re-queue the rest for the next cycle
      for (let i = 1; i < allQueued.length; i++) {
        convStore.pushQueuedMessage(
          convId,
          allQueued[i].text,
          allQueued[i].timing,
          allQueued[i].images,
          allQueued[i].subagentMaxDepth,
          allQueued[i].subagentNotificationId,
        );
      }
      log("info", `orchestrator: draining queued message: "${first.text.slice(0, 50)}"`);
      // Kick off a new send cycle — null client so user_message broadcasts to everyone.
      // Await to keep the chain in a single promise so errors propagate and
      // the conversation stays consistent (no orphaned background streams).
      await orchestrateSendMessage(
        server,
        null,
        undefined,
        convId,
        first.text,
        Date.now(),
        ext,
        first.images,
        {
          subagentMaxDepth: first.subagentMaxDepth ?? null,
          subagentNotificationId: first.subagentNotificationId,
        },
      );
    } else {
      const resumeRequestedAfterStream = convStore.consumeGoalContinuationAfterStream(convId);
      const shouldContinueActiveGoal = conv.goal?.status === "active"
        && (resumeRequestedAfterStream || (outcome?.ok && !outcome.aborted));
      if (shouldContinueActiveGoal) {
        queueMicrotask(() => {
          const latest = convStore.get(convId);
          if (!latest?.goal || latest.goal.status !== "active") return;
          if (convStore.isStreaming(convId)) return;
          if (convStore.getQueuedMessages(convId).length > 0) return;
          log("info", `orchestrator: continuing active goal for ${convId}: "${latest.goal.objective.slice(0, 80)}"`);
          void orchestrateGoalContinuation(server, convId, ext).catch((err) => {
            log("error", `orchestrator: goal continuation failed for ${convId}: ${err instanceof Error ? err.message : String(err)}`);
          });
        });
      }
    }
  }

  return outcome ?? buildErrorOutcome("Assistant turn ended without an outcome.");
}
