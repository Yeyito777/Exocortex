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
import { getMaxContext, supportsImageInputs } from "./providers/registry";
import { buildExecutor, summarizeTool, toolCallsRequireWatchdogPause, getRegisteredTools, getCustomToolDisplayInfo } from "./tools/registry";
import { ensureConversationCustomTools } from "./tools/custom-tools";
import * as convStore from "./conversations";
import type { DaemonServer, ConnectedClient } from "./server";
import { CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT, MAX_EXO_SUBAGENT_DEPTH, createStoredUserContextCheckpoint, createStoredUserMessage, currentReplayHistoryPrefix, isHistoryMessage, isReplayHistoryMessage, isValidActiveContextCached, type ActiveContext, type StoredMessage, type ApiContentBlock, type ApiMessage, type Block, type UserMessageAutomation } from "./messages";
import type { ContentBlock as ProviderContentBlock, StreamRetryMetadata } from "./providers/types";
import type { ImageAttachment } from "@exocortex/shared/messages";
import type { BackgroundTaskCompletion, ExocortexToolRuntime, ToolExecutionContext } from "./tools/types";
import { broadcastConversationHistoryUpdated, broadcastConversationUpdated } from "./conversation-events";
import { quarantineActiveContext } from "./active-context-quarantine";
import { applyGoalControllerAction, updateGoalStatus } from "./goals";
import { decideGoalControllerAction } from "./goal-controller";
import { createProviderTurnSession, streamMessage } from "./api";
import { annotateApiMessagesContextTokens, copyContextTokenAttributionsToStoredHistory } from "./context-token-attribution";
import type { RealtimeCallSpeakerAttribution, StreamingStopReason } from "./protocol";
import { buildRealtimeDelegationMessage } from "./realtime-delegation";
import {
  assertBoundedContextReplay,
  buildConversationApiContext,
  compactContextMessages,
  estimateContextTokens,
  isActiveContextCompatible,
  shouldAutoCompact,
  type CompactionReason,
} from "./context-compaction";
import { getCurrentAccountScope as getCurrentOpenAIAccountScope } from "./providers/openai/auth";
import { buildCodexWindowId } from "./providers/openai/identity";
import { resolveToolCallPresentation } from "./helper-tool-manifest";
import { setBackgroundTaskActive as setConversationBackgroundTaskActive, setChronoTaskActive as setConversationChronoTaskActive } from "./conversation-activity";
import { acknowledgeSubagentNotification, settlePendingSubagentNotifications } from "./subagent-notifications";
import { getDaemonShutdownMode } from "./daemon-lifecycle";
import { ensureConversationWorkspace } from "./workspace-service";
import { BUFFERED_HISTORY_TURNS, buildHistoryUpdatedEvents, buildStoredHistoryUpdatedEvent } from "./history-pagination";
import {
  RetryableStreamAbortController,
  StaleStreamRetriesExhaustedError,
  runWithStaleStreamRetries,
} from "./watchdog-retry";
import {
  completeDeferredChronoSleepResume,
  interruptDeferredChronoSleep,
  type DeferredChronoSleep,
} from "./chrono-service";
import { buildConversationRequestSurface } from "./conversation-request-surface";

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
  /** Test seam for provider streaming across compaction and assistant requests. */
  streamMessageFn?: typeof streamMessage;
  /** Optional realtime consumer for user-facing assistant text as it streams. */
  onAssistantTextChunk?: (chunk: string) => void;
}

// ── Message history/replay helpers ─────────────────────────────────

/** Convert structurally complete API messages into canonical stored rows. */
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
  /** The turn ended at a deferred Chrono sleep and will continue by replay later. */
  suspended?: boolean;
}

interface AssistantTurnOptions {
  userMessage?: {
    text: string;
    images?: ImageAttachment[];
  };
  /** Exact hidden-controller instruction that starts an autonomous worker turn. */
  goalContinuationPrompt?: string;
  /**
   * Explicitly install a delegation budget for this turn. Omission inherits the
   * conversation's persisted budget for automatic replay/goal continuations.
   */
  subagentMaxDepth?: number | null;
  /** Durable detached-child notification accepted by this user turn. */
  subagentNotificationId?: string;
  /** Durable daemon queue identity accepted by this user turn. */
  queueEntryId?: string;
  /** Provenance for a daemon/model-authored prompt represented as a user turn. */
  automation?: UserMessageAutomation;
  /** Force one context compaction without requesting an assistant response. */
  manualCompaction?: boolean;
  /** Promote the persisted voice transcript into a visible backend request. */
  realtimeDelegation?: {
    callId: string;
    originalUserUtterance: string;
    backendTask: string;
    transcriptDelta: Array<{ role: "user" | "assistant"; text: string }>;
    speaker?: RealtimeCallSpeakerAttribution;
  };
  /** Optional owner lifecycle that can cancel this turn without daemon IPC. */
  externalAbortSignal?: AbortSignal;
  /** This turn is the daemon-owned successor in an already-active stream chain. */
  streamChainHandoff?: boolean;
}

export type SubagentTurnPolicy = Pick<AssistantTurnOptions, "subagentMaxDepth" | "subagentNotificationId" | "queueEntryId" | "automation">;

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

/**
 * Start an agent turn from an existing visible call transcript. The transcript
 * is promoted in place into the sole durable backend request before replay.
 */
export async function orchestrateRealtimeDelegation(
  server: DaemonServer,
  convId: string,
  delegation: {
    callId: string;
    originalUserUtterance: string;
    backendTask: string;
    transcriptDelta: Array<{ role: "user" | "assistant"; text: string }>;
    speaker?: RealtimeCallSpeakerAttribution;
  },
  startedAt: number,
  ext: OrchestrationCallbacks,
  policy: SubagentTurnPolicy = {},
  signal?: AbortSignal,
): Promise<AssistantTurnOutcome> {
  return await orchestrateAssistantTurn(server, null, undefined, convId, startedAt, ext, {
    ...policy,
    realtimeDelegation: delegation,
    externalAbortSignal: signal,
  });
}

export async function orchestrateCompactConversation(
  server: DaemonServer,
  client: ConnectedClient | null,
  reqId: string | undefined,
  convId: string,
  startedAt: number,
  ext: OrchestrationCallbacks,
  policy: SubagentTurnPolicy = {},
): Promise<AssistantTurnOutcome> {
  return await orchestrateAssistantTurn(server, client, reqId, convId, startedAt, ext, {
    ...policy,
    manualCompaction: true,
  });
}

export async function orchestrateGoalCycle(
  server: DaemonServer,
  convId: string,
  ext: OrchestrationCallbacks,
  policy: SubagentTurnPolicy = {},
): Promise<AssistantTurnOutcome> {
  const conv = convStore.get(convId);
  if (!conv?.goal || conv.goal.status !== "active") {
    return {
      ok: false,
      blocks: [],
      tokens: 0,
      durationMs: 0,
      endedAt: Date.now(),
      error: "No active goal to review.",
    };
  }
  if (convStore.isStreaming(convId)) {
    return {
      ok: false,
      blocks: [],
      tokens: 0,
      durationMs: 0,
      endedAt: Date.now(),
      error: "Already streaming",
    };
  }
  convStore.beginStreamHandoff(convId, "goal_controller");
  broadcastConversationUpdated(server, convId);
  return await orchestrateGoalReviewHandoff(server, convId, ext, policy);
}

function formatGoalControllerPrompt(objective: string, prompt: string): string {
  return [
    "[goal continuation]",
    `Active goal: ${objective}`,
    prompt.trim(),
  ].join("\n\n");
}

/**
 * Replace a daemon-owned stream handoff with an isolated hidden goal review.
 * The controller itself is an abortable, non-replayable job. Its output is
 * never persisted; only a selected continuation prompt enters the transcript.
 */
async function orchestrateGoalReviewHandoff(
  server: DaemonServer,
  convId: string,
  ext: OrchestrationCallbacks,
  policy: SubagentTurnPolicy = {},
): Promise<AssistantTurnOutcome> {
  const startedAt = Date.now();
  const buildOutcome = (ok: boolean, error?: string, aborted = false): AssistantTurnOutcome => ({
    ok,
    blocks: [],
    tokens: 0,
    durationMs: Date.now() - startedAt,
    endedAt: Date.now(),
    ...(error ? { error } : {}),
    ...(aborted ? { aborted: true } : {}),
  });
  const settleFailedHandoff = () => {
    if (!convStore.isStreamHandoffActive(convId)) return;
    convStore.clearStreamHandoff(convId);
    broadcastConversationUpdated(server, convId);
  };
  const handoffToAssistant = async (options: AssistantTurnOptions): Promise<AssistantTurnOutcome> => {
    convStore.beginStreamHandoff(convId);
    convStore.clearActiveJob(convId);
    broadcastConversationUpdated(server, convId);
    const outcome = await orchestrateAssistantTurn(server, null, undefined, convId, Date.now(), ext, {
      ...options,
      streamChainHandoff: true,
    });
    // A successful worker may already have installed a new handoff for its own
    // post-turn goal review. Clear only an unconsumed marker from failed preflight.
    if (!outcome.ok && !convStore.getActiveJob(convId)) settleFailedHandoff();
    return outcome;
  };
  const handoffQueuedMessage = async (): Promise<AssistantTurnOutcome | null> => {
    const queued = convStore.getQueuedMessages(convId);
    if (queued.length === 0) return null;
    const first = queued[0]!;
    log("info", `orchestrator: queued message superseded goal review for ${convId}: "${first.text.slice(0, 50)}"`);
    return await handoffToAssistant({
      userMessage: { text: first.text, images: first.images },
      subagentMaxDepth: first.subagentMaxDepth ?? null,
      subagentNotificationId: first.subagentNotificationId,
      queueEntryId: first.id,
      automation: first.automation,
    });
  };

  const initial = convStore.get(convId);
  if (!initial?.goal || initial.goal.status !== "active") {
    settleFailedHandoff();
    return buildOutcome(false, "No active goal to review.");
  }
  if (getDaemonShutdownMode()) {
    settleFailedHandoff();
    return buildOutcome(false, "Daemon is shutting down; goal review deferred until restart.");
  }

  if (!ext.streamMessageFn && !hasConfiguredCredentials(initial.provider)) {
    settleFailedHandoff();
    return buildOutcome(false, `Not authenticated for provider ${initial.provider}.`);
  }

  const goalAtStart = initial.goal;
  const controller = new AbortController();
  // Install the hidden job before any await. The TUI derives queueing behavior
  // from goalReviewing, so even the worker-to-controller microtask boundary must
  // never look idle.
  convStore.setActiveJob(convId, controller, startedAt, false, "goal_controller");
  broadcastConversationUpdated(server, convId);

  // User input always wins over an autonomous review, including input queued in
  // the microtask-sized gap between the worker finalizer and this function.
  const alreadyQueued = await handoffQueuedMessage();
  if (alreadyQueued) return alreadyQueued;
  const accountScope = initial.provider === "openai" ? getCurrentOpenAIAccountScope() ?? undefined : undefined;
  const contextLimit = getMaxContext(initial.provider, initial.model);
  const maxHistoryChars = contextLimit == null ? undefined : Math.max(16_000, Math.floor(contextLimit * 3));
  let decision: Awaited<ReturnType<typeof decideGoalControllerAction>>;

  try {
    decision = await decideGoalControllerAction(initial.messages, goalAtStart, {
      provider: initial.provider,
      model: initial.model,
      effort: initial.effort,
      serviceTier: initial.fastMode ? "fast" : undefined,
      signal: controller.signal,
      promptCacheKey: `${convId}:goal-controller`,
      accountScope,
      codexWindowId: buildCodexWindowId(`${convId}:goal-controller`),
      codexTurnId: `${convId}:goal-controller:${startedAt}`,
      codexTurnStartedAtMs: startedAt,
      tracking: { source: "goal_controller", conversationId: convId },
      maxHistoryChars,
      onHeaders: ext.onHeaders,
      onActivity: () => convStore.touchActivity(convId),
      streamMessageFn: ext.streamMessageFn,
    });
    ext.onComplete();
  } catch (error) {
    ext.onComplete();
    const aborted = controller.signal.aborted;
    // Match ordinary worker finalization: durable user input must not be left
    // stranded merely because the hidden request failed or was interrupted.
    // Shutdown and unwind own their own recovery paths, so preserve the queue
    // for those cases instead of starting a replacement worker.
    if (!getDaemonShutdownMode() && !convStore.isHistoryUnwindPending(convId)) {
      const queuedAfterFailure = await handoffQueuedMessage();
      if (queuedAfterFailure) return queuedAfterFailure;
    }
    if (convStore.getActiveJob(convId) === controller) convStore.clearActiveJob(convId);
    if (!aborted) {
      const message = `✗ Goal controller failed: ${error instanceof Error ? error.message : String(error)}`;
      convStore.appendMessages(convId, [{ role: "system", content: message, metadata: null }], { updatedAt: Date.now() });
      server.sendToSubscribers(convId, { type: "system_message", convId, text: message, color: "error" });
      log("error", `orchestrator: ${message} (${convId})`);
    }
    broadcastConversationUpdated(server, convId);
    return buildOutcome(false, aborted ? "✗ Interrupted" : error instanceof Error ? error.message : String(error), aborted);
  }

  if (controller.signal.aborted) {
    if (convStore.getActiveJob(convId) === controller) convStore.clearActiveJob(convId);
    broadcastConversationUpdated(server, convId);
    return buildOutcome(false, "✗ Interrupted", true);
  }

  // A queued message may have arrived while the hidden model was deciding. Its
  // contents were absent from the snapshot, so discard the stale decision.
  const queuedAfterReview = await handoffQueuedMessage();
  if (queuedAfterReview) return queuedAfterReview;

  const latest = convStore.get(convId);
  if (!latest || latest.goal !== goalAtStart || latest.goal.status !== "active") {
    if (convStore.getActiveJob(convId) === controller) convStore.clearActiveJob(convId);
    broadcastConversationUpdated(server, convId);
    return buildOutcome(false, "Goal changed while its next action was being reviewed.");
  }

  if (decision.action === "send_prompt") {
    log("info", `orchestrator: goal controller selected a continuation for ${convId}: "${decision.prompt.slice(0, 80)}"`);
    return await handoffToAssistant({
      ...policy,
      goalContinuationPrompt: formatGoalControllerPrompt(goalAtStart.objective, decision.prompt),
    });
  }

  const lifecycle = applyGoalControllerAction(convId, decision.action, decision.reason);
  if (convStore.getActiveJob(convId) === controller) convStore.clearActiveJob(convId);
  server.sendToSubscribers(convId, {
    type: "goal_updated",
    convId,
    goal: lifecycle.goal,
    message: lifecycle.message,
  });
  broadcastConversationUpdated(server, convId);
  if (!lifecycle.ok) return buildOutcome(false, lifecycle.message);
  log("info", `orchestrator: goal controller selected ${decision.action} for ${convId}`);
  return buildOutcome(true);
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

  const {
    userMessage: requestedUserMessage,
    goalContinuationPrompt,
    manualCompaction = false,
    realtimeDelegation,
  } = options;
  // Goal continuations are daemon-authored notification turns, just like
  // background-task and subagent completion notifications. Persist and
  // broadcast them through the ordinary user-message path so the TUI shows
  // the prompt instead of keeping it as provider-only synthetic context.
  const goalContinuation = typeof goalContinuationPrompt === "string";
  const userMessage = goalContinuation && conv.goal?.status === "active"
    ? { text: goalContinuationPrompt }
    : requestedUserMessage;
  const automation: UserMessageAutomation | undefined = goalContinuation
    ? { kind: "goal_continuation" }
    : options.automation;
  const replaying = !userMessage;
  let interruptedSleep: DeferredChronoSleep | null = null;

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
    const updatedAt = Date.now();
    convStore.bumpToTop(convId);
    if (!convStore.appendMessages(
      convId,
      [{ role: "system", content: text, metadata: null }],
      { updatedAt },
    )) return buildErrorOutcome(text);
    broadcastConversationUpdated(server, convId);
    server.sendToSubscribers(convId, { type: "system_message", convId, text, color: "error" });
    return buildErrorOutcome(text);
  };

  let workingDirectory: string;
  try {
    // Existing conversations are migrated lazily; startup remains summary-only
    // and does not create one directory per archived conversation.
    workingDirectory = ensureConversationWorkspace(convId);
  } catch (err) {
    const message = `Could not prepare conversation workspace: ${err instanceof Error ? err.message : String(err)}`;
    if (client) server.sendTo(client, { type: "error", reqId, convId, message });
    return buildErrorOutcome(message);
  }

  const shutdownModeAtStart = getDaemonShutdownMode();
  if (shutdownModeAtStart) {
    const message = `Daemon is shutting down (${shutdownModeAtStart}); refusing to start another turn.`;
    if (client) server.sendTo(client, { type: "error", reqId, convId, message });
    return buildErrorOutcome(message);
  }

  if (!ext.streamMessageFn && !hasConfiguredCredentials(conv.provider)) {
    const message = `Not authenticated for provider ${conv.provider}. Run: bun run src/main.ts login ${conv.provider}`;
    if (client) server.sendTo(client, {
      type: "error",
      reqId,
      convId,
      message,
    });
    return buildErrorOutcome(message);
  }
  const acceptingStreamChainHandoff = options.streamChainHandoff === true
    && convStore.isStreamHandoffActive(convId);
  if (convStore.isStreaming(convId) && !acceptingStreamChainHandoff) {
    const message = "Already streaming";
    if (client) server.sendTo(client, { type: "error", reqId, convId, message });
    return buildErrorOutcome(message);
  }
  if (convStore.isHistoryUnwindPending(convId)) {
    const message = "Conversation unwind in progress";
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
  try {
    await ensureConversationCustomTools(conv, getRegisteredTools().map((tool) => tool.name), workingDirectory);
  } catch (error) {
    return reportSendError(`Failed to load custom tools: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (userMessage) {
    try {
      interruptedSleep = interruptDeferredChronoSleep(convId, startedAt);
    } catch (error) {
      return reportSendError(`Could not resume the pending Chrono sleep: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (realtimeDelegation) {
    const delegatedMessage = buildRealtimeDelegationMessage(
      realtimeDelegation.originalUserUtterance,
      realtimeDelegation.backendTask,
      realtimeDelegation.speaker,
      realtimeDelegation.transcriptDelta,
    );
    if (!convStore.promoteRealtimeTranscript(
      convId,
      realtimeDelegation.originalUserUtterance,
      delegatedMessage,
      realtimeDelegation.callId,
    )) {
      return reportSendError("The realtime handoff no longer has a matching call transcript.");
    }
    // The transcript draft and canonical history must reconcile before backend
    // output begins streaming, so every client observes the exact model input.
    broadcastConversationHistoryUpdated(server, convId);
    broadcastConversationUpdated(server, convId);
  }
  if (requestedUserMessage && conv.goal?.status === "paused" && conv.goal.pausedBy === "controller") {
    const resumed = updateGoalStatus(convId, "active", "Goal resumed from new input.");
    server.sendToSubscribers(convId, {
      type: "goal_updated",
      convId,
      goal: resumed.goal,
      message: resumed.message,
    });
    broadcastConversationUpdated(server, convId);
  }
  const hadGoalAtStart = !!conv.goal;

  // ── Start stream and broadcast initial state ──────────────────────

  let acceptedUserMessage: StoredMessage | null = null;
  if (userMessage) {
    const contextCheckpoint = createStoredUserContextCheckpoint(conv);
    acceptedUserMessage = createStoredUserMessage(userMessage.text, conv.model, startedAt, userMessage.images, {
      subagentNotificationId: options.subagentNotificationId,
      queueEntryId: options.queueEntryId,
      automation,
      contextCheckpoint,
    });
  }

  conv.updatedAt = Date.now();
  convStore.bumpToTop(convId);
  if (acceptedUserMessage) {
    if (!convStore.appendMessages(convId, [acceptedUserMessage], { updatedAt: conv.updatedAt })) {
      throw new Error(`Conversation ${convId} disappeared before its user turn could be committed`);
    }
  } else {
    // Replay/manual compaction has no new user message, but its sidebar/metadata
    // mutation still needs an explicit commit before provider work starts.
    convStore.markDirty(convId);
    convStore.flush(convId);
  }

  if (interruptedSleep) {
    // Rebuild only after both the deferred tool result and incoming user message
    // are canonical. Rebuilding earlier would erase the sender's optimistic user
    // bubble, while a later incremental user_message would duplicate it.
    broadcastConversationHistoryUpdated(server, convId);
    broadcastConversationUpdated(server, convId);
  }

  if (userMessage && !interruptedSleep) {

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
        ...(options.queueEntryId ? { queueId: options.queueEntryId } : {}),
        ...(automation ? { automation } : {}),
      }, client);
    } else {
      server.sendToSubscribers(convId, {
        type: "user_message",
        convId,
        text: userMessage.text,
        startedAt,
        images: userMessage.images,
        ...(options.queueEntryId ? { queueId: options.queueEntryId } : {}),
        ...(automation ? { automation } : {}),
      });
    }
  }
  let persistedTurnMessageCount = 0;
  // Direct reference for the rare abort-metadata update. This is not a transcript
  // mirror: completed content remains exclusively in canonical conversation state.
  let lastCanonicalTurnAssistant: StoredMessage | null = null;

  // The user turn was committed above before any potentially long pre-turn
  // compaction. A daemon crash before the first streamed block cannot lose it.
  // The transcript now durably records this queue identity. Removing the queue
  // only after that flush closes the message-loss window on daemon crashes.
  if (options.queueEntryId) convStore.removeQueuedMessageById(options.queueEntryId);
  if (options.subagentNotificationId) acknowledgeSubagentNotification(options.subagentNotificationId);

  const ac = new RetryableStreamAbortController();
  const externalAbortSignal = options.externalAbortSignal;
  const abortFromExternalOwner = () => ac.abort(externalAbortSignal?.reason);
  if (externalAbortSignal?.aborted) abortFromExternalOwner();
  else externalAbortSignal?.addEventListener("abort", abortFromExternalOwner, { once: true });
  // A standalone compaction has no unfinished assistant turn to replay after a
  // daemon restart. It is still an active job so abort, queueing, and shutdown
  // can coordinate with it normally.
  convStore.setActiveJob(convId, ac, startedAt, !manualCompaction);
  convStore.initStreamingState(convId);
  convStore.setStreamingCommittedMessageCount(convId, conv.messages.length);

  // The app watchdog interrupts only the current provider invocation. Give each
  // retry a fresh child signal while preserving `ac.signal` as the terminal turn
  // signal used by user interrupts and daemon lifecycle operations.
  const streamMessageWithWatchdogRetries: typeof streamMessage = async (
    provider,
    messages,
    model,
    callbacks,
    streamOptions = {},
  ) => runWithStaleStreamRetries(
    ac,
    callbacks,
    (attemptSignal) => (ext.streamMessageFn ?? streamMessage)(provider, messages, model, callbacks, {
      ...streamOptions,
      signal: attemptSignal,
    }),
  );

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
  const accountScope = conv.provider === "openai" ? getCurrentOpenAIAccountScope() ?? undefined : undefined;
  let apiMessages: ApiMessage[] = [];
  let contextPreparationError: unknown;
  try {
    if (conv.activeContext && !isValidActiveContextCached(conv.activeContext, conv.messages)) {
      const quarantinePath = quarantineActiveContext(
        convId,
        conv.activeContext,
        "Active context failed integrity validation before provider replay",
      );
      log("warn", `orchestrator: copied invalid active context for ${convId} to ${quarantinePath}; refusing archive replay`);
      // Preserve the checkpoint in place as well: clearing it would make the
      // next /replay silently submit the full archive again.
    }
    apiMessages = buildConversationApiContext(conv, accountScope).messages;
  } catch (error) {
    // Surface preparation failures through the normal turn error/finally path
    // below, so streaming state, subscriptions and the abort controller settle.
    contextPreparationError = error;
  }

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
    cwd: workingDirectory,
    subagentMaxDepth,
    model: conv.model,
    exocortex: ext.exocortex,
    setBackgroundTaskActive: (taskId, active, details) => {
      if (setConversationBackgroundTaskActive(convId, taskId, active, details)) {
        broadcastConversationUpdated(server, convId);
      }
    },
    setChronoTaskActive: (taskId, active, details) => {
      if (setConversationChronoTaskActive(convId, taskId, active, details)) {
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
  const providerTurnSession = ext.streamMessageFn ? null : createProviderTurnSession(conv.provider);
  const codexTurnId = `${convId}:${startedAt}`;
  const requestSurface = buildConversationRequestSurface(liveConv, {
    conversationInstructions: systemInstructionsText || undefined,
    conversationId: convId,
    workingDirectory,
    subagentMaxDepth,
  });
  const systemPrompt = requestSurface.system;
  const toolDefs = requestSurface.tools;
  const allowedToolNames = requestSurface.toolNames;
  const contextLimit = getMaxContext(conv.provider, conv.model);
  const startingCompactionCount = conv.activeContext?.compactionCount ?? 0;
  let currentWindowNumber = conv.activeContext?.windowNumber ?? 0;
  let currentWindowId = conv.activeContext?.windowId ?? buildCodexWindowId(convId);
  let compactionsThisTurn = 0;
  let latestCompactionKind: ActiveContext["kind"] | null = null;
  let latestCompactionAccountScope: string | undefined;
  let latestCompactedAt: number | null = null;

  async function performContextCompaction(
    messages: ApiMessage[],
    reason: CompactionReason,
    projectedTokens: number,
  ): Promise<ApiMessage[]> {
    convStore.pauseActivity(convId);
    let compactionStatusActive = false;
    const stopCompactionStatus = () => {
      if (!compactionStatusActive) return;
      compactionStatusActive = false;
      setContextCompactionStatus(false);
    };
    try {
      const trigger = reason === "manual" ? "manual" : "automatic";
      log("info", `orchestrator: ${trigger} context compaction starting for ${convId} (reason=${reason}, projected=${Number.isFinite(projectedTokens) ? projectedTokens : "overflow"}, limit=${contextLimit ?? "unknown"})`);
      // Automatic plaintext fallback deliberately has no separate progress UI,
      // but an explicit /compact remains visibly active for every provider and
      // through an OpenAI native-to-plaintext fallback.
      if (liveConv.provider === "openai" || reason === "manual") {
        compactionStatusActive = true;
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
          if (reason !== "manual") stopCompactionStatus();
          transcriptMarkers.push({
            afterIndex: agentState.completedMessages.length,
            message: { role: "system", content: warning, metadata: null },
          });
          // The warning describes a semantic context transition. Persist it
          // before starting the potentially long plaintext summary so a crash
          // cannot make that transition invisible in the canonical transcript.
          persistCompletedTurnPrefix();
          server.sendToSubscribers(convId, {
            type: "system_message",
            convId,
            streamSeq: convStore.nextStreamSeq(convId),
            text: warning,
            color: "warning",
          });
        },
        // Compaction pauses the app watchdog for its full operation. Preserve the
        // direct stream seam here so native request-budget accounting can still
        // distinguish production transports from test doubles.
        streamMessageFn: ext.streamMessageFn,
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
      compactionStatusActive = false;
      setContextCompactionStatus(false, completedAt);
      log("info", `orchestrator: ${trigger} context compaction complete for ${convId} (kind=${result.kind}, messages=${messages.length}->${result.messages.length})`);
      return result.messages;
    } finally {
      stopCompactionStatus();
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
    const replayPrefix = currentReplayHistoryPrefix(liveConv.messages);
    const transcriptHistoryCount = replayPrefix.historyCount;
    const candidate: ActiveContext = {
      version: 1,
      kind: latestCompactionKind ?? previous!.kind,
      provider: liveConv.provider,
      model: liveConv.model,
      ...(checkpointAccountScope ? { accountScope: checkpointAccountScope } : {}),
      messages: structuredClone(messages),
      transcriptHistoryCount,
      transcriptPrefixHash: replayPrefix.hash,
      compactionHistoryCount: transcriptHistoryCount,
      compactionPrefixHash: replayPrefix.hash,
      windowId: currentWindowId,
      windowNumber: currentWindowNumber,
      compactedAt: latestCompactedAt ?? previous!.compactedAt,
      compactionCount: startingCompactionCount + compactionsThisTurn,
    };
    // A compaction result is derived, disposable state, but installing an
    // invalid result makes the next turn discard its only bounded replay and
    // fall back to an arbitrarily large canonical transcript. Enforce the
    // integrity invariant before the replacement becomes durable.
    if (!isValidActiveContextCached(candidate, liveConv.messages)) {
      throw new Error("Refusing to install an invalid context-compaction checkpoint");
    }
    liveConv.activeContext = candidate;
  }

  function completedDisplayMessages(): StoredMessage[] {
    return toStoredMessages(agentState.completedMessages);
  }

  function appendCompletedTurnSnapshot(completed: StoredMessage[]): void {
    if (completed.length < persistedTurnMessageCount) {
      throw new Error(
        `Completed turn prefix regressed for ${convId}: ${completed.length}/${persistedTurnMessageCount}`,
      );
    }
    const appended = completed.slice(persistedTurnMessageCount);
    if (appended.length === 0) return;
    const updatedAt = Date.now();
    if (!convStore.appendMessages(convId, appended, { updatedAt })) {
      throw new Error(`Conversation ${convId} disappeared while committing a completed provider round`);
    }
    for (const message of appended) {
      if (message.role === "assistant") lastCanonicalTurnAssistant = message;
    }
    persistedTurnMessageCount = completed.length;
  }

  function persistCompletedTurnPrefix(additionalMessages: StoredMessage[] = []): void {
    appendCompletedTurnSnapshot([
      ...interleaveTranscriptMarkers(completedDisplayMessages(), transcriptMarkers),
      ...additionalMessages,
    ]);
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
    _persistImmediately = false,
  ): void {
    convStore.touchActivity(convId);
    // Provider retry → clear partial state so the retry starts clean.
    // Completed rounds remain visible through canonical display entries.
    partialContent.length = 0;
    convStore.initStreamingState(convId);
    convStore.setStreamingCommittedBlockCount(convId, agentState.completedBlocks.length);
    const sysText = formatRetryNotice(attempt, maxAttempts, errorMessage, delaySec, metadata);
    transcriptMarkers.push({
      afterIndex: agentState.completedMessages.length,
      message: { role: "system", content: sysText, metadata: null },
    });
    // Retry markers are canonical lifecycle events. Commit the completed raw
    // prefix plus this marker immediately instead of retaining a second display
    // history that overlaps the durable transcript.
    persistCompletedTurnPrefix();
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
    const pendingAI = convStore.getPendingStreamSnapshot(convId);
    if (!pendingAI) return;

    server.sendToSubscribers(convId, {
      type: "streaming_started",
      convId,
      provider: liveConv.provider,
      model: liveConv.model,
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
      // The user turn was already flushed before streaming started. The empty
      // live block exists only in streaming state, so rewriting the complete
      // retained audit transcript here neither improves crash recovery nor
      // helps late joiners.
      convStore.resetChunkCounter(convId);
    },
    onTextChunk(chunk) {
      server.sendToSubscribers(convId, { type: "text_chunk", convId, streamSeq: convStore.nextStreamSeq(convId), text: chunk });
      ext.onAssistantTextChunk?.(chunk);
      const block = ensurePartialContentTail("text");
      if (block.type === "text") block.text += chunk;
      convStore.appendToStreamingBlock(convId, "text", chunk);
      // touchActivity piggybacks on the chunk counter rather than firing on
      // every single SSE event, keeping overhead negligible.
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
        ...(block.presentation ? { presentation: block.presentation } : {}),
      });
      convStore.pushStreamingBlock(convId, {
        type: "tool_call",
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        input: block.input,
        summary: block.summary,
        ...(block.presentation ? { presentation: block.presentation } : {}),
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
        if (copied > 0) convStore.markContextAttributionDirty(convId);
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
      convStore.setStreamingCommittedBlockCount(convId, agentState.completedBlocks.length);
      // Persist the structurally complete tool-call/result prefix before any
      // potentially long mid-turn compaction or next provider request.
      persistCompletedTurnPrefix();
    },
    drainNextTurnMessages() {
      // Peek first. Queue entries are removed only after their user messages are
      // durably committed below, preventing a crash between dequeue and history.
      const drained = convStore.getQueuedMessages(convId).filter(message => message.timing === "next-turn");
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
          queueEntryId: qm.id,
          automation: qm.automation,
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

      // Commit the accepted user prompts before removing their durable queue
      // copies or broadcasting them.
      persistCompletedTurnPrefix(injectedStored);
      convStore.removeQueuedMessagesById(drained.map(message => message.id));
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
          queueId: qm.id,
          ...(qm.automation ? { automation: qm.automation } : {}),
        });
      }
      return apiMsgs;
    },
    onRecoveryStateUpdate() {
      // The agent invokes this again after queued next-turn messages have been
      // folded into completedMessages, closing the crash window before compact.
      persistCompletedTurnPrefix();
    },
    async compactContext(messages, reason, projectedTokens) {
      return performContextCompaction(messages, reason, projectedTokens);
    },
  };

  // ── Tool executor wrapper ─────────────────────────────────────────

  // Bounded tools retain the stream watchdog as a second line of defense.
  // Pause it only for tools such as bash that intentionally own a separate
  // long-running/background lifecycle.
  const rawExecutor = buildExecutor(toolContext, allowedToolNames);
  const executor: typeof rawExecutor = async (calls, signal?) => {
    const pauseWatchdog = toolCallsRequireWatchdogPause(calls, convId);
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
    if (contextPreparationError) throw contextPreparationError;
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

    assertBoundedContextReplay(projectedTokens, contextLimit);
    if (manualCompaction) {
      apiMessages = await performContextCompaction(apiMessages, "manual", projectedTokens);
      syncActiveContext(apiMessages);
      convStore.markDirty(convId);
      convStore.flush(convId);
    } else if (shouldAutoCompact(projectedTokens, contextLimit)) {
      apiMessages = await performContextCompaction(apiMessages, "pre_turn", projectedTokens);
      syncActiveContext(apiMessages);
      convStore.markDirty(convId);
      convStore.flush(convId);
    }

    if (manualCompaction) {
      const endedAt = Date.now();
      outcome = {
        ok: true,
        blocks: [],
        tokens: 0,
        durationMs: endedAt - startedAt,
        endedAt,
      };
    } else {
      const result = await runAgentLoop(apiMessages, conv.provider, conv.model, callbacks, {
        system: systemPrompt,
        signal: ac.signal,
        tools: toolDefs,
        executor,
        summarizer: (name, input) => {
          const s = summarizeTool(name, input, convId);
          return s.detail || s.label;
        },
        presentationResolver: async (name, input) => {
          const presentation = await resolveToolCallPresentation(name, input, workingDirectory);
          const toolStyle = getCustomToolDisplayInfo(name, convId);
          return presentation || toolStyle ? { ...presentation, ...(toolStyle ? { toolStyle } : {}) } : undefined;
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
        streamMessageFn: streamMessageWithWatchdogRetries,
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
        ...(result.suspended ? { suspended: true } : {}),
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
      syncActiveContext(result.contextMessages);
      appendCompletedTurnSnapshot(interleavedMessages);
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

      if (!result.suspended && goalContinuation && conv.goal?.status === "active") {
        conv.goal.turns += 1;
        conv.goal.updatedAt = endedAt;
      }

      // Mark unread if no client is viewing this conversation
      if (!result.suspended && !server.hasSubscribers(convId)) {
        convStore.markUnread(convId);
      }

      // Persist and notify sidebar
      convStore.markDirty(convId);
      convStore.flush(convId);
      broadcastConversationUpdated(server, convId);
    }

  } catch (err) {
    // ── Error/abort path: persist salvageable state ─────────────────
    const isAbort = ac.signal.aborted;

    const staleRetriesExhausted = err instanceof StaleStreamRetriesExhaustedError;
    // A root user/lifecycle abort wins races with stale-retry exhaustion.
    const isWatchdog = isAbort
      ? ac.signal.reason === "watchdog"
      : staleRetriesExhausted;
    const isDaemonRestart = isAbort && ac.signal.reason === "daemon-restart";

    if (isWatchdog) {
      log("warn", `orchestrator: stream timed out for ${convId} (watchdog${staleRetriesExhausted ? ", retries exhausted" : ""})`);
    } else if (!isAbort) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", `orchestrator: stream error for ${convId}: ${msg}`);
      // Don't also emit a conversation-scoped `error` event here: the catch
      // path already persists and broadcasts a canonical `system_message`
      // below, and sending both makes the TUI render the same failure twice.
    } else if (isDaemonRestart) {
      log("info", `orchestrator: stream interrupted for daemon restart for ${convId}`);
    } else {
      log("info", `orchestrator: stream interrupted for ${convId}`);
    }

    const endedAt = Date.now();
    const historyUnwindPendingAtAbort = convStore.isHistoryUnwindPending(convId, ac);

    // Persist any completed round not already committed by onRoundComplete,
    // interleaving retry markers at the correct positions. A targeted unwind owns
    // the replacement transaction and must never race a newly durable suffix.
    const completedStored: StoredMessage[] = agentState.completedMessages.map(m => ({
      role: m.role,
      content: m.content,
      metadata: m.metadata ?? null,
      providerData: m.providerData,
      contextTokens: m.contextTokens ?? null,
      ...(m.contextCheckpoint ? { contextCheckpoint: m.contextCheckpoint } : {}),
    }));
    const interleavedCompleted = interleaveTranscriptMarkers(completedStored, transcriptMarkers);
    if (!historyUnwindPendingAtAbort) appendCompletedTurnSnapshot(interleavedCompleted);

    // Completed tool rounds were appended before the next provider invocation.
    // Stamp the actual canonical object (not the fresh recovery clone above) so
    // abort metadata is retained even when the append delta is empty.
    let completedAssistantMetadataChanged = false;
    if (!historyUnwindPendingAtAbort) {
      const hasCompletedAssistant = interleavedCompleted.some(message => message.role === "assistant");
      const canonicalAssistant = lastCanonicalTurnAssistant as StoredMessage | null;
      if (hasCompletedAssistant && canonicalAssistant?.role === "assistant") {
        canonicalAssistant.metadata = {
          startedAt,
          endedAt,
          model: conv.model,
          tokens: agentState.tokens,
        };
        completedAssistantMetadataChanged = true;
      }
    }

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

    const canAdvanceExistingContext = conv.activeContext != null
      && isActiveContextCompatible(conv.activeContext, conv.provider, conv.model, accountScope);
    if (canAdvanceExistingContext || compactionsThisTurn > 0) {
      const recoveredContext = [...agentState.contextMessages];
      if (hasContent) {
        recoveredContext.push({ role: "assistant", content: safeContent });
      }
      syncActiveContext(recoveredContext);
    }

    const outcomeError = isWatchdog
      ? staleRetriesExhausted
        ? `✗ ${err.message}`
        : "✗ Timed out (stale stream)"
      : isDaemonRestart
        ? "✗ Daemon restarted"
        : isAbort
          ? "✗ Interrupted"
          : `✗ ${err instanceof Error ? err.message : String(err)}`;

    if (!historyUnwindPendingAtAbort) {
      const salvageTail: StoredMessage[] = [];
      if (hasContent) {
        salvageTail.push({
          role: "assistant",
          content: safeContent,
          metadata: {
            startedAt,
            endedAt,
            model: conv.model,
            tokens: agentState.tokens,
          },
          providerData: undefined,
        });
      }
      salvageTail.push({ role: "system", content: outcomeError, metadata: null });
      if (!convStore.appendMessages(convId, salvageTail, { updatedAt: endedAt })) {
        throw new Error(`Conversation ${convId} disappeared while committing interrupted stream recovery`);
      }
      // Persist the in-place metadata stamp through the explicit rewrite path.
      if (completedAssistantMetadataChanged) convStore.markDirty(convId, "messages");
      server.sendToSubscribers(convId, {
        type: "system_message",
        convId,
        streamSeq: convStore.nextStreamSeq(convId),
        text: outcomeError,
        color: "error",
      });
    }

    outcome = {
      ok: false,
      blocks: abortPersistedBlocks ?? [...agentState.completedBlocks],
      tokens: agentState.tokens,
      durationMs: endedAt - startedAt,
      endedAt,
      error: outcomeError,
      aborted: isAbort || isWatchdog,
      watchdog: isWatchdog,
      daemonRestart: isDaemonRestart,
    };
  } finally {
    externalAbortSignal?.removeEventListener("abort", abortFromExternalOwner);
    if (providerTurnSession) {
      try {
        // Ordinary successful turns may park OpenAI's websocket briefly for
        // reuse. A long Chrono sleep is explicitly not an idle live turn: tear
        // down the physical transport now and establish a fresh one on replay.
        if (outcome?.ok && !outcome.suspended) await providerTurnSession.close();
        else if (providerTurnSession.destroy) await providerTurnSession.destroy();
        else await providerTurnSession.close();
      } catch (err) {
        log("warn", `orchestrator: provider turn-session cleanup failed for ${convId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    stopStreamingSnapshotHeartbeat();
    // Decide whether the conversation remains active before clearing this turn's
    // job. The daemon owns both queues and hidden goal reviews, so clients no
    // longer need to guess whether a streaming=false update is only transient.
    const shutdownMode = getDaemonShutdownMode();
    const allQueued = shutdownMode ? [] : convStore.getQueuedMessages(convId);
    let shouldReviewActiveGoal = false;
    if (shutdownMode) {
      convStore.clearGoalReviewAfterStream(convId);
      log("info", `orchestrator: preserved queued messages for ${convId} during daemon ${shutdownMode}`);
    } else if (allQueued.length === 0) {
      const resumeRequestedAfterStream = convStore.consumeGoalReviewAfterStream(convId);
      shouldReviewActiveGoal = conv.goal?.status === "active"
        && (resumeRequestedAfterStream || (outcome?.ok === true && !outcome.aborted && !outcome.suspended));
    }
    const streamChainContinues = allQueued.length > 0 || shouldReviewActiveGoal;
    if (streamChainContinues) {
      convStore.beginStreamHandoff(convId, shouldReviewActiveGoal && allQueued.length === 0 ? "goal_controller" : undefined);
    }

    const stoppedStreamSeq = convStore.nextStreamSeq(convId);
    const streamStopReason: StreamingStopReason | undefined = ac.signal.aborted && ac.signal.reason === "daemon-restart"
      ? "daemon-restart"
      : outcome?.suspended
        ? "suspended"
        : undefined;
    const publishedStopReason: StreamingStopReason | undefined = streamChainContinues
      ? "handoff"
      : streamStopReason;
    convStore.clearActiveJob(convId);
    convStore.clearCurrentStreamingBlocks(convId);
    convStore.resetChunkCounter(convId);
    if (outcome && !manualCompaction && !outcome.suspended) settlePendingSubagentNotifications(convId, outcome);
    if (interruptedSleep) completeDeferredChronoSleepResume(interruptedSleep.id);
    // unwindTo persists a small truncation overlay after this finalizer stops.
    // Saving the interrupted suffix here would be both obsolete and a full-file
    // rewrite on the unwind critical path.
    const historyUnwindPending = convStore.isHistoryUnwindPending(convId, ac);
    if (!historyUnwindPending) {
      convStore.markDirty(convId);
      convStore.flush(convId);

      server.sendToSubscribers(convId, {
        type: "streaming_stopped",
        convId,
        streamSeq: stoppedStreamSeq,
        ...(publishedStopReason ? { reason: publishedStopReason } : {}),
        persistedBlocks: abortPersistedBlocks,
      });
      // During a handoff getSummary remains streaming=true. The final turn in
      // the chain is the only one that publishes streaming=false/unread=true.
      broadcastConversationUpdated(server, convId, publishedStopReason);

      // Reconcile clients after multi-round/marker/queued-turn event streams from
      // the canonical committed ordering. Paginated clients receive the bounded
      // durable projection; only compatibility clients require a full rebuild.
      if (agentState.completedMessages.length > 0 || transcriptMarkers.length > 0 || hadNextTurnInjections) {
        const storedPage = convStore.getStoredDisplayPage(convId, BUFFERED_HISTORY_TURNS);
        if (storedPage) {
          const paginated = buildStoredHistoryUpdatedEvent(storedPage);
          if (server.hasLegacyHistorySubscribers(convId)) {
            const displayData = convStore.getRenderSnapshot(convId, false);
            if (displayData) {
              const legacy = buildHistoryUpdatedEvents(displayData).legacy;
              server.sendHistoryUpdatedToSubscribers(convId, legacy, paginated);
            }
          } else {
            server.sendHistoryUpdatedToSubscribers(convId, paginated, paginated);
          }
        } else {
          // Direct in-memory maintenance mutations can deliberately invalidate a
          // projection. Preserve the legacy safety fallback for those rare paths.
          const displayData = convStore.getRenderSnapshot(convId, false);
          if (displayData) {
            const events = buildHistoryUpdatedEvents(displayData);
            server.sendHistoryUpdatedToSubscribers(convId, events.legacy, events.paginated);
          }
        }
      }
    } else {
      // Preserve the stream lifecycle for diagnostics and clients that clear
      // spinners on stop, without publishing the suffix the targeted unwind is
      // about to discard.
      server.sendToSubscribers(convId, {
        type: "streaming_stopped",
        convId,
        streamSeq: stoppedStreamSeq,
        reason: "unwind",
      });
    }

    if (hadGoalAtStart || conv.goal) {
      server.sendToSubscribers(convId, { type: "goal_updated", convId, goal: conv.goal ?? null });
    }

    ext.onComplete();

    const settleFailedStreamHandoff = () => {
      // A successor can fail preflight before setActiveJob atomically replaces
      // the handoff marker. In that case publish the real terminal state now.
      if (!convStore.isStreamHandoffActive(convId)) return;
      convStore.clearStreamHandoff(convId);
      broadcastConversationUpdated(server, convId);
    };

    // Start the first remaining queued message as a new turn. "next-turn"
    // messages that arrived too late join message-end messages here. The entry
    // remains durable until the successor persists its user message.
    if (allQueued.length > 0) {
      const first = allQueued[0];
      log("info", `orchestrator: draining queued message: "${first.text.slice(0, 50)}"`);
      // Await to keep queued turns in one promise. The private handoff option
      // is intentionally unavailable to ordinary callers.
      const queuedOutcome = await orchestrateAssistantTurn(server, null, undefined, convId, Date.now(), ext, {
        userMessage: { text: first.text, images: first.images },
        subagentMaxDepth: first.subagentMaxDepth ?? null,
        subagentNotificationId: first.subagentNotificationId,
        queueEntryId: first.id,
        automation: first.automation,
        streamChainHandoff: true,
      });
      // A successful queued worker may have installed its own goal-review
      // handoff. Clear only a marker left unconsumed by failed preflight.
      if (!queuedOutcome.ok && !convStore.getActiveJob(convId)) settleFailedStreamHandoff();
    } else if (shouldReviewActiveGoal) {
      queueMicrotask(() => {
        const latest = convStore.get(convId);
        if (!latest?.goal || latest.goal.status !== "active" || convStore.getQueuedMessages(convId).length > 0) {
          settleFailedStreamHandoff();
          return;
        }
        log("info", `orchestrator: reviewing active goal for ${convId}: "${latest.goal.objective.slice(0, 80)}"`);
        void orchestrateGoalReviewHandoff(server, convId, ext).catch((err) => {
          log("error", `orchestrator: goal review failed for ${convId}: ${err instanceof Error ? err.message : String(err)}`);
          settleFailedStreamHandoff();
        });
      });
    }
  }

  return outcome ?? buildErrorOutcome("Assistant turn ended without an outcome.");
}
