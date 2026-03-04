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

import { streamMessage, type ApiToolCall, type ContentBlock } from "./api";
import { log } from "./log";
import type { ModelId, Block, ToolCallBlock, ToolResultBlock, ApiMessage, ApiContentBlock } from "./messages";

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
}

// ── Tool execution ──────────────────────────────────────────────────

export interface ToolExecResult {
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
}

/**
 * A function that executes tool calls and returns results.
 * Injected by the caller — the agent loop doesn't know what tools exist.
 */
export type ToolExecutor = (calls: ApiToolCall[]) => Promise<ToolExecResult[]>;

// ── Result ──────────────────────────────────────────────────────────

export interface AgentResult {
  /** All blocks produced during this AI message, in order. */
  blocks: Block[];
  /** Full API content blocks with signatures — for persisting and replaying. */
  apiContent: ApiContentBlock[];
  model: ModelId;
  tokens: number;
  durationMs: number;
}

// ── Tool summary ────────────────────────────────────────────────────

/** Human-readable one-liner for a tool call. Expand as tools are added. */
export function toolSummary(tc: ApiToolCall): string {
  switch (tc.name) {
    case "bash":      return (tc.input.command as string)?.slice(0, 120) ?? "";
    case "read":
    case "edit":
    case "write":     return (tc.input.file_path as string) ?? "";
    case "glob":      return (tc.input.pattern as string) ?? "";
    case "grep":      return `/${tc.input.pattern as string}/`;
    case "browse":    return (tc.input.url as string) ?? "";
    case "websearch": return (tc.input.query as string) ?? "";
    default:          return tc.name;
  }
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
    maxTokens?: number;
    tools?: unknown[];
  } = {},
): Promise<AgentResult> {
  const allBlocks: Block[] = [];
  const allApiContent: ApiContentBlock[] = [];
  const messages = [...initialMessages];
  const startTime = Date.now();
  let totalOutputTokens = 0;

  for (let round = 0; ; round++) {
    log("info", `agent: round ${round}, messages=${messages.length}, model=${model}`);

    // ── Stream one API response ───────────────────────────────────
    const result = await streamMessage(messages, model, {
      onText: callbacks.onTextChunk,
      onThinking: callbacks.onThinkingChunk,
      onBlockStart: callbacks.onBlockStart,
      onHeaders: callbacks.onHeaders,
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
    // Accumulate for the final result (thinking + text, with signatures)
    for (const block of result.blocks) {
      if (block.type === "thinking") {
        allApiContent.push({ type: "thinking", thinking: block.text, signature: block.signature });
      } else {
        allApiContent.push({ type: "text", text: block.text });
      }
    }
    messages.push({ role: "assistant", content: assistantContent });

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
        summary: toolSummary(tc),
      };
      allBlocks.push(block);
      callbacks.onToolCall(block);
    }

    // ── Execute tools ─────────────────────────────────────────────
    if (!options.executor) {
      log("info", "agent: no executor provided, stopping after tool calls");
      break;
    }

    const execResults = await options.executor(result.toolCalls);

    // ── Emit tool result blocks + build API tool_result message ───
    const toolResultContent: ApiMessage["content"] = [];
    for (const r of execResults) {
      const block: ToolResultBlock = {
        type: "tool_result",
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        output: r.output,
        isError: r.isError,
      };
      allBlocks.push(block);
      callbacks.onToolResult(block);

      toolResultContent.push({
        type: "tool_result",
        tool_use_id: r.toolCallId,
        content: r.output,
        is_error: r.isError,
      });
    }

    messages.push({ role: "user", content: toolResultContent });
    // Continue loop → next API call with tool results
  }

  return {
    blocks: allBlocks,
    apiContent: allApiContent,
    model,
    tokens: totalOutputTokens,
    durationMs: Date.now() - startTime,
  };
}
