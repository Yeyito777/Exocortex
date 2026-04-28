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

import { streamMessage, type ApiToolCall } from "./api";
import { log } from "./log";
import type { ProviderId, ModelId, EffortLevel, Block, ToolCallBlock, ToolResultBlock, ApiMessage, ApiContentBlock, TokenTrackingContext } from "./messages";
import type { ContentBlock as ProviderContentBlock, ServiceTier, StreamRetryMetadata } from "./providers/types";
import { MAX_OUTPUT_CHARS, cap } from "./tools/util";
import { getMaxContext } from "./providers/registry";

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
  onContextUpdate(contextTokens: number): void;
  /** Response headers received (fires once per API round, carries rate-limit info). */
  onHeaders(headers: Headers): void;
  /** A provider retry was scheduled. Reset any accumulated partial state. */
  onRetry?(attempt: number, maxAttempts: number, errorMessage: string, delaySec: number, metadata?: StreamRetryMetadata): void;
  /** Pause/resume stale-stream watchdogs around intentional long retry waits. */
  onRetryWaitStart?(): void;
  onRetryWaitEnd?(): void;
  /** A tool-use round completed — all tool results received, next API call starting. */
  onRoundComplete?(): void;
  /**
   * Drain "next-turn" queued messages between tool rounds.
   * Called after onRoundComplete — returns user messages to inject
   * into the conversation before the next API call.
   */
  drainNextTurnMessages?(): ApiMessage[];
  /**
   * Called after tool execution. If the context tool modified the conversation,
   * returns a rebuilt base message array (historical messages, trimmed).
   * The agent loop replaces its local messages with: rebuilt + newMessages.
   * Returns null if no rebuild is needed.
   */
  rebuildMessages?(): ApiMessage[] | null;
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
  tokens: number;
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
}

// ── Tool summarizer ─────────────────────────────────────────────────

/** Injected function that produces a display summary for a tool call. */
export type ToolSummarizer = (name: string, input: Record<string, unknown>) => string;

/** Fallback if no summarizer is provided. */
function defaultSummarizer(name: string, _input: Record<string, unknown>): string {
  return name;
}

const CONTEXT_WARNING_FRACTION = 0.8;
const CONTEXT_TARGET_FRACTION = 0.4;

interface ContextPressureWarning {
  usage: string;
  hint: string;
}

function formatTokenCountInThousands(tokens: number): string {
  const thousands = tokens / 1000;
  return Number.isInteger(thousands) ? `${thousands}k` : `${thousands.toFixed(1)}k`;
}

export function buildContextPressureWarning(inputTokens: number, contextLimit: number): ContextPressureWarning | null {
  if (contextLimit <= 0) return null;

  const warningAt = Math.floor(contextLimit * CONTEXT_WARNING_FRACTION);
  if (inputTokens < warningAt) return null;

  const targetTokens = Math.floor(contextLimit * CONTEXT_TARGET_FRACTION);
  const pct = ((inputTokens / contextLimit) * 100).toFixed(0);
  const usage = `${Math.round(inputTokens / 1000)}k/${formatTokenCountInThousands(contextLimit)} tokens (${pct}%)`;
  const freeAtLeast = `${Math.max(0, Math.round((inputTokens - targetTokens) / 1000))}k`;
  const target = formatTokenCountInThousands(targetTokens);
  const hint = `[Context: ${usage} — context is getting full. Free at least ~${freeAtLeast} tokens to get to a stable ${target}. Use the context tool now before you run out, then continue the task you were working on.]`;

  return { usage, hint };
}

export function shouldInjectContextPressureWarning(toolCalls: ApiToolCall[]): boolean {
  return !toolCalls.some((toolCall) => toolCall.name === "context");
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
    /** Mutable state for abort recovery — caller reads on catch. */
    state?: AgentState;
  } = {},
): Promise<AgentResult> {
  const allBlocks: Block[] = [];
  const newMessages: ApiMessage[] = [];
  const messages = [...initialMessages];
  const startTime = Date.now();
  let totalOutputTokens = 0;
  let lastInputTokens = 0;

  // Context pressure warning — injected as a text block in tool result messages.
  // This only appears on tool-use turns because it is appended to the
  // tool_result message seen by the model and rendered inline by the TUI.
  // Re-evaluate it after every qualifying tool round while context remains hot.

  // Expose state for abort recovery
  const state = options.state;
  if (state) {
    state.completedMessages = [];
    state.tokens = 0;
  }

  for (let round = 0; ; round++) {
    log("info", `agent: round ${round}, messages=${messages.length}, provider=${provider}, model=${model}`);

    // ── Stream one API response ───────────────────────────────────
    const result = await streamMessage(provider, messages, model, {
      onText: callbacks.onTextChunk,
      onThinking: callbacks.onThinkingChunk,
      onBlockStart: callbacks.onBlockStart,
      onBlocksUpdate: callbacks.onBlocksUpdate,
      onSignature: callbacks.onSignature,
      onToolCall: callbacks.onToolCall,
      onToolResult: callbacks.onToolResult,
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
      mcpToolExecutor: options.executor
        ? async (call, signal) => {
          const [result] = await options.executor!([call], signal);
          return {
            output: result.output,
            isError: result.isError,
            ...(result.image ? { image: result.image } : {}),
          };
        }
        : undefined,
    });

    if (result.outputTokens) {
      totalOutputTokens += result.outputTokens;
      callbacks.onTokensUpdate(totalOutputTokens);
    }

    if (result.inputTokens) {
      lastInputTokens = result.inputTokens;
      callbacks.onContextUpdate(result.inputTokens);
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

    const shouldWarnForThisRound = shouldInjectContextPressureWarning(result.toolCalls);

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

    const execResults = await options.executor(result.toolCalls, options.signal);

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

    // ── Context pressure warning ──────────────────────────────────
    // Inject a text block into the tool_result message whenever the
    // conversation is at or above 80% of the model's maximum context,
    // except on rounds already using the context tool.
    if (shouldWarnForThisRound && lastInputTokens > 0) {
      const contextLimit = getMaxContext(provider, model);
      if (contextLimit == null || contextLimit <= 0) {
        log("warn", `agent: skipping context pressure warning, unknown max context for ${provider}/${model}`);
      } else {
        const warning = buildContextPressureWarning(lastInputTokens, contextLimit);
        if (warning) {
          toolResultContent.push({ type: "text", text: warning.hint } as ApiContentBlock);
          allBlocks.push({ type: "text", text: warning.hint });
          callbacks.onBlockStart("text");
          callbacks.onTextChunk(warning.hint);
          log("info", `agent: injected context pressure warning (threshold=${Math.round(CONTEXT_WARNING_FRACTION * 100)}%, ${warning.usage})`);
        }
      }
    }

    const toolResultMsg: ApiMessage = { role: "user", content: toolResultContent };
    messages.push(toolResultMsg);
    newMessages.push(toolResultMsg);

    // ── Context tool rebuild ─────────────────────────────────────
    const rebuilt = callbacks.rebuildMessages?.();
    if (rebuilt) {
      // rebuilt = historical messages (trimmed). Append current loop's new messages.
      messages.length = 0;
      messages.push(...rebuilt, ...newMessages);
      log("info", `agent: context rebuilt, messages=${messages.length} (${rebuilt.length} historical + ${newMessages.length} new)`);
    }

    // Update recovery state — this round is fully complete
    if (state) {
      state.completedMessages = [...newMessages];
      state.completedBlocks = [...allBlocks];
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
    // Update recovery state to include injected messages so abort
    // persists them in the right order alongside completed rounds.
    if (state && nextTurn.length > 0) {
      state.completedMessages = [...newMessages];
    }

    // Continue loop → next API call with tool results
  }

  return {
    blocks: allBlocks,
    newMessages,
    tokens: totalOutputTokens,
    durationMs: Date.now() - startTime,
  };
}
