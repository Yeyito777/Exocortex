/**
 * Tool registry — collects all tools and provides accessors.
 *
 * Adding a new tool: import it, add to TOOLS array. Done.
 */

import type { Tool, ToolResult, ToolSummary, ToolExecutionContext, ToolParallelSafety, ToolResourceClass } from "./types";
import type { ToolDisplayInfo } from "@exocortex/shared/messages";
import type { ApiToolCall } from "../api";
import type { ToolExecResult } from "../agent";
import { bash, executeBashBackgroundable } from "./bash";
import { read } from "./read";
import { write } from "./write";
import { glob } from "./glob";
import { grep } from "./grep";
import { edit } from "./edit";
import { patch } from "./patch";
import { browse } from "./browse";
import { goal } from "./goal";
import { exo } from "./exo";
import { chrono } from "./chrono";
import { computerUseTools } from "./computer-use";
import { TOOL_BACKGROUND_SECONDS } from "../constants";
import { formatToolAbortMessage, isToolTimeoutReason, toolTimeoutReason } from "../abort";
import { evaluateToolCallSafety, formatSafetyBlock } from "../safety";
import { AbortableSemaphore } from "./semaphore";
import { log } from "../log";

// ── Registry ───────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  bash,
  read,
  write,
  glob,
  grep,
  edit,
  patch,
  browse,
  goal,
  exo,
  chrono,
  ...computerUseTools,
];

const toolMap = new Map<string, Tool>(TOOLS.map(t => [t.name, t]));

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const configuredFilesystemScanConcurrency = Number(process.env.TOOL_FILESYSTEM_SCAN_CONCURRENCY);
const filesystemScanConcurrency = Number.isFinite(configuredFilesystemScanConcurrency)
  ? Math.max(1, Math.floor(configuredFilesystemScanConcurrency))
  : 3;
const resourceSemaphores = new Map<ToolResourceClass, AbortableSemaphore>([
  ["filesystem_scan", new AbortableSemaphore(filesystemScanConcurrency)],
]);

function isToolAvailable(tool: Tool): boolean {
  return tool.isAvailable?.() ?? true;
}

function getAvailableTools(): Tool[] {
  return TOOLS.filter(isToolAvailable);
}

function getSelectedAvailableTools(allowedNames?: readonly string[]): Tool[] {
  const available = getAvailableTools();
  if (!allowedNames) return available;
  const allowed = new Set(allowedNames);
  return available.filter(tool => allowed.has(tool.name));
}

export function getRegisteredTools(): Tool[] {
  return [...getAvailableTools()];
}

// ── API tool definitions (sent to model providers) ─────────────────

export function getToolDefs(allowedNames?: readonly string[]): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return getSelectedAvailableTools(allowedNames).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

// ── Display info (sent to TUI on connect) ──────────────────────────

export function getToolDisplayInfo(): ToolDisplayInfo[] {
  return getAvailableTools().map(t => ({
    name: t.name,
    label: t.display.label,
    color: t.display.color,
  }));
}

// ── System prompt hints ────────────────────────────────────────────

export function buildToolSystemHints(allowedNames?: readonly string[]): string {
  return getSelectedAvailableTools(allowedNames)
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
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      err => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

// ── Execute + abort-race wrapper ──────────────────────────────────

/**
 * Run a tool promise with abort-race support. Handles:
 * - Racing the promise against the AbortSignal
 * - AbortError → friendly interrupt/restart/timeout message
 * - Unexpected errors → "Tool error" message
 * - Building the ToolExecResult envelope
 */
async function execTool(
  call: ApiToolCall,
  promise: Promise<ToolResult>,
  signal?: AbortSignal,
  settleOnAbort = false,
): Promise<ToolExecResult> {
  const startTime = Date.now();
  try {
    const result = settleOnAbort ? await promise : await raceAbort(promise, signal);
    if (settleOnAbort && signal?.aborted) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const abortMessage = formatToolAbortMessage(signal, elapsed);
      const details = result.output.trim();
      return {
        toolCallId: call.id,
        toolName: call.name,
        output: details ? `${abortMessage}\n\n${details}` : abortMessage,
        isError: isToolTimeoutReason(signal.reason),
        image: result.image,
      };
    }
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
      const msg = formatToolAbortMessage(signal, elapsed);
      return {
        toolCallId: call.id,
        toolName: call.name,
        output: msg,
        isError: isToolTimeoutReason(signal?.reason),
      };
    }
    return { toolCallId: call.id, toolName: call.name, output: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

// ── Ordered parallel scheduling ────────────────────────────────────

export interface ToolExecutionBatch {
  mode: "parallel" | "exclusive";
  calls: ApiToolCall[];
}

export function getToolParallelSafety(toolName: string): ToolParallelSafety {
  return toolMap.get(toolName)?.parallelSafety ?? "exclusive";
}

export function getToolDefaultTimeoutMs(toolName: string): number | null {
  const configured = toolMap.get(toolName)?.defaultTimeoutMs;
  if (configured === null) return null;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_TOOL_TIMEOUT_MS;
}

export function getToolResourceClass(toolName: string): ToolResourceClass | undefined {
  return toolMap.get(toolName)?.resourceClass;
}

export function toolCallsRequireWatchdogPause(calls: ApiToolCall[]): boolean {
  return calls.some(call => toolMap.get(call.name)?.watchdogExempt === true);
}

function callSupportsParallel(call: ApiToolCall): boolean {
  return getToolParallelSafety(call.name) === "safe";
}

export function planToolExecutionBatches(calls: ApiToolCall[]): ToolExecutionBatch[] {
  const batches: ToolExecutionBatch[] = [];
  let i = 0;

  while (i < calls.length) {
    const call = calls[i];
    if (!callSupportsParallel(call)) {
      batches.push({ mode: "exclusive", calls: [call] });
      i++;
      continue;
    }

    const start = i;
    while (i < calls.length && callSupportsParallel(calls[i])) i++;
    batches.push({ mode: "parallel", calls: calls.slice(start, i) });
  }

  return batches;
}

async function executeSingleTool(
  call: ApiToolCall,
  toolContext?: ToolExecutionContext,
  signal?: AbortSignal,
  allowedTools?: ReadonlySet<string>,
): Promise<ToolExecResult> {
  const callToolContext: ToolExecutionContext = toolContext
    ? { ...toolContext, toolCallId: call.id }
    : { toolCallId: call.id };

  if (allowedTools && !allowedTools.has(call.name)) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      output: `Tool unavailable in this session: ${call.name}`,
      isError: true,
    };
  }

  const safety = evaluateToolCallSafety(call.name, call.input);
  if (!safety.allowed) {
    return {
      toolCallId: call.id,
      toolName: call.name,
      output: formatSafetyBlock(safety),
      isError: true,
    };
  }

  const tool = toolMap.get(call.name);
  if (!tool) {
    return { toolCallId: call.id, toolName: call.name, output: `Unknown tool: ${call.name}`, isError: true };
  }
  if (!isToolAvailable(tool)) {
    return { toolCallId: call.id, toolName: call.name, output: `Tool unavailable: ${call.name}`, isError: true };
  }

  const timeoutMs = getToolDefaultTimeoutMs(call.name);
  const deadline = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onParentAbort: (() => void) | undefined;

  if (signal) {
    onParentAbort = () => deadline.abort(signal.reason);
    if (signal.aborted) onParentAbort();
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }
  if (!deadline.signal.aborted && timeoutMs !== null) {
    timeout = setTimeout(() => {
      log("warn", `agent: tool '${call.name}' timed out after ${timeoutMs}ms (call ${call.id})`);
      deadline.abort(toolTimeoutReason(call.name, timeoutMs));
    }, timeoutMs);
  }

  const run = async (): Promise<ToolResult> => {
    const resourceClass = tool.resourceClass;
    const semaphore = resourceClass ? resourceSemaphores.get(resourceClass) : undefined;
    const release = semaphore ? await semaphore.acquire(deadline.signal) : undefined;
    try {
      // Bash tool — use backgroundable executor so long-running commands are
      // detached after TOOL_BACKGROUND_SECONDS instead of blocking.
      if (call.name === "bash") {
        return await executeBashBackgroundable(call.input, deadline.signal, TOOL_BACKGROUND_SECONDS * 1000, callToolContext);
      }

      return await tool.execute(call.input, callToolContext, deadline.signal);
    } finally {
      release?.();
    }
  };

  try {
    return await execTool(call, run(), deadline.signal, tool.settleOnAbort === true);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && onParentAbort) signal.removeEventListener("abort", onParentAbort);
  }
}

async function executeScheduledTools(
  calls: ApiToolCall[],
  toolContext?: ToolExecutionContext,
  signal?: AbortSignal,
  allowedTools?: ReadonlySet<string>,
): Promise<ToolExecResult[]> {
  const results: ToolExecResult[] = [];

  for (const batch of planToolExecutionBatches(calls)) {
    const batchResults = batch.mode === "parallel"
      ? await Promise.all(batch.calls.map(call => executeSingleTool(call, toolContext, signal, allowedTools)))
      : [await executeSingleTool(batch.calls[0], toolContext, signal, allowedTools)];
    results.push(...batchResults);
  }

  return results;
}

// ── Build executor (injected into the agent loop) ──────────────────

export function buildExecutor(
  toolContext?: ToolExecutionContext,
  allowedToolNames?: readonly string[],
): (calls: ApiToolCall[], signal?: AbortSignal) => Promise<ToolExecResult[]> {
  const allowedTools = allowedToolNames ? new Set(allowedToolNames) : undefined;
  return (calls, signal?) => executeScheduledTools(calls, toolContext, signal, allowedTools);
}

export const registryInternalsForTest = {
  execTool,
};
