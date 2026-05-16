import { appendFileSync, mkdirSync, rmSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { diagnosticsDir, worktreeName } from "@exocortex/shared/paths";
import type { ApiContentBlock, ApiMessage, ModelId, ProviderId, TokenTrackingContext } from "./messages";
import type { ApiToolCall, ModelRequestDiagnostics, StreamResult } from "./providers/types";
import { log } from "./log";

const DIAGNOSTICS_VERSION = 1;
const INSTANCE_ID = worktreeName() ?? "main";
const ERROR_REASON_MAX_CHARS = 2_000;

export interface ToolCallDiagnosticsInput {
  conversationId?: string;
  round: number;
  calls: ApiToolCall[];
  results: Array<{ toolCallId: string; toolName: string; output: string; isError: boolean }>;
  batchDurationMs: number;
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function diagnosticsFile(kind: "model-requests" | "tool-calls", timestamp: number): string {
  return join(diagnosticsDir(), kind, `${INSTANCE_ID}-${localDay(timestamp)}.jsonl`);
}

function appendDiagnostic(kind: "model-requests" | "tool-calls", timestamp: number, record: Record<string, unknown>): void {
  try {
    const file = diagnosticsFile(kind, timestamp);
    mkdirSync(join(diagnosticsDir(), kind), { recursive: true });
    appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch (err) {
    log("warn", `diagnostics: failed to append ${kind}: ${err instanceof Error ? err.message : err}`);
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
}

function hashValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function extractToolResultText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .filter((part): part is { type?: string; text?: string } => !!part && typeof part === "object")
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function buildErrorReason(output: string, isError: boolean): { errorReason?: string; errorReasonTruncated?: boolean } {
  if (!isError) return {};
  return {
    errorReason: output.slice(0, ERROR_REASON_MAX_CHARS),
    errorReasonTruncated: output.length > ERROR_REASON_MAX_CHARS,
  };
}

function summarizeToolResults(messages: ApiMessage[]): Array<{ callId: string; name?: string; outputChars: number; outputBytes: number; isError: boolean; errorReason?: string; errorReasonTruncated?: boolean }> {
  const callNames = new Map<string, string>();
  const results: Array<{ callId: string; name?: string; outputChars: number; outputBytes: number; isError: boolean; errorReason?: string; errorReasonTruncated?: boolean }> = [];

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") {
        callNames.set(block.id, block.name);
      } else if (block.type === "tool_result") {
        const output = extractToolResultText(block.content);
        const isError = block.is_error === true;
        results.push({
          callId: block.tool_use_id,
          ...(callNames.has(block.tool_use_id) ? { name: callNames.get(block.tool_use_id) } : {}),
          outputChars: output.length,
          outputBytes: byteLength(output),
          isError,
          ...buildErrorReason(output, isError),
        });
      }
    }
  }

  return results;
}

function contentBlocksForSize(message: ApiMessage): ApiContentBlock[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

function inputCharCount(messages: ApiMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      chars += message.content.length;
      continue;
    }
    for (const block of contentBlocksForSize(message)) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "thinking") chars += block.thinking.length;
      else if (block.type === "tool_result") chars += extractToolResultText(block.content).length;
      else if (block.type === "tool_use") chars += stableJson(block.input).length;
      else if (block.type === "image") chars += block.source.data.length;
    }
  }
  return chars;
}

export function recordModelRequestDiagnostics(
  provider: ProviderId,
  model: ModelId,
  messages: ApiMessage[],
  result: StreamResult,
  tracking?: TokenTrackingContext,
): void {
  const timestamp = Date.now();
  const inputTokens = result.inputTokens ?? 0;
  const cachedInputTokens = result.cachedInputTokens ?? 0;
  const uncachedInputTokens = result.cachedInputTokens == null ? 0 : Math.max(0, inputTokens - cachedInputTokens);
  const providerDiagnostics: ModelRequestDiagnostics | undefined = result.requestDiagnostics;

  appendDiagnostic("model-requests", timestamp, {
    version: DIAGNOSTICS_VERSION,
    type: "model_request",
    timestamp,
    instance: INSTANCE_ID,
    provider,
    model,
    source: tracking?.source,
    conversationId: tracking?.conversationId,
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens: result.outputTokens ?? 0,
    cacheHitRatio: inputTokens > 0 && result.cachedInputTokens != null ? cachedInputTokens / inputTokens : null,
    inputChars: inputCharCount(messages),
    inputMessages: messages.length,
    toolCallsRequested: result.toolCalls.map((call) => call.name),
    toolResultsIncluded: summarizeToolResults(messages),
    ...(providerDiagnostics ?? {}),
  });
}

export function recordToolCallDiagnostics(input: ToolCallDiagnosticsInput): void {
  const timestamp = Date.now();
  const callsById = new Map(input.calls.map((call) => [call.id, call]));
  for (const result of input.results) {
    const call = callsById.get(result.toolCallId);
    appendDiagnostic("tool-calls", timestamp, {
      version: DIAGNOSTICS_VERSION,
      type: "tool_call",
      timestamp,
      instance: INSTANCE_ID,
      conversationId: input.conversationId,
      round: input.round,
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      inputBytes: call ? byteLength(stableJson(call.input)) : 0,
      inputHash: call ? hashValue(call.input) : null,
      outputChars: result.output.length,
      outputBytes: byteLength(result.output),
      outputHash: hashValue(result.output),
      isError: result.isError,
      ...buildErrorReason(result.output, result.isError),
      batchDurationMs: input.batchDurationMs,
    });
  }
}

export function resetDiagnosticsForTest(): void {
  rmSync(diagnosticsDir(), { recursive: true, force: true });
}
