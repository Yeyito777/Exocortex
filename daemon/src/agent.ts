/**
 * Agent loop for exocortexd.
 *
 * Drives the stream → tool calls → execute → stream cycle.
 * Each invocation produces one AI Message (a sequence of blocks).
 *
 * The loop is tool-executor agnostic — callers inject an executor
 * function. Without one, the loop completes after the first API
 * response (pure conversation mode).
 */

import { streamMessage, type ApiToolCall, type ProviderTurnSession } from "./api";
import { log } from "./log";
import { recordToolCallDiagnostics } from "./diagnostics";
import { type ProviderId, type ModelId, type EffortLevel, type Block, type ToolCallBlock, type ToolResultBlock, type ApiMessage, type ApiContentBlock, type TokenTrackingContext } from "./messages";
import type { ContentBlock as ProviderContentBlock, ServiceTier, StreamRetryMetadata } from "./providers/types";
import { MAX_OUTPUT_CHARS, cap } from "./tools/util";
import { getMaxContext } from "./providers/registry";
import { estimateContextTokens, isContextWindowError, shouldAutoCompact, type CompactionReason } from "./context-compaction";

// ── Callbacks ───────────────────────────────────────────────────────

export interface AgentCallbacks {
  /** A new text or thinking block has started streaming. */
  onBlockStart(type: "text" | "thinking"): void;
  /** A text chunk has arrived (append to current text block). */
  onTextChunk(text: string): void;
  /** A thinking chunk has arrived (append to current thinking block). */
  onThinkingChunk(text: string): void;
  /** Replace the current round's live text/thinking blocks with canonical provider state. */
  onBlocksUpdate?(blocks: ProviderContentBlock[]): void;
  /** A thinking block's signature has been received. */
  onSignature(signature: string): void;
  /** The API returned a tool call (after the response completes). */
  onToolCall(block: ToolCallBlock): void;
  /** A tool has finished executing. */
  onToolResult(block: ToolResultBlock): void;
  /** Accumulated output token count updated (fires after each API round). */
  onTokensUpdate(tokens: number): void;
  /** Input (context) token count from the latest API round. */
  onContextUpdate(contextTokens: number, inputMessages?: ApiMessage[]): void;
  /** Response headers received (fires once per API round, carries rate-limit info). */
  onHeaders(headers: Headers): void;
  /** A provider retry was scheduled. Reset any accumulated partial state. */
  onRetry?(attempt: number, maxAttempts: number, errorMessage: string, delaySec: number, metadata?: StreamRetryMetadata): void;
  /** Pause/resume stale-stream watchdogs around intentional long retry waits. */
  onRetryWaitStart?(): void;
  onRetryWaitEnd?(): void;
  /** A tool-use round completed — all tool results received, next API call starting. */
  onRoundComplete?(): void;
  /** Completed raw messages (including queued injections) are safe to persist. */
  onRecoveryStateUpdate?(): void;
  /**
   * Drain "next-turn" queued messages between tool rounds.
   * Called after onRoundComplete — returns user messages to inject
   * into the conversation before the next API call.
   */
  drainNextTurnMessages?(): ApiMessage[];
  /** Atomically replace active provider replay with an automatic checkpoint. */
  compactContext?(messages: ApiMessage[], reason: CompactionReason, projectedTokens: number): Promise<ApiMessage[] | null>;
}

// ── Tool execution ──────────────────────────────────────────────────

export interface ToolExecResult {
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
  image?: { mediaType: string; base64: string };
}

/**
 * A function that executes tool calls and returns results.
 * Injected by the caller — the agent loop doesn't know what tools exist.
 * The optional signal lets the executor abort in-flight tool calls.
 */
export type ToolExecutor = (calls: ApiToolCall[], signal?: AbortSignal) => Promise<ToolExecResult[]>;

// ── Result ──────────────────────────────────────────────────────────

export interface AgentResult {
  /** All blocks produced during this AI message, in order (for TUI display). */
  blocks: Block[];
  /** The actual API messages added during this turn — correct roles and structure.
   *  For a tool-use turn this is: [assistant, user(tool_result), assistant, user(tool_result), assistant].
   *  For a simple response: [assistant]. Persisted as-is — replays correctly. */
  newMessages: ApiMessage[];
  /** Full active provider replay after any automatic checkpoint replacements. */
  contextMessages: ApiMessage[];
  contextCompacted: boolean;
  tokens: number;
  /** Output tokens from the final provider round (not accumulated tool rounds). */
  lastOutputTokens: number;
  durationMs: number;
}

/**
 * Mutable state exposed to the caller for crash/abort recovery.
 * The orchestrator reads completedMessages on abort to persist
 * finished rounds without maintaining a parallel tracker.
 */
export interface AgentState {
  /** Messages from fully completed rounds (not the in-flight one). */
  completedMessages: ApiMessage[];
  /** Display blocks from fully completed rounds (for TUI abort recovery). */
  completedBlocks: Block[];
  /** Accumulated output tokens so far. */
  tokens: number;
  /** Latest replay known to be internally complete, for abort recovery. */
  contextMessages: ApiMessage[];
  contextCompacted: boolean;
}

// ── Tool summarizer ─────────────────────────────────────────────────

/** Injected function that produces a display summary for a tool call. */
export type ToolSummarizer = (name: string, input: Record<string, unknown>) => string;

/** Fallback if no summarizer is provided. */
function defaultSummarizer(name: string, _input: Record<string, unknown>): string {
  return name;
}

// ── Agent loop ──────────────────────────────────────────────────────

export async function runAgentLoop(
  initialMessages: ApiMessage[],
  provider: ProviderId,
  model: ModelId,
  callbacks: AgentCallbacks,
  options: {
    system?: string;
    signal?: AbortSignal;
    executor?: ToolExecutor;
    summarizer?: ToolSummarizer;
    maxTokens?: number;
    tools?: unknown[];
    effort?: EffortLevel;
    serviceTier?: ServiceTier;
    promptCacheKey?: string;
    /** Token-accounting metadata for each API round in this loop. */
    tracking?: TokenTrackingContext;
    /** Provider-created state shared by all API rounds in this assistant turn. */
    turnSession?: ProviderTurnSession;
    /** Mutable state for abort recovery — caller reads on catch. */
    state?: AgentState;
    /** Test seam for provider streaming. Production always uses streamMessage. */
    streamMessageFn?: typeof streamMessage;
    /** Resolve the current logical window after a compaction replacement. */
    getCodexWindowId?: () => string | undefined;
    /** One-way provider-account identity frozen by the turn orchestrator. */
    accountScope?: string;
    codexTurnId?: string;
    codexTurnStartedAtMs?: number;
  } = {},
): Promise<AgentResult> {
  const allBlocks: Block[] = [];
  const newMessages: ApiMessage[] = [];
  const messages = [...initialMessages];
  const startTime = Date.now();
  let totalOutputTokens = 0;
  let lastInputTokens = 0;
  let lastOutputTokens = 0;
  let contextCompacted = false;

  // Expose state for abort recovery
  const state = options.state;
  if (state) {
    state.completedMessages = [];
    state.contextMessages = [...messages];
    state.contextCompacted = false;
    state.tokens = 0;
  }

  for (let round = 0; ; round++) {
    log("info", `agent: round ${round}, messages=${messages.length}, provider=${provider}, model=${model}`);

    // ── Stream one API response ───────────────────────────────────
    let result;
    let retriedAfterContextError = false;
    let roundEmittedOutput = false;
    while (true) {
      try {
        result = await (options.streamMessageFn ?? streamMessage)(provider, messages, model, {
          onText: (text) => { roundEmittedOutput = true; callbacks.onTextChunk(text); },
          onThinking: (text) => { roundEmittedOutput = true; callbacks.onThinkingChunk(text); },
          onBlockStart: (type) => { roundEmittedOutput = true; callbacks.onBlockStart(type); },
          onBlocksUpdate: (blocks) => { if (blocks.length > 0) roundEmittedOutput = true; callbacks.onBlocksUpdate?.(blocks); },
          onSignature: (signature) => { roundEmittedOutput = true; callbacks.onSignature(signature); },
          onToolCall: (block) => { roundEmittedOutput = true; callbacks.onToolCall(block); },
          onToolResult: (block) => { roundEmittedOutput = true; callbacks.onToolResult(block); },
          onHeaders: callbacks.onHeaders,
          onRetry: callbacks.onRetry,
          onRetryWaitStart: callbacks.onRetryWaitStart,
          onRetryWaitEnd: callbacks.onRetryWaitEnd,
        }, {
          system: options.system,
          signal: options.signal,
          maxTokens: options.maxTokens,
          tools: options.tools,
          effort: options.effort,
          serviceTier: options.serviceTier,
          promptCacheKey: options.promptCacheKey,
          tracking: options.tracking,
          turnSession: options.turnSession,
          codexWindowId: options.getCodexWindowId?.(),
          accountScope: options.accountScope,
          codexTurnId: options.codexTurnId,
          codexTurnStartedAtMs: options.codexTurnStartedAtMs,
        });
        break;
      } catch (error) {
        if (roundEmittedOutput || retriedAfterContextError || !callbacks.compactContext || !isContextWindowError(error)) throw error;
        retriedAfterContextError = true;
        const replacement = await callbacks.compactContext(messages, "context_error", Number.POSITIVE_INFINITY);
        if (!replacement) throw error;
        messages.length = 0;
        messages.push(...replacement);
        contextCompacted = true;
        if (state) {
          state.contextMessages = [...messages];
          state.contextCompacted = true;
        }
        log("info", `agent: compacted after context-window error; retrying round ${round}`);
      }
    }

    lastOutputTokens = result.outputTokens ?? 0;
    if (result.outputTokens) {
      totalOutputTokens += result.outputTokens;
      callbacks.onTokensUpdate(totalOutputTokens);
    }

    if (result.inputTokens) {
      lastInputTokens = result.inputTokens;
      callbacks.onContextUpdate(result.inputTokens, messages);
    }

    // ── Collect content blocks (thinking + text) ──────────────────
    for (const block of result.blocks) {
      if (block.type === "thinking") {
        allBlocks.push({ type: "thinking", text: block.text });
        if (block.signature) callbacks.onSignature(block.signature);
      } else if (block.type === "text") {
        allBlocks.push({ type: "text", text: block.text });
      } else if (block.type === "tool_call") {
        allBlocks.push({
          type: "tool_call",
          toolCallId: block.id,
          toolName: block.name,
          input: block.input,
          summary: block.summary,
        });
      } else if (block.type === "tool_result") {
        allBlocks.push({
          type: "tool_result",
          toolCallId: block.toolUseId,
          toolName: block.toolName,
          output: block.output,
          isError: block.isError,
        });
      }
    }

    // ── Build assistant API message for conversation continuity ───
    const assistantContent: ApiMessage["content"] = [];
    for (const block of result.blocks) {
      if (block.type === "thinking") {
        assistantContent.push({ type: "thinking", thinking: block.text, signature: block.signature });
      } else if (block.type === "text") {
        assistantContent.push({ type: "text", text: block.text });
      } else if (block.type === "tool_call") {
        assistantContent.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      } else if (block.type === "tool_result") {
        assistantContent.push({ type: "tool_result", tool_use_id: block.toolUseId, content: block.output, is_error: block.isError });
      }
    }
    for (const tc of result.toolCalls) {
      assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    const assistantMsg: ApiMessage = {
      role: "assistant",
      content: assistantContent,
      ...(result.assistantProviderData ? { providerData: result.assistantProviderData } : {}),
    };
    messages.push(assistantMsg);
    newMessages.push(assistantMsg);

    // ── No tool calls → done ──────────────────────────────────────
    if (result.toolCalls.length === 0) {
      log("info", `agent: round ${round} complete (no tool calls), stopReason=${result.stopReason}`);
      break;
    }

    log("info", `agent: round ${round}: ${result.toolCalls.length} tool call(s): ${result.toolCalls.map(tc => tc.name).join(", ")}`);
    // ── Emit tool call blocks ─────────────────────────────────────
    for (const tc of result.toolCalls) {
      const block: ToolCallBlock = {
        type: "tool_call",
        toolCallId: tc.id,
        toolName: tc.name,
        input: tc.input,
        summary: (options.summarizer ?? defaultSummarizer)(tc.name, tc.input),
      };
      allBlocks.push(block);
      callbacks.onToolCall(block);
    }

    // ── Execute tools ─────────────────────────────────────────────
    if (!options.executor) {
      log("info", "agent: no executor provided, stopping after tool calls");
      break;
    }

    const toolExecStartedAt = Date.now();
    const execResults = await options.executor(result.toolCalls, options.signal);
    recordToolCallDiagnostics({
      conversationId: options.tracking?.conversationId,
      round,
      calls: result.toolCalls,
      results: execResults,
      batchDurationMs: Date.now() - toolExecStartedAt,
    });

    // ── Emit tool result blocks + build API tool_result message ───
    const toolResultContent: ApiContentBlock[] = [];
    for (const r of execResults) {
      // Central safety net: cap tool output so no tool can brick the conversation,
      // even if the tool's own limiting logic has a bug.
      if (r.output.length > MAX_OUTPUT_CHARS) {
        log("warn", `agent: tool '${r.toolName}' output exceeded ${MAX_OUTPUT_CHARS} chars (${r.output.length}), capping`);
        r.output = cap(r.output);
      }

      const block: ToolResultBlock = {
        type: "tool_result",
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        output: r.output,
        isError: r.isError,
      };
      allBlocks.push(block);
      callbacks.onToolResult(block);

      // Build API-level tool_result — with optional image content
      if (r.image) {
        toolResultContent.push({
          type: "tool_result",
          tool_use_id: r.toolCallId,
          content: [
            { type: "image", source: { type: "base64", media_type: r.image.mediaType, data: r.image.base64 } },
            { type: "text", text: r.output },
          ] as unknown[],
          is_error: r.isError,
        });
      } else {
        toolResultContent.push({
          type: "tool_result",
          tool_use_id: r.toolCallId,
          content: r.output,
          is_error: r.isError,
        });
      }
    }

    const toolResultMsg: ApiMessage = { role: "user", content: toolResultContent };
    messages.push(toolResultMsg);
    newMessages.push(toolResultMsg);
    // The raw round is now durable recovery state. Do this before clearing
    // streaming partials or starting a potentially slow compaction request.
    if (state) {
      state.completedMessages = [...newMessages];
      state.completedBlocks = [...allBlocks];
      state.contextMessages = [...messages];
      state.contextCompacted = contextCompacted;
      state.tokens = totalOutputTokens;
    }
    callbacks.onRoundComplete?.();

    // Inject "next-turn" queued messages between tool rounds.
    const nextTurn = callbacks.drainNextTurnMessages?.() ?? [];
    for (const qm of nextTurn) {
      messages.push(qm);
      newMessages.push(qm);
      log("info", `agent: injected next-turn queued message`);
    }
    // Update raw recovery before compaction so cancellation cannot lose the
    // completed tool round or a queued user message.
    if (state) {
      state.completedMessages = [...newMessages];
      state.contextMessages = [...messages];
    }
    callbacks.onRecoveryStateUpdate?.();

    const contextLimit = getMaxContext(provider, model);
    const assistantGrowthTokens = result.outputTokens != null && result.outputTokens > 0
      ? result.outputTokens
      : estimateContextTokens([assistantMsg], provider);
    const projectedTokens = lastInputTokens > 0
      ? lastInputTokens + assistantGrowthTokens + estimateContextTokens([toolResultMsg, ...nextTurn], provider)
      : estimateContextTokens(messages, provider);
    if (callbacks.compactContext && shouldAutoCompact(projectedTokens, contextLimit)) {
      const replacement = await callbacks.compactContext(messages, "tool_round", projectedTokens);
      if (replacement) {
        messages.length = 0;
        messages.push(...replacement);
        contextCompacted = true;
        log("info", `agent: automatic mid-turn compaction complete (projected=${projectedTokens}, limit=${contextLimit})`);
      }
    }

    // Update recovery state only after queued messages and any checkpoint are complete.
    if (state) {
      state.completedMessages = [...newMessages];
      state.completedBlocks = [...allBlocks];
      state.contextMessages = [...messages];
      state.contextCompacted = contextCompacted;
      state.tokens = totalOutputTokens;
    }

    // Continue loop → next API call with tool results
  }

  return {
    blocks: allBlocks,
    newMessages,
    contextMessages: messages,
    contextCompacted,
    tokens: totalOutputTokens,
    lastOutputTokens,
    durationMs: Date.now() - startTime,
  };
}
