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
import { buildAnthropicSystemPrompt, buildSystemPrompt } from "./system";
import { getMaxContext, supportsImageInputs } from "./providers/registry";
import { getToolDefs, buildExecutor, summarizeTool, type ContextToolEnv } from "./tools/registry";
import * as convStore from "./conversations";
import type { DaemonServer, ConnectedClient } from "./server";
import { buildHistoryTurnMap, createMessageMetadata, isHistoryMessage, isToolResultMessage, type StoredMessage, type ApiContentBlock, type ModelId, type Block } from "./messages";
import type { ContentBlock as ProviderContentBlock, StreamRetryMetadata } from "./providers/types";
import type { ImageAttachment } from "@exocortex/shared/messages";
import type { ToolExecutionContext } from "./tools/types";
import { complete } from "./llm";
import { getInnerLlmSummaryOptions } from "./tools/inner-llm";

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Interleave retry system markers into a message array at the correct positions.
 * Each marker's `afterIndex` indicates how many messages should precede it.
 *
 * Example: marker at afterIndex=6 goes between messages[5] and messages[6].
 *
 * Markers must be sorted by afterIndex (ascending). This holds naturally
 * since they're appended chronologically and completed-round counts are
 * monotonically non-decreasing.
 */
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
  return `⟳ ${errorMessage} — retrying in ${delaySec}s (${attempt}/${maxAttempts})…`;
}

function interleaveRetryMarkers(
  messages: StoredMessage[],
  markers: Array<{ afterIndex: number; text: string }>,
): StoredMessage[] {
  if (markers.length === 0) return messages;
  const result: StoredMessage[] = [];
  let mi = 0;
  for (let i = 0; i < messages.length; i++) {
    while (mi < markers.length && markers[mi].afterIndex <= i) {
      result.push({ role: "system", content: markers[mi].text, metadata: null });
      mi++;
    }
    result.push(messages[i]);
  }
  // Trailing markers (after all messages)
  while (mi < markers.length) {
    result.push({ role: "system", content: markers[mi].text, metadata: null });
    mi++;
  }
  return result;
}

// ── Types ──────────────────────────────────────────────────────────

export interface OrchestrationCallbacks {
  /** Called with response headers (for usage/rate-limit parsing). */
  onHeaders(headers: Headers): void;
  /** Called after the message completes (for usage refresh). */
  onComplete(): void;
}

// ── Helpers ───────────────────────────────────────────────────────

/** Build API-ready user content — structured array when images are present, plain string otherwise. */
function buildUserContent(text: string, images?: ImageAttachment[]): string | ApiContentBlock[] {
  if (!images?.length) return text;
  return [
    ...images.map((img): ApiContentBlock => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    })),
    ...(text ? [{ type: "text" as const, text }] : []),
  ];
}

/** Build a stored user message from text + optional images. */
function buildStoredUserMessage(
  text: string,
  model: ModelId,
  startedAt: number,
  images?: ImageAttachment[],
): StoredMessage {
  return {
    role: "user",
    content: buildUserContent(text, images),
    metadata: createMessageMetadata(startedAt, model, { endedAt: startedAt }),
  };
}

/** Convert API messages to stored-message shape for transient display state. */
function toStoredMessages(messages: import("./messages").ApiMessage[]): StoredMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    metadata: null,
    providerData: m.providerData,
  }));
}

function hasReplayableHistory(messages: StoredMessage[]): boolean {
  return messages.some(isHistoryMessage);
}

/**
 * Protect the entire in-progress turn when replaying after a failed stream.
 *
 * We walk backward to the most recent real user prompt (ignoring tool_result
 * containers) and protect every history turn from there to the end, so the
 * context tool can't trim away the prompt/partial reply that the replay is
 * currently continuing.
 */
function protectedTailCountForReplay(messages: StoredMessage[]): number {
  const turnMap = buildHistoryTurnMap(messages);
  if (turnMap.length === 0) return 0;

  for (let turn = turnMap.length - 1; turn >= 0; turn--) {
    const msg = messages[turnMap[turn]];
    if (msg.role === "user" && !isToolResultMessage(msg)) {
      return turnMap.length - turn;
    }
  }

  return turnMap.length;
}

/**
 * Whether a partially streamed thinking block is safe to persist on abort/error.
 *
 * Anthropic requires a signature for replayable thinking blocks, so an empty
 * signature with empty thinking is junk. OpenAI reasoning summaries do not
 * carry signatures, so any non-empty thinking text is still worth preserving.
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
}

interface AssistantTurnOptions {
  userMessage?: {
    text: string;
    images?: ImageAttachment[];
  };
}

export async function orchestrateSendMessage(
  server: DaemonServer,
  client: ConnectedClient | null,
  reqId: string | undefined,
  convId: string,
  text: string,
  startedAt: number,
  ext: OrchestrationCallbacks,
  images?: ImageAttachment[],
): Promise<AssistantTurnOutcome> {
  return await orchestrateAssistantTurn(server, client, reqId, convId, startedAt, ext, {
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
): Promise<AssistantTurnOutcome> {
  return await orchestrateAssistantTurn(server, client, reqId, convId, startedAt, ext);
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

  const { userMessage } = options;
  const replaying = !userMessage;

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
    server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(convId)! });
    server.sendToSubscribers(convId, { type: "system_message", convId, text, color: "error" });
    return buildErrorOutcome(text);
  };

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
  if (replaying && !hasReplayableHistory(conv.messages)) {
    return reportSendError("No conversation history to replay.");
  }

  if (userMessage) {
    conv.messages.push(buildStoredUserMessage(userMessage.text, conv.model, startedAt, userMessage.images));

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

  conv.updatedAt = Date.now();
  convStore.bumpToTop(convId);

  const ac = new AbortController();
  convStore.setActiveJob(convId, ac, startedAt);
  convStore.initStreamingState(convId);

  // Broadcast sidebar update (streaming indicator)
  server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(convId)! });
  server.sendToSubscribers(convId, { type: "streaming_started", convId, provider: conv.provider, model: conv.model, startedAt });

  // Extract per-conversation system instructions (if present)
  const systemInstructionsText = convStore.getSystemInstructions(convId);

  // System messages and per-conversation instructions are persisted but never sent as API history messages.
  const apiMessages = conv.messages
    .filter(isHistoryMessage)
    .map((m) => ({
      role: m.role,
      content: m.content,
      providerData: m.providerData,
    }));

  // ── Context tool support ──────────────────────────────────────────
  // Track whether context was modified this round so the agent loop
  // can rebuild its local message array from the mutated conv.messages.
  let contextModifiedThisRound = false;

  // Track whether any next-turn messages were injected mid-stream.
  // When true, the success path sends history_updated so the TUI
  // rebuilds its display with correct interleaving.
  let hadNextTurnInjections = false;

  // Retry markers — tracked with their position (number of completed
  // messages at the time of the retry) so they can be interleaved at
  // the correct spot in conv.messages on the success/error path.
  const retryMarkers: Array<{ afterIndex: number; text: string }> = [];

  // While sending a fresh message, protect the just-appended user turn.
  // While replaying after an interrupted stream, protect the full in-progress
  // tail (last real user prompt plus any partial assistant/tool messages).
  const protectedTailCount = userMessage ? 1 : protectedTailCountForReplay(conv.messages);

  const toolContext: ToolExecutionContext = {
    provider: conv.provider,
    conversationId: convId,
    model: conv.model,
  };

  const contextEnv: ContextToolEnv = {
    conv,
    onContextModified: () => { contextModifiedThisRound = true; },
    summarizer: (name, input) => {
      const s = summarizeTool(name, input);
      return s.detail || s.label;
    },
    protectedTailCount,
    contextLimit: getMaxContext(conv.provider, conv.model),
    summarizeWithInnerLlm: async (systemPrompt, userText, maxTokens, signal) => {
      const llmOptions = getInnerLlmSummaryOptions(toolContext);
      const result = await complete(systemPrompt, userText, {
        ...llmOptions,
        maxTokens,
        signal,
        tracking: { source: "context_summary", conversationId: convId },
      });
      return result.text;
    },
  };

  // Agent state for abort recovery — the agent populates completedMessages
  // after each full round. partialContent tracks the in-flight round only
  // (cleared via onRoundComplete between rounds).
  const agentState: AgentState = { completedMessages: [], completedBlocks: [], tokens: 0 };
  const partialContent: import("./messages").ApiContentBlock[] = [];
  /** Blocks that survived persistence on abort/error — sent to TUI so it can trim display. */
  let abortPersistedBlocks: import("./messages").Block[] | undefined;
  let outcome: AssistantTurnOutcome | undefined;

  function completedDisplayMessages(): StoredMessage[] {
    return toStoredMessages(agentState.completedMessages);
  }

  function syncStreamingDisplayMessages(messages: StoredMessage[]): void {
    convStore.replaceStreamingDisplayMessages(convId, interleaveRetryMarkers(messages, retryMarkers));
  }

  function syncCompletedStreamingDisplayMessages(): void {
    syncStreamingDisplayMessages(completedDisplayMessages());
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

  const callbacks: AgentCallbacks = {
    onBlockStart(blockType) {
      convStore.touchActivity(convId);
      server.sendToSubscribers(convId, { type: "block_start", convId, blockType });
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
      server.sendToSubscribers(convId, { type: "text_chunk", convId, text: chunk });
      const block = ensurePartialContentTail("text");
      if (block.type === "text") block.text += chunk;
      convStore.appendToStreamingBlock(convId, "text", chunk);
      // touchActivity piggybacks on the chunk counter — fires every CHUNK_SAVE_INTERVAL
      // chunks rather than on every single SSE event, keeping overhead negligible.
      if (convStore.onChunk(convId)) convStore.touchActivity(convId);
    },
    onThinkingChunk(chunk) {
      server.sendToSubscribers(convId, { type: "thinking_chunk", convId, text: chunk });
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
      server.sendToSubscribers(convId, { type: "streaming_sync", convId, blocks: syncedBlocks });
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
      server.sendToSubscribers(convId, { type: "tokens_update", convId, tokens });
    },
    onContextUpdate(contextTokens) {
      conv.lastContextTokens = contextTokens;
      server.sendToSubscribers(convId, { type: "context_update", convId, contextTokens });
    },
    onHeaders(headers) {
      convStore.touchActivity(convId);
      ext.onHeaders(headers);
    },
    onRetry(attempt, maxAttempts, errorMessage, delaySec, metadata) {
      convStore.touchActivity(convId);
      // Provider retry → clear partial state so the retry starts clean.
      // Completed rounds stay visible via streamingDisplayMessages.
      partialContent.length = 0;
      convStore.initStreamingState(convId);
      // Track for correct interleaving on the success/error path.
      // Don't push to conv.messages now — newMessages haven't been pushed yet,
      // so a system message here would end up before all AI blocks.
      const sysText = formatRetryNotice(attempt, maxAttempts, errorMessage, delaySec, metadata);
      retryMarkers.push({ afterIndex: agentState.completedMessages.length, text: sysText });
      syncCompletedStreamingDisplayMessages();
      server.sendToSubscribers(convId, {
        type: "stream_retry",
        convId,
        attempt,
        maxAttempts,
        errorMessage,
        delaySec,
        ...(metadata?.kind ? { kind: metadata.kind } : {}),
        ...(metadata?.resetAt != null ? { resetAt: metadata.resetAt } : {}),
      });
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
    },
    drainNextTurnMessages() {
      const drained = convStore.drainQueuedMessages(convId, "next-turn");
      if (drained.length === 0) return [];

      hadNextTurnInjections = true;
      const apiMsgs: import("./messages").ApiMessage[] = [];
      const injectedStored: StoredMessage[] = [];
      for (const qm of drained) {
        const injectedStartedAt = Date.now();
        // Broadcast to TUI subscribers so they see the queued message appear.
        // Don't push to conv.messages — the agent loop includes injected
        // messages in newMessages, which get pushed on the success/abort path.
        server.sendToSubscribers(convId, {
          type: "user_message",
          convId,
          text: qm.text,
          startedAt: injectedStartedAt,
          images: qm.images,
        });
        const storedUser = buildStoredUserMessage(qm.text, conv.model, injectedStartedAt, qm.images);
        apiMsgs.push({ role: "user", content: storedUser.content });
        injectedStored.push(storedUser);
        log("info", `orchestrator: injected next-turn message: "${qm.text.slice(0, 50)}"`);
      }
      syncStreamingDisplayMessages([...toStoredMessages(agentState.completedMessages), ...injectedStored]);
      return apiMsgs;
    },
    rebuildMessages(): import("./messages").ApiMessage[] | null {
      if (!contextModifiedThisRound) return null;
      contextModifiedThisRound = false;
      log("info", `orchestrator: context modified, rebuilding message array`);
      // Rebuild from conv.messages (now trimmed) — the source of truth for historical state
      const rebuilt = conv.messages
        .filter(isHistoryMessage)
        .map(m => ({ role: m.role, content: m.content, providerData: m.providerData }));
      // Persist immediately
      convStore.markDirty(convId);
      convStore.flush(convId);
      // Notify TUI subscribers — replace historical messages without touching pendingAI
      const displayData = convStore.getRenderSnapshot(convId, false);
      if (displayData) {
        server.sendToSubscribers(convId, {
          type: "history_updated",
          convId,
          entries: displayData.entries,
          contextTokens: displayData.contextTokens,
          toolOutputsIncluded: displayData.toolOutputsIncluded,
        });
      }
      return rebuilt;
    },
  };

  // Pause staleness tracking during tool execution. Tools can run for
  // hours (e.g. kernel builds, long test suites) — the watchdog has no
  // business timing them out. When tools finish, resume tracking so the
  // watchdog catches a hung model on the *next* API streaming call.
  const rawExecutor = buildExecutor(contextEnv, toolContext);
  const executor: typeof rawExecutor = async (calls, signal?) => {
    convStore.pauseActivity(convId);
    try {
      return await rawExecutor(calls, signal);
    } finally {
      convStore.resumeActivity(convId);
    }
  };

  try {
    const result = await runAgentLoop(apiMessages, conv.provider, conv.model, callbacks, {
      system: conv.provider === "anthropic"
        ? buildAnthropicSystemPrompt(systemInstructionsText ?? undefined)
        : buildSystemPrompt(systemInstructionsText ?? undefined),
      signal: ac.signal,
      tools: getToolDefs(),
      executor,
      summarizer: (name, input) => {
        const s = summarizeTool(name, input);
        return s.detail || s.label;
      },
      effort: conv.effort,
      serviceTier: conv.fastMode ? "fast" : undefined,
      promptCacheKey: convId,
      tracking: { source: "conversation", conversationId: convId },
      state: agentState,
    });

    const endedAt = Date.now();
    outcome = {
      ok: true,
      blocks: result.blocks,
      tokens: result.tokens,
      durationMs: endedAt - startedAt,
      endedAt,
    };

    // Convert ApiMessage[] → StoredMessage[], stamp metadata on last assistant
    const storedMessages: StoredMessage[] = result.newMessages.map(m => ({
      role: m.role,
      content: m.content,
      metadata: null,
      providerData: m.providerData,
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
    // Interleave retry markers at the correct positions so system messages
    // appear between the rounds where they actually occurred.
    const interleavedMessages = interleaveRetryMarkers(storedMessages, retryMarkers);
    conv.messages.push(...interleavedMessages);
    conv.updatedAt = Date.now();
    convStore.bumpToTop(convId);

    server.sendToSubscribers(convId, {
      type: "message_complete",
      convId,
      blocks: result.blocks,
      endedAt,
      tokens: result.tokens,
    });

    log("info", `orchestrator: message complete for ${convId} (${result.tokens} tokens, ${result.blocks.length} blocks, ${endedAt - startedAt}ms)`);

    // Mark unread if no client is viewing this conversation
    if (!server.hasSubscribers(convId)) {
      convStore.markUnread(convId);
    }

    // Persist and notify sidebar
    convStore.markDirty(convId);
    convStore.flush(convId);
    server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(convId)! });

  } catch (err) {
    const isAbort = ac.signal.aborted;

    const isWatchdog = isAbort && ac.signal.reason === "watchdog";

    if (!isAbort) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", `orchestrator: stream error for ${convId}: ${msg}`);
      // Don't also emit a conversation-scoped `error` event here: the catch
      // path already persists and broadcasts a canonical `system_message`
      // below, and sending both makes the TUI render the same failure twice.
    } else if (isWatchdog) {
      log("warn", `orchestrator: stream timed out for ${convId} (watchdog)`);
    } else {
      log("info", `orchestrator: stream interrupted for ${convId}`);
    }

    // Persist completed rounds from the agent (full tool-use exchanges),
    // interleaving retry markers at the correct positions.
    const completedStored: StoredMessage[] = agentState.completedMessages.map(m => ({
      role: m.role,
      content: m.content,
      metadata: null,
      providerData: m.providerData,
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
    const interleavedCompleted = interleaveRetryMarkers(completedStored, retryMarkers);
    if (interleavedCompleted.length > 0) {
      conv.messages.push(...interleavedCompleted);
    }

    // Persist the in-flight partial response (current round's streamed content).
    // Strip only Anthropic-style empty-signature thinking blocks — OpenAI
    // summaries don't carry signatures, so keep any non-empty thinking text.
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

    // Persist and broadcast system message
    let outcomeError: string;
    if (isWatchdog) {
      const sysText = "✗ Timed out (stale stream)";
      outcomeError = sysText;
      conv.messages.push({ role: "system", content: sysText, metadata: null });
      server.sendToSubscribers(convId, { type: "system_message", convId, text: sysText, color: "error" });
    } else if (isAbort) {
      const sysText = "✗ Interrupted";
      outcomeError = sysText;
      conv.messages.push({ role: "system", content: sysText, metadata: null });
      server.sendToSubscribers(convId, { type: "system_message", convId, text: sysText, color: "error" });
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      const sysText = `✗ ${errMsg}`;
      outcomeError = sysText;
      conv.messages.push({ role: "system", content: sysText, metadata: null });
      server.sendToSubscribers(convId, { type: "system_message", convId, text: sysText, color: "error" });
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
    };
  } finally {
    convStore.clearActiveJob(convId);
    convStore.clearCurrentStreamingBlocks(convId);
    convStore.resetChunkCounter(convId);
    convStore.markDirty(convId);
    convStore.flush(convId);
    server.sendToSubscribers(convId, { type: "streaming_stopped", convId, persistedBlocks: abortPersistedBlocks });
    // Broadcast updated summary (streaming=false, possibly unread=true)
    server.broadcast({ type: "conversation_updated", summary: convStore.getSummary(convId)! });

    // When the active stream built up any transient display-only history
    // (completed rounds for late joiners, retries, or next-turn injections),
    // the TUI may be showing an approximate live view. Now that conv.messages
    // has the canonical interleaved structure, send history_updated so every
    // client rebuilds from the persisted ordering.
    if (agentState.completedMessages.length > 0 || retryMarkers.length > 0 || hadNextTurnInjections) {
      const displayData = convStore.getRenderSnapshot(convId, false);
      if (displayData) {
        server.sendToSubscribers(convId, {
          type: "history_updated",
          convId,
          entries: displayData.entries,
          contextTokens: displayData.contextTokens,
          toolOutputsIncluded: displayData.toolOutputsIncluded,
        });
      }
    }

    ext.onComplete();

    // Drain remaining queued messages. "next-turn" messages that weren't
    // injected mid-stream (e.g. no tool rounds, or queued too late) end up
    // here alongside "message-end" messages. Send the first as a new turn,
    // re-queue the rest — they'll drain on the next streaming_stopped.
    const allQueued = convStore.drainQueuedMessages(convId);
    if (allQueued.length > 0) {
      const first = allQueued[0];
      // Re-queue the rest for the next cycle
      for (let i = 1; i < allQueued.length; i++) {
        convStore.pushQueuedMessage(convId, allQueued[i].text, allQueued[i].timing, allQueued[i].images);
      }
      log("info", `orchestrator: draining queued message: "${first.text.slice(0, 50)}"`);
      // Kick off a new send cycle — null client so user_message broadcasts to everyone.
      // Await to keep the chain in a single promise so errors propagate and
      // the conversation stays consistent (no orphaned background streams).
      await orchestrateSendMessage(server, null, undefined, convId, first.text, Date.now(), ext, first.images);
    }
  }

  return outcome ?? buildErrorOutcome("Assistant turn ended without an outcome.");
}
