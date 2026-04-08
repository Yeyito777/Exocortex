/**
 * Tool registry — collects all tools and provides accessors.
 *
 * Adding a new tool: import it, add to TOOLS array. Done.
 */

import type { Tool, ToolResult, ToolSummary, ToolExecutionContext } from "./types";
import type { ToolDisplayInfo } from "@exocortex/shared/messages";
import type { ApiToolCall } from "../api";
import type { ToolExecResult } from "../agent";
import { bash, executeBashBackgroundable } from "./bash";
import { read } from "./read";
import { write } from "./write";
import { glob } from "./glob";
import { grep } from "./grep";
import { edit } from "./edit";
import { browse } from "./browse";
import { context, executeContext, type ContextToolEnv } from "./context";
import { TOOL_BACKGROUND_SECONDS } from "../constants";

export type { ContextToolEnv };

// ── Registry ───────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  bash,
  read,
  write,
  glob,
  grep,
  edit,
  browse,
  context,
];

const toolMap = new Map<string, Tool>(TOOLS.map(t => [t.name, t]));

// ── API tool definitions (sent to Anthropic) ───────────────────────

export function getToolDefs(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

// ── Display info (sent to TUI on connect) ──────────────────────────

export function getToolDisplayInfo(): ToolDisplayInfo[] {
  return TOOLS.map(t => ({
    name: t.name,
    label: t.display.label,
    color: t.display.color,
  }));
}

// ── System prompt hints ────────────────────────────────────────────

export function buildToolSystemHints(): string {
  return TOOLS
    .filter(t => t.systemHint)
    .map(t => t.systemHint!)
    .join("\n");
}

// ── Summarize a tool call ──────────────────────────────────────────

export function summarizeTool(name: string, input: Record<string, unknown>): ToolSummary {
  const tool = toolMap.get(name);
  if (!tool) return { label: name, detail: "" };
  return tool.summarize(input);
}

// ── Abort race helper ─────────────────────────────────────────────

/**
 * Race a promise against an AbortSignal. If the signal fires first,
 * the returned promise rejects immediately — the original promise
 * continues in the background (its result is discarded) while the
 * tool's cooperative cleanup (process kills, etc.) runs as a side effect.
 */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
  ]);
}

// ── Execute + abort-race wrapper ──────────────────────────────────

/**
 * Run a tool promise with abort-race support. Handles:
 * - Racing the promise against the AbortSignal
 * - AbortError → friendly "User interrupted" message
 * - Unexpected errors → "Tool error" message
 * - Building the ToolExecResult envelope
 */
async function execTool(
  call: ApiToolCall,
  promise: Promise<ToolResult>,
  signal?: AbortSignal,
): Promise<ToolExecResult> {
  const startTime = Date.now();
  try {
    const result = await raceAbort(promise, signal);
    return {
      toolCallId: call.id,
      toolName: call.name,
      output: result.output,
      isError: result.isError,
      image: result.image,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const msg = signal?.reason === "watchdog"
        ? `Watchdog timed out after ${elapsed}s (stream was inactive too long).`
        : `User interrupted after ${elapsed}s of execution.`;
      return { toolCallId: call.id, toolName: call.name, output: msg, isError: false };
    }
    return { toolCallId: call.id, toolName: call.name, output: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

// ── Build executor (injected into the agent loop) ──────────────────

export function buildExecutor(
  contextEnv?: ContextToolEnv,
  toolContext?: ToolExecutionContext,
): (calls: ApiToolCall[], signal?: AbortSignal) => Promise<ToolExecResult[]> {
  return (calls, signal?) => Promise.all(calls.map(async (call): Promise<ToolExecResult> => {
    // Context tool — needs conversation access, bypass normal execute()
    if (call.name === "context" && contextEnv) {
      return execTool(call, executeContext(call.input, contextEnv, signal), signal);
    }

    // Bash tool — use backgroundable executor so long-running commands
    // are detached after TOOL_BACKGROUND_SECONDS instead of blocking.
    if (call.name === "bash") {
      return execTool(call, executeBashBackgroundable(call.input, signal, TOOL_BACKGROUND_SECONDS * 1000), signal);
    }

    const tool = toolMap.get(call.name);
    if (!tool) {
      return { toolCallId: call.id, toolName: call.name, output: `Unknown tool: ${call.name}`, isError: true };
    }
    return execTool(call, tool.execute(call.input, toolContext, signal), signal);
  }));
}
