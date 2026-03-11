/**
 * Tool registry — collects all tools and provides accessors.
 *
 * Adding a new tool: import it, add to TOOLS array. Done.
 */

import type { Tool, ToolResult, ToolSummary } from "./types";
import type { ToolDisplayInfo } from "@exocortex/shared/messages";
import type { ApiToolCall } from "../api";
import type { ToolExecResult } from "../agent";
import { bash } from "./bash";
import { read } from "./read";
import { write } from "./write";
import { glob } from "./glob";
import { grep } from "./grep";
import { edit } from "./edit";
import { browse } from "./browse";

// ── Registry ───────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  bash,
  read,
  write,
  glob,
  grep,
  edit,
  browse,
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

// ── Build executor (injected into the agent loop) ──────────────────

export function buildExecutor(): (calls: ApiToolCall[], signal?: AbortSignal) => Promise<ToolExecResult[]> {
  return (calls, signal?) => Promise.all(calls.map(async (call): Promise<ToolExecResult> => {
    const tool = toolMap.get(call.name);
    let result: ToolResult;
    if (!tool) {
      result = { output: `Unknown tool: ${call.name}`, isError: true };
    } else {
      const startTime = Date.now();
      try {
        result = await raceAbort(tool.execute(call.input, signal), signal);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // Fallback for tools that don't handle the signal cooperatively.
          // Tools like bash resolve before the race fires, so this only
          // triggers for tools that didn't settle on their own.
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          result = { output: `User interrupted after ${elapsed}s of execution.`, isError: false };
        } else {
          result = { output: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }
    }
    return {
      toolCallId: call.id,
      toolName: call.name,
      output: result.output,
      isError: result.isError,
      image: result.image,
    };
  }));
}
