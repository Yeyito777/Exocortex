import { AuthError } from "../errors";
import type { ContentBlock, StreamCallbacks, StreamResult } from "../types";

interface TextBlockState {
  type: "text" | "thinking";
  text: string;
  signature: string;
}

interface ToolCallState {
  type: "tool_call";
  id: string;
  name: string;
  inputJson: string;
  input: Record<string, unknown>;
}

type BlockState = TextBlockState | ToolCallState;

interface ClaudeResultEnvelope {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  stop_reason?: string;
  session_id?: string;
  usage?: Record<string, unknown>;
}

interface ClaudeReadState {
  fullText: string;
  fullThinking: string;
  stopReason: string;
  inputTokens?: number;
  outputTokens?: number;
  blocks: Map<number, BlockState>;
  orderedBlocks: ContentBlock[];
  sessionId: string | null;
  sawRenderableContent: boolean;
  emittedToolCalls: Set<string>;
  emittedToolResults: Set<string>;
  toolNamesById: Map<string, string>;
}

function createState(): ClaudeReadState {
  return {
    fullText: "",
    fullThinking: "",
    stopReason: "",
    inputTokens: undefined,
    outputTokens: undefined,
    blocks: new Map(),
    orderedBlocks: [],
    sessionId: null,
    sawRenderableContent: false,
    emittedToolCalls: new Set(),
    emittedToolResults: new Set(),
    toolNamesById: new Map(),
  };
}

function parseUsage(usage: Record<string, unknown> | undefined): { inputTokens?: number; outputTokens?: number } {
  if (!usage) return {};
  const inputTokens =
    (typeof usage.input_tokens === "number" ? usage.input_tokens : 0)
    + (typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0)
    + (typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0);
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  return {
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
  };
}

function summarizeToolCall(name: string, input: Record<string, unknown>): string {
  const trimmedName = name.trim() || "tool";
  let rendered = "";
  try {
    rendered = JSON.stringify(input);
  } catch {
    rendered = "";
  }
  if (!rendered || rendered === "{}") return trimmedName;
  const compact = rendered.length > 160 ? `${rendered.slice(0, 157)}...` : rendered;
  return `${trimmedName} ${compact}`;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (!entry || typeof entry !== "object") return "";
      const record = entry as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return record.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function emitToolCall(
  state: ClaudeReadState,
  id: string,
  name: string,
  input: Record<string, unknown>,
  cb: StreamCallbacks,
): void {
  if (state.emittedToolCalls.has(id)) return;
  state.emittedToolCalls.add(id);
  state.toolNamesById.set(id, name);
  const block = {
    type: "tool_call" as const,
    id,
    name,
    input,
    summary: summarizeToolCall(name, input),
  };
  state.orderedBlocks.push(block);
  cb.onToolCall?.({
    type: "tool_call",
    toolCallId: id,
    toolName: name,
    input,
    summary: block.summary,
  });
}

function emitToolResult(
  state: ClaudeReadState,
  toolUseId: string,
  toolName: string,
  output: string,
  isError: boolean,
  cb: StreamCallbacks,
): void {
  const dedupeKey = `${toolUseId}:${output}:${isError ? "1" : "0"}`;
  if (state.emittedToolResults.has(dedupeKey)) return;
  state.emittedToolResults.add(dedupeKey);
  state.orderedBlocks.push({
    type: "tool_result",
    toolUseId,
    toolName,
    output,
    isError,
  });
  cb.onToolResult?.({
    type: "tool_result",
    toolCallId: toolUseId,
    toolName,
    output,
    isError,
  });
}

function finalizeBlock(state: ClaudeReadState, block: BlockState, cb: StreamCallbacks): void {
  if (block.type === "thinking") {
    if (!block.text) return;
    state.orderedBlocks.push({ type: "thinking", text: block.text, signature: block.signature });
    return;
  }
  if (block.type === "text") {
    if (!block.text) return;
    state.orderedBlocks.push({ type: "text", text: block.text });
    return;
  }
  if (block.type === "tool_call") {
    emitToolCall(state, block.id, block.name, block.input, cb);
  }
}

function isAssistantErrorMessage(message: Record<string, unknown>): boolean {
  return message.isApiErrorMessage === true || typeof message.error === "string";
}

function applyAssistantSnapshot(
  state: ClaudeReadState,
  message: Record<string, unknown>,
  cb: StreamCallbacks,
): void {
  const payload = message.message as Record<string, unknown> | undefined;
  const content = payload?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typedBlock = block as Record<string, unknown>;

    if (
      typedBlock.type === "text"
      && typeof typedBlock.text === "string"
      && typedBlock.text.length > 0
      && !isAssistantErrorMessage(message)
      && !state.sawRenderableContent
      && state.fullText.length === 0
    ) {
      state.orderedBlocks.push({ type: "text", text: typedBlock.text });
      state.fullText += typedBlock.text;
      cb.onBlockStart?.("text");
      cb.onText(typedBlock.text);
      continue;
    }

    if (
      typedBlock.type === "thinking"
      && typeof typedBlock.thinking === "string"
      && typedBlock.thinking.length > 0
      && !state.sawRenderableContent
      && state.fullThinking.length === 0
    ) {
      state.orderedBlocks.push({ type: "thinking", text: typedBlock.thinking, signature: "" });
      state.fullThinking += typedBlock.thinking;
      cb.onBlockStart?.("thinking");
      cb.onThinking(typedBlock.thinking);
      continue;
    }

    if (
      (typedBlock.type === "tool_use" || typedBlock.type === "server_tool_use" || typedBlock.type === "mcp_tool_use")
      && typeof typedBlock.id === "string"
      && typeof typedBlock.name === "string"
    ) {
      emitToolCall(
        state,
        typedBlock.id,
        typedBlock.name,
        typedBlock.input && typeof typedBlock.input === "object" && !Array.isArray(typedBlock.input)
          ? typedBlock.input as Record<string, unknown>
          : {},
        cb,
      );
    }
  }

  if (typeof payload?.stop_reason === "string" && !state.stopReason) {
    state.stopReason = payload.stop_reason;
  }

  const usage = parseUsage(payload?.usage as Record<string, unknown> | undefined);
  if (usage.inputTokens != null) state.inputTokens = usage.inputTokens;
  if (usage.outputTokens != null) state.outputTokens = usage.outputTokens;
}

function processUserMessage(state: ClaudeReadState, raw: Record<string, unknown>, cb: StreamCallbacks): void {
  const payload = raw.message as Record<string, unknown> | undefined;
  const content = payload?.content;
  if (!Array.isArray(content)) return;

  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") continue;
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
    if (!toolUseId) continue;
    const output = toolResultText(block.content);
    emitToolResult(
      state,
      toolUseId,
      state.toolNamesById.get(toolUseId) ?? "Claude Code tool",
      output,
      block.is_error === true,
      cb,
    );
  }
}

function processStreamEvent(state: ClaudeReadState, raw: Record<string, unknown>, cb: StreamCallbacks): void {
  const event = raw.event as Record<string, unknown> | undefined;
  if (!event || typeof event.type !== "string") return;

  if (event.type === "content_block_start") {
    const idx = typeof event.index === "number" ? event.index : -1;
    const block = event.content_block as Record<string, unknown> | undefined;
    if (idx < 0 || !block || typeof block.type !== "string") return;
    if (block.type === "text") {
      state.blocks.set(idx, { type: "text", text: "", signature: "" });
      cb.onBlockStart?.("text");
      return;
    }
    if (block.type === "thinking") {
      state.blocks.set(idx, { type: "thinking", text: "", signature: "" });
      cb.onBlockStart?.("thinking");
      return;
    }
    if (
      (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use")
      && typeof block.id === "string"
      && typeof block.name === "string"
    ) {
      state.blocks.set(idx, {
        type: "tool_call",
        id: block.id,
        name: block.name,
        inputJson: "",
        input: block.input && typeof block.input === "object" && !Array.isArray(block.input)
          ? block.input as Record<string, unknown>
          : {},
      });
    }
    return;
  }

  if (event.type === "content_block_delta") {
    const idx = typeof event.index === "number" ? event.index : -1;
    const block = state.blocks.get(idx);
    const delta = event.delta as Record<string, unknown> | undefined;
    if (!block || !delta || typeof delta.type !== "string") return;

    if (block.type === "tool_call") {
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        block.inputJson += delta.partial_json;
        const parsed = tryParseJsonRecord(block.inputJson);
        if (parsed) {
          block.input = parsed;
        }
      }
      return;
    }

    state.sawRenderableContent = true;
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      block.text += delta.text;
      state.fullText += delta.text;
      cb.onText(delta.text);
      return;
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      block.text += delta.thinking;
      state.fullThinking += delta.thinking;
      cb.onThinking(delta.thinking);
      return;
    }
    if (delta.type === "signature_delta" && typeof delta.signature === "string" && block.type === "thinking") {
      block.signature = delta.signature;
      cb.onSignature?.(delta.signature);
    }
    return;
  }

  if (event.type === "content_block_stop") {
    const idx = typeof event.index === "number" ? event.index : -1;
    const block = state.blocks.get(idx);
    if (!block) return;
    finalizeBlock(state, block, cb);
    state.blocks.delete(idx);
    return;
  }

  if (event.type === "message_start") {
    const message = event.message as Record<string, unknown> | undefined;
    const usage = parseUsage(message?.usage as Record<string, unknown> | undefined);
    if (usage.inputTokens != null) state.inputTokens = usage.inputTokens;
    if (typeof message?.session_id === "string") state.sessionId = message.session_id;
    return;
  }

  if (event.type === "message_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    const usage = parseUsage(event.usage as Record<string, unknown> | undefined);
    if (typeof delta?.stop_reason === "string") state.stopReason = delta.stop_reason;
    if (usage.outputTokens != null) state.outputTokens = usage.outputTokens;
  }
}

function errorFromResult(result: ClaudeResultEnvelope): Error | null {
  if (!result.is_error) return null;
  const message = [result.result, ...(result.errors ?? [])]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .trim() || "Claude Code request failed.";
  const lower = message.toLowerCase();
  if (lower.includes("authenticate") || lower.includes("authentication") || lower.includes("not logged in")) {
    return new AuthError(message);
  }
  return new Error(message);
}

function normalizeCallbacks(callbacks: Partial<StreamCallbacks> = {}): StreamCallbacks {
  return {
    onText: callbacks.onText ?? (() => {}),
    onThinking: callbacks.onThinking ?? (() => {}),
    onBlockStart: callbacks.onBlockStart,
    onSignature: callbacks.onSignature,
    onToolCall: callbacks.onToolCall,
    onToolResult: callbacks.onToolResult,
    onHeaders: callbacks.onHeaders,
    onRetry: callbacks.onRetry,
  };
}

export interface ClaudeStreamProcessor {
  state: ClaudeReadState;
  callbacks: StreamCallbacks;
  finalResult: ClaudeResultEnvelope | null;
}

export function createClaudeStreamProcessor(callbacks: Partial<StreamCallbacks> = {}): ClaudeStreamProcessor {
  return {
    state: createState(),
    callbacks: normalizeCallbacks(callbacks),
    finalResult: null,
  };
}

export function pushClaudeEvent(processor: ClaudeStreamProcessor, event: Record<string, unknown>): void {
  const { state, callbacks } = processor;

  if (event.type === "system") {
    if (typeof event.session_id === "string") state.sessionId = event.session_id;
    if (event.subtype === "api_retry") {
      const attempt = typeof event.attempt === "number" ? event.attempt : 1;
      const maxAttempts = typeof event.max_retries === "number" ? event.max_retries + 1 : attempt + 1;
      const delaySec = typeof event.retry_delay_ms === "number" ? event.retry_delay_ms / 1000 : 0;
      const errorMessage = typeof event.error === "string" ? event.error : "Claude Code API retry";
      callbacks.onRetry?.(attempt, maxAttempts, errorMessage, delaySec);
    }
    return;
  }
  if (event.type === "stream_event") {
    processStreamEvent(state, event, callbacks);
    return;
  }
  if (event.type === "user") {
    processUserMessage(state, event, callbacks);
    if (typeof event.session_id === "string") state.sessionId = event.session_id;
    return;
  }
  if (event.type === "assistant") {
    applyAssistantSnapshot(state, event, callbacks);
    if (typeof event.session_id === "string") state.sessionId = event.session_id;
    return;
  }
  if (event.type === "result") {
    processor.finalResult = event as ClaudeResultEnvelope;
    if (typeof event.session_id === "string") state.sessionId = event.session_id;
    const usage = parseUsage(event.usage as Record<string, unknown> | undefined);
    if (usage.inputTokens != null) state.inputTokens = usage.inputTokens;
    if (usage.outputTokens != null) state.outputTokens = usage.outputTokens;
    if (typeof event.stop_reason === "string" && !state.stopReason) state.stopReason = event.stop_reason;
  }
}

export function finalizeClaudeStream(processor: ClaudeStreamProcessor): StreamResult {
  const { state, callbacks, finalResult } = processor;

  for (const block of state.blocks.values()) {
    finalizeBlock(state, block, callbacks);
  }

  const error = finalResult ? errorFromResult(finalResult) : null;
  if (error) throw error;

  return {
    text: state.fullText,
    thinking: state.fullThinking,
    stopReason: state.stopReason,
    blocks: state.orderedBlocks,
    toolCalls: [],
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    assistantProviderData: state.sessionId ? { anthropic: { sessionId: state.sessionId } } : undefined,
  };
}

export function readClaudeEventsForTest(
  events: Record<string, unknown>[],
  callbacks: Partial<StreamCallbacks> = {},
): StreamResult {
  const processor = createClaudeStreamProcessor(callbacks);
  for (const event of events) pushClaudeEvent(processor, event);
  return finalizeClaudeStream(processor);
}

export async function readAnthropicStream(
  stdout: ReadableStream<Uint8Array>,
  cb: StreamCallbacks,
  stallTimeoutMs: number,
): Promise<StreamResult> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const processor = createClaudeStreamProcessor(cb);

  while (true) {
    let stallTimer: ReturnType<typeof setTimeout>;
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        stallTimer = setTimeout(() => reject(new Error(`No data for ${stallTimeoutMs / 1000}s`)), stallTimeoutMs);
      }),
    ]).finally(() => clearTimeout(stallTimer!));

    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        pushClaudeEvent(processor, JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        continue;
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    try {
      pushClaudeEvent(processor, JSON.parse(buffer.trim()) as Record<string, unknown>);
    } catch {
      // ignore trailing garbage
    }
  }

  return finalizeClaudeStream(processor);
}
