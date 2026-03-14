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
import type { ModelId, Block, ToolCallBlock, ToolResultBlock, ApiMessage, ApiContentBlock } from "./messages";
import { MAX_OUTPUT_CHARS, cap } from "./tools/util";
import { MAX_CONTEXT, CONTEXT_TARGET } from "./constants";

// ── Callbacks ───────────────────────────────────────────────────────

export interface AgentCallbacks {
  /** A new text or thinking block has started streaming. */
  onBlockStart(type: "text" | "thinking"): void;
  /** A text chunk has arrived (append to current text block). */
  onTextChunk(text: string): void;
  /** A thinking chunk has arrived (append to current thinking block). */
  onThinkingChunk(text: string): void;
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
  /** A transient stream error triggered a retry. Reset any accumulated partial state. */
  onRetry?(attempt: number, maxAttempts: number, errorMessage: string, delaySec: number): void;
  /** A tool-use round completed — all tool results received, next API call starting. */
  onRoundComplete?(): void;
  /**
   * Drain "next-turn" queued messages between rounds.
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

// ── Agent loop ──────────────────────────────────────────────────────

export async function runAgentLoop(
  initialMessages: ApiMessage[],
  model: ModelId,
  callbacks: AgentCallbacks,
  options: {
    system?: string;
    signal?: AbortSignal;
    executor?: ToolExecutor;
    summarizer?: ToolSummarizer;
    maxTokens?: number;
    tools?: unknown[];
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

  // Context pressure thresholds — injected as text blocks in tool result messages.
  // Kept deliberately low to combat "context rot": models perform best when
  // their context is not bloated. Every level targets 100K.
  const THRESHOLDS = [
    { at: 200_000, level: "advisory" as const },
    { at: 400_000, level: "warning" as const },
    { at: 600_000, level: "critical" as const },
  ];
  let highestFiredLevel = -1; // index into THRESHOLDS, -1 = none fired

  // Expose state for abort recovery
  const state = options.state;
  if (state) {
    state.completedMessages = [];
    state.tokens = 0;
  }

  for (let round = 0; ; round++) {
    log("info", `agent: round ${round}, messages=${messages.length}, model=${model}`);

    // ── Stream one API response ───────────────────────────────────
    const result = await streamMessage(messages, model, {
      onText: callbacks.onTextChunk,
      onThinking: callbacks.onThinkingChunk,
      onBlockStart: callbacks.onBlockStart,
      onSignature: callbacks.onSignature,
      onHeaders: callbacks.onHeaders,
      onRetry: callbacks.onRetry,
    }, {
      system: options.system,
      signal: options.signal,
      maxTokens: options.maxTokens,
      tools: options.tools,
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
      } else {
        allBlocks.push({ type: "text", text: block.text });
      }
    }

    // ── Build assistant API message for conversation continuity ───
    const assistantContent: ApiMessage["content"] = [];
    for (const block of result.blocks) {
      if (block.type === "thinking") {
        assistantContent.push({ type: "thinking", thinking: block.text, signature: block.signature });
      } else {
        assistantContent.push({ type: "text", text: block.text });
      }
    }
    for (const tc of result.toolCalls) {
      assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    const assistantMsg: ApiMessage = { role: "assistant", content: assistantContent };
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

    // ── Context pressure hints ────────────────────────────────────
    // Inject a text block into the tool result message when context
    // usage crosses hardcoded thresholds. The AI sees this alongside
    // tool results; the TUI renders them inline as dimmed text.
    if (lastInputTokens > 0) {
      const contextLimit = MAX_CONTEXT[model];
      const pct = ((lastInputTokens / contextLimit) * 100).toFixed(0);
      const usage = `${Math.round(lastInputTokens / 1000)}k/${contextLimit / 1000}k tokens (${pct}%)`;
      const freeAtLeast = `${Math.round((lastInputTokens - CONTEXT_TARGET) / 1000)}k`;
      const target = `${CONTEXT_TARGET / 1000}k`;
      let hint: string | null = null;

      // Find the highest threshold that applies (iterate high→low, process first match)
      for (let i = THRESHOLDS.length - 1; i >= 0; i--) {
        if (lastInputTokens < THRESHOLDS[i].at) continue;
        const { level } = THRESHOLDS[i];

        if (level === "critical") {
          // Critical fires every round until the AI frees space
          hint = `[Context: ${usage} — critically low on context! Free at least ~${freeAtLeast} tokens to get to a stable ${target}. Use the context tool immediately.]`;
          highestFiredLevel = Math.max(highestFiredLevel, i);
        } else if (i > highestFiredLevel) {
          // Advisory and warning fire once
          hint = level === "warning"
            ? `[Context: ${usage} — context is getting full. Free at least ~${freeAtLeast} tokens to get to a stable ${target}. Use the context tool now before you run out.]`
            : `[Context: ${usage} — approaching context limit. Free at least ~${freeAtLeast} tokens to get to a stable ${target}. Start with strip_thinking, then strip_results where findings are already captured in your responses, then summarize or delete old turns.]`;
          highestFiredLevel = i;
        }
        break; // Only process the highest matching threshold
      }

      if (hint) {
        toolResultContent.push({ type: "text", text: hint } as ApiContentBlock);
        allBlocks.push({ type: "text", text: hint });
        callbacks.onBlockStart("text");
        callbacks.onTextChunk(hint);
        log("info", `agent: injected context pressure hint (${THRESHOLDS[Math.max(0, highestFiredLevel)].level}, ${usage})`);
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

    // Inject "next-turn" queued messages between rounds.
    // Only completedMessages is updated — user messages don't produce
    // display blocks, so completedBlocks stays unchanged.
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
