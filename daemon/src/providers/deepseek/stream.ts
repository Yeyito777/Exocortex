import { log } from "../../log";
import type { ApiToolCall, ContentBlock, StreamCallbacks, StreamResult } from "../types";

interface DeepSeekToolCallState {
  id: string;
  name: string;
  arguments: string;
}

interface DeepSeekReadState {
  reasoningParts: string[];
  textParts: string[];
  thinkingStarted: boolean;
  textStarted: boolean;
  toolStates: Map<number, DeepSeekToolCallState>;
  toolCalls: ApiToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  stopReason: string;
}

function createReadState(): DeepSeekReadState {
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

function appendReasoning(state: DeepSeekReadState, delta: string, cb: StreamCallbacks): void {
  if (!delta) return;
  if (!state.thinkingStarted) {
    state.thinkingStarted = true;
    cb.onBlockStart?.("thinking");
  }
  state.reasoningParts.push(delta);
  cb.onThinking(delta);
}

function appendText(state: DeepSeekReadState, delta: string, cb: StreamCallbacks): void {
  if (!delta) return;
  if (!state.textStarted) {
    state.textStarted = true;
    cb.onBlockStart?.("text");
  }
  state.textParts.push(delta);
  cb.onText(delta);
}

function handleToolCallDelta(state: DeepSeekReadState, raw: unknown): void {
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

function finalizeToolCalls(state: DeepSeekReadState): void {
  const ordered = [...state.toolStates.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, tool] of ordered) {
    if (!tool.id && !tool.name) continue;
    if (state.toolCalls.some((call) => call.id === tool.id)) continue;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(tool.arguments || "{}") as Record<string, unknown>;
    } catch {
      log("warn", `deepseek api: failed to parse tool input for ${tool.name || "unknown"}`);
    }
    state.toolCalls.push({
      id: tool.id,
      name: tool.name,
      input,
    });
  }
}

function handleUsage(state: DeepSeekReadState, usage: unknown): void {
  const record = asRecord(usage);
  if (!record) return;
  const input = record.prompt_tokens;
  const output = record.completion_tokens;
  if (typeof input === "number" && Number.isFinite(input)) state.inputTokens = input;
  if (typeof output === "number" && Number.isFinite(output)) state.outputTokens = output;
}

function handleChoice(state: DeepSeekReadState, choice: Record<string, unknown>, cb: StreamCallbacks): void {
  const delta = asRecord(choice.delta);
  if (delta) {
    if (typeof delta.reasoning_content === "string") appendReasoning(state, delta.reasoning_content, cb);
    if (typeof delta.content === "string") appendText(state, delta.content, cb);
    const toolCallDeltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const toolCall of toolCallDeltas) handleToolCallDelta(state, toolCall);
  }

  const message = asRecord(choice.message);
  if (message) {
    if (typeof message.reasoning_content === "string") appendReasoning(state, message.reasoning_content, cb);
    if (typeof message.content === "string") appendText(state, message.content, cb);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const toolCall of toolCalls) handleToolCallDelta(state, toolCall);
  }

  const finishReason = choice.finish_reason;
  if (typeof finishReason === "string" && finishReason) {
    finalizeToolCalls(state);
    state.stopReason = finishReason === "tool_calls" ? "tool_use" : finishReason;
  }
}

function handleStreamEvent(state: DeepSeekReadState, event: Record<string, unknown>, cb: StreamCallbacks): void {
  handleUsage(state, event.usage);
  const choices = Array.isArray(event.choices) ? event.choices : [];
  for (const rawChoice of choices) {
    const choice = asRecord(rawChoice);
    if (!choice) continue;
    handleChoice(state, choice, cb);
  }
}

function finalizeReadState(state: DeepSeekReadState): StreamResult {
  finalizeToolCalls(state);
  const reasoning = state.reasoningParts.join("");
  const text = state.textParts.join("");
  const blocks: ContentBlock[] = [];
  if (reasoning) blocks.push({ type: "thinking", text: reasoning, signature: "" });
  if (text) blocks.push({ type: "text", text });
  const stopReason = state.stopReason || (state.toolCalls.length > 0 ? "tool_use" : "stop");
  return {
    text,
    thinking: reasoning,
    stopReason,
    blocks,
    toolCalls: state.toolCalls,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
  };
}

export function readDeepSeekEventsForTest(events: Record<string, unknown>[], callbacks: Partial<StreamCallbacks> = {}): StreamResult {
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
  for (const event of events) handleStreamEvent(state, event, cb);
  return finalizeReadState(state);
}

function parseEventData(chunk: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const pieces = chunk.split("\n\n");
  for (const piece of pieces) {
    const lines = piece.split("\n").map((line) => line.trim()).filter(Boolean);
    const dataLines = lines.filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) continue;
    const data = dataLines.map((line) => line.replace(/^data:\s?/, "")).join("\n");
    if (data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return events;
}

export async function readDeepSeekStream(res: Response, cb: StreamCallbacks, stallTimeoutMs: number): Promise<StreamResult> {
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
        stallTimer = setTimeout(
          () => reject(new Error(`No data for ${stallTimeoutMs / 1000}s`)),
          stallTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(stallTimer!));

    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const boundary = buffer.lastIndexOf("\n\n");
    if (boundary === -1) continue;
    const ready = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    for (const event of parseEventData(ready)) handleStreamEvent(state, event, cb);
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const event of parseEventData(buffer)) handleStreamEvent(state, event, cb);
  }

  return finalizeReadState(state);
}
