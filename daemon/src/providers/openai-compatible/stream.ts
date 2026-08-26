import { log } from "../../log";
import type { ApiToolCall, ContentBlock, StreamCallbacks, StreamResult } from "../types";

interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
}

interface ReadState {
  reasoningParts: string[];
  textParts: string[];
  thinkingStarted: boolean;
  textStarted: boolean;
  toolStates: Map<number, ToolCallState>;
  toolCalls: ApiToolCall[];
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheMissInputTokens?: number;
  outputTokens?: number;
  billingServiceTier?: "standard" | "fast";
  stopReason: string;
}

function createReadState(): ReadState {
  return {
    reasoningParts: [],
    textParts: [],
    thinkingStarted: false,
    textStarted: false,
    toolStates: new Map(),
    toolCalls: [],
    stopReason: "",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function appendReasoning(state: ReadState, delta: string, cb: StreamCallbacks): void {
  if (!delta) return;
  if (!state.thinkingStarted) {
    state.thinkingStarted = true;
    cb.onBlockStart?.("thinking");
  }
  state.reasoningParts.push(delta);
  cb.onThinking(delta);
}

function appendText(state: ReadState, delta: string, cb: StreamCallbacks): void {
  if (!delta) return;
  if (!state.textStarted) {
    state.textStarted = true;
    cb.onBlockStart?.("text");
  }
  state.textParts.push(delta);
  cb.onText(delta);
}

function handleToolCallDelta(state: ReadState, raw: unknown): void {
  const delta = asRecord(raw);
  if (!delta) return;
  const index = typeof delta.index === "number" ? delta.index : 0;
  const fn = asRecord(delta.function);
  const existing = state.toolStates.get(index) ?? { id: "", name: "", arguments: "" };
  if (typeof delta.id === "string") existing.id = delta.id;
  if (fn && typeof fn.name === "string") existing.name = fn.name;
  if (fn && typeof fn.arguments === "string") existing.arguments += fn.arguments;
  state.toolStates.set(index, existing);
}

function finalizeToolCalls(state: ReadState, providerLabel: string): void {
  const ordered = [...state.toolStates.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, tool] of ordered) {
    if (!tool.id && !tool.name) continue;
    if (state.toolCalls.some((call) => call.id === tool.id)) continue;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(tool.arguments || "{}") as Record<string, unknown>;
    } catch {
      log("warn", `${providerLabel.toLowerCase()} api: failed to parse tool input for ${tool.name || "unknown"}`);
    }
    state.toolCalls.push({ id: tool.id, name: tool.name, input });
  }
}

function handleUsage(state: ReadState, usage: unknown): void {
  const record = asRecord(usage);
  if (!record) return;
  if (typeof record.prompt_tokens === "number" && Number.isFinite(record.prompt_tokens)) state.inputTokens = record.prompt_tokens;
  if (typeof record.completion_tokens === "number" && Number.isFinite(record.completion_tokens)) state.outputTokens = record.completion_tokens;

  // DeepSeek reports these two explicit fields and guarantees that they sum to
  // prompt_tokens. OpenAI-compatible providers may instead use the nested
  // cached_tokens/cache_write_tokens shape.
  if (typeof record.prompt_cache_hit_tokens === "number" && Number.isFinite(record.prompt_cache_hit_tokens)) {
    state.cachedInputTokens = record.prompt_cache_hit_tokens;
  }
  if (typeof record.prompt_cache_miss_tokens === "number" && Number.isFinite(record.prompt_cache_miss_tokens)) {
    state.cacheMissInputTokens = record.prompt_cache_miss_tokens;
  }
  const promptDetails = asRecord(record.prompt_tokens_details);
  if (promptDetails && typeof promptDetails.cached_tokens === "number" && Number.isFinite(promptDetails.cached_tokens)) {
    state.cachedInputTokens = promptDetails.cached_tokens;
  }
  if (promptDetails && typeof promptDetails.cache_write_tokens === "number" && Number.isFinite(promptDetails.cache_write_tokens)) {
    state.cacheMissInputTokens = promptDetails.cache_write_tokens;
  }
}

function handleChoice(state: ReadState, choice: Record<string, unknown>, cb: StreamCallbacks, providerLabel: string): void {
  const delta = asRecord(choice.delta);
  if (delta) {
    if (typeof delta.reasoning_content === "string") appendReasoning(state, delta.reasoning_content, cb);
    if (typeof delta.content === "string") appendText(state, delta.content, cb);
    for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) handleToolCallDelta(state, toolCall);
  }

  const message = asRecord(choice.message);
  if (message) {
    if (typeof message.reasoning_content === "string") appendReasoning(state, message.reasoning_content, cb);
    if (typeof message.content === "string") appendText(state, message.content, cb);
    for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) handleToolCallDelta(state, toolCall);
  }

  if (typeof choice.finish_reason === "string" && choice.finish_reason) {
    finalizeToolCalls(state, providerLabel);
    state.stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : choice.finish_reason;
  }
}

function handleStreamEvent(state: ReadState, event: Record<string, unknown>, cb: StreamCallbacks, providerLabel: string): void {
  handleUsage(state, event.usage);
  if (event.service_tier === "priority" || event.service_tier === "fast") {
    state.billingServiceTier = "fast";
  } else if (event.service_tier === "default") {
    state.billingServiceTier = "standard";
  }
  for (const rawChoice of Array.isArray(event.choices) ? event.choices : []) {
    const choice = asRecord(rawChoice);
    if (choice) handleChoice(state, choice, cb, providerLabel);
  }
}

function finalizeReadState(state: ReadState, providerLabel: string): StreamResult {
  finalizeToolCalls(state, providerLabel);
  const reasoning = state.reasoningParts.join("");
  const text = state.textParts.join("");
  const blocks: ContentBlock[] = [];
  if (reasoning) blocks.push({ type: "thinking", text: reasoning, signature: "" });
  if (text) blocks.push({ type: "text", text });
  return {
    text,
    thinking: reasoning,
    stopReason: state.stopReason || (state.toolCalls.length > 0 ? "tool_use" : "stop"),
    blocks,
    toolCalls: state.toolCalls,
    inputTokens: state.inputTokens,
    cachedInputTokens: state.cachedInputTokens,
    cacheMissInputTokens: state.cacheMissInputTokens,
    outputTokens: state.outputTokens,
    billingServiceTier: state.billingServiceTier,
  };
}

export function readOpenAICompatibleEventsForTest(
  events: Record<string, unknown>[],
  callbacks: Partial<StreamCallbacks> = {},
  providerLabel = "OpenAI-compatible",
): StreamResult {
  const cb: StreamCallbacks = {
    onText: callbacks.onText ?? (() => {}),
    onThinking: callbacks.onThinking ?? (() => {}),
    onBlockStart: callbacks.onBlockStart,
    onBlocksUpdate: callbacks.onBlocksUpdate,
    onSignature: callbacks.onSignature,
    onToolCall: callbacks.onToolCall,
    onToolResult: callbacks.onToolResult,
    onHeaders: callbacks.onHeaders,
    onRetry: callbacks.onRetry,
  };
  const state = createReadState();
  for (const event of events) handleStreamEvent(state, event, cb, providerLabel);
  return finalizeReadState(state, providerLabel);
}

function parseEventData(chunk: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const piece of chunk.split("\n\n")) {
    const lines = piece.split("\n").map((line) => line.trim()).filter(Boolean);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) continue;
    const data = dataLines.map((line) => line.replace(/^data:\s?/, "")).join("\n");
    if (data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      // Ignore non-JSON keepalives and provider-specific terminal frames.
    }
  }
  return events;
}

export async function readOpenAICompatibleStream(
  res: Response,
  cb: StreamCallbacks,
  stallTimeoutMs: number,
  providerLabel: string,
): Promise<StreamResult> {
  if (!res.body) throw new Error("No response body");

  const state = createReadState();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    let stallTimer: ReturnType<typeof setTimeout>;
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        stallTimer = setTimeout(() => reject(new Error(`No data for ${stallTimeoutMs / 1000}s`)), stallTimeoutMs);
      }),
    ]).finally(() => clearTimeout(stallTimer!));

    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    const boundary = buffer.lastIndexOf("\n\n");
    if (boundary === -1) continue;
    const ready = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    for (const event of parseEventData(ready)) handleStreamEvent(state, event, cb, providerLabel);
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const event of parseEventData(buffer.replace(/\r\n/g, "\n"))) handleStreamEvent(state, event, cb, providerLabel);
  }

  return finalizeReadState(state, providerLabel);
}
