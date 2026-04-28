import { log } from "../../log";
import { NonRetryableProviderError } from "../errors";
import type { ApiToolCall } from "../types";
import type { ContentBlock, StreamCallbacks, StreamResult } from "../types";
import { extractReasoningRawContent, extractReasoningSummaries, finalizeReasoningItem, hasRenderableReasoning, mergeReasoningSummaries } from "./reasoning";
import type { OpenAIReasoningItem } from "./types";

export interface OpenAIStreamToolState {
  id: string;
  name: string;
  arguments: string;
}

interface OpenAIReadState {
  responseId?: string;
  inputTokens?: number;
  outputTokens?: number;
  stopReason: string;
  toolCalls: ApiToolCall[];
  textStarted: Set<string>;
  textStates: Map<number, string[]>;
  textOutputIndexesById: Map<string, number>;
  toolStates: Map<number, OpenAIStreamToolState>;
  reasoningStates: Map<number, OpenAIReasoningItem>;
  reasoningOutputIndexesById: Map<string, number>;
  currentReasoningIndexes: Map<number, number>;
  currentReasoningOutputIndex: number | null;
  currentRawReasoningIndexes: Map<number, number>;
}

function createReadState(): OpenAIReadState {
  return {
    stopReason: "",
    toolCalls: [],
    textStarted: new Set<string>(),
    textStates: new Map<number, string[]>(),
    textOutputIndexesById: new Map<string, number>(),
    toolStates: new Map<number, OpenAIStreamToolState>(),
    reasoningStates: new Map<number, OpenAIReasoningItem>(),
    reasoningOutputIndexesById: new Map<string, number>(),
    currentReasoningIndexes: new Map<number, number>(),
    currentReasoningOutputIndex: null,
    currentRawReasoningIndexes: new Map<number, number>(),
  };
}

interface OpenAIErrorPayload {
  message?: string;
  code?: string;
  type?: string;
}

function extractOpenAIErrorPayload(value: unknown): OpenAIErrorPayload | undefined {
  if (typeof value === "string") return { message: value };
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.type === "string" ? { type: record.type } : {}),
  };
}

function isContextWindowExceededError(error: OpenAIErrorPayload | undefined): boolean {
  const haystacks = [error?.message, error?.code, error?.type]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());

  return haystacks.some((value) =>
    value.includes("context_length_exceeded")
    || value.includes("maximum context length")
    || value.includes("too many tokens")
    || (value.includes("context window") && (value.includes("exceed") || value.includes("too large")))
    || (value.includes("input") && value.includes("exceed") && value.includes("context"))
  );
}

function buildOpenAIStreamError(error: OpenAIErrorPayload | undefined, fallback: string): Error {
  const message = error?.message ?? fallback;
  return isContextWindowExceededError(error)
    ? new NonRetryableProviderError(message)
    : new Error(message);
}

function nextOutputStateIndex(state: OpenAIReadState): number {
  let index = 0;
  while (state.reasoningStates.has(index) || state.textStates.has(index) || state.toolStates.has(index)) index++;
  return index;
}

function resolveTextOutputIndex(state: OpenAIReadState, event: Record<string, unknown>): number | null {
  const rawOutputIndex = event.output_index;
  if (typeof rawOutputIndex === "number" && Number.isFinite(rawOutputIndex)) return rawOutputIndex;
  const itemId = typeof event.item_id === "string" ? event.item_id : typeof event.id === "string" ? event.id : null;
  if (itemId) return state.textOutputIndexesById.get(itemId) ?? null;
  return null;
}

function ensureTextContentSlot(textParts: string[], contentIndex: number): void {
  while (textParts.length <= contentIndex) textParts.push("");
}

function setTextContent(state: OpenAIReadState, outputIndex: number, contentIndex: number, text: string): void {
  const textParts = [...(state.textStates.get(outputIndex) ?? [])];
  ensureTextContentSlot(textParts, contentIndex);
  textParts[contentIndex] = text;
  state.textStates.set(outputIndex, textParts);
}

function appendTextContent(state: OpenAIReadState, outputIndex: number, contentIndex: number, delta: string): void {
  const textParts = [...(state.textStates.get(outputIndex) ?? [])];
  ensureTextContentSlot(textParts, contentIndex);
  textParts[contentIndex] += delta;
  state.textStates.set(outputIndex, textParts);
}

function joinedTextContent(textParts: string[] | undefined): string {
  return (textParts ?? []).join("");
}

function handleCompletedMessageItem(state: OpenAIReadState, item: Record<string, unknown>): void {
  const content = Array.isArray(item.content) ? item.content : [];
  const itemId = typeof item.id === "string" ? item.id : undefined;
  const outputIndex = itemId != null
    ? (state.textOutputIndexesById.get(itemId) ?? nextOutputStateIndex(state))
    : nextOutputStateIndex(state);

  const textParts = [...(state.textStates.get(outputIndex) ?? [])];
  for (const [contentIndex, rawPart] of content.entries()) {
    if (!rawPart || typeof rawPart !== "object") continue;
    const part = rawPart as { type?: string; text?: string };
    if (part.type !== "output_text") continue;
    ensureTextContentSlot(textParts, contentIndex);
    textParts[contentIndex] = part.text ?? "";
  }

  if (joinedTextContent(textParts).length === 0) return;
  state.textStates.set(outputIndex, textParts);
  if (itemId) state.textOutputIndexesById.set(itemId, outputIndex);
}

function ensureReasoningSummarySlot(reasoning: OpenAIReasoningItem, summaryIndex: number): void {
  while (reasoning.summaries.length <= summaryIndex) reasoning.summaries.push("");
}

function resolveReasoningOutputIndex(state: OpenAIReadState, event: Record<string, unknown>): number | null {
  const rawOutputIndex = event.output_index;
  if (typeof rawOutputIndex === "number" && Number.isFinite(rawOutputIndex)) {
    return rawOutputIndex;
  }
  const itemId = typeof event.item_id === "string"
    ? event.item_id
    : typeof event.id === "string"
      ? event.id
      : null;
  if (itemId) {
    const mapped = state.reasoningOutputIndexesById.get(itemId);
    if (mapped != null) return mapped;
  }
  return state.currentReasoningOutputIndex;
}

function ensureReasoningSummaryState(
  state: OpenAIReadState,
  outputIndex: number,
  summaryIndex: number,
): OpenAIReasoningItem | undefined {
  const reasoning = state.reasoningStates.get(outputIndex);
  if (!reasoning) return undefined;
  ensureReasoningSummarySlot(reasoning, summaryIndex);
  return reasoning;
}

function ensureRawReasoningSlot(reasoning: OpenAIReasoningItem, contentIndex: number): void {
  if (!reasoning.rawContent) reasoning.rawContent = [];
  while (reasoning.rawContent.length <= contentIndex) reasoning.rawContent.push("");
}

function handleCompletedReasoningItem(state: OpenAIReadState, item: Record<string, unknown>): void {
  const itemId = typeof item.id === "string" ? item.id : undefined;
  const knownOutputIndex = itemId != null
    ? state.reasoningOutputIndexesById.get(itemId)
    : undefined;
  const existing = knownOutputIndex != null
    ? state.reasoningStates.get(knownOutputIndex)
    : [...state.reasoningStates.values()].find((candidate) => candidate.id === String(item.id ?? ""));
  const summaries = extractReasoningSummaries(item);

  const rawContent = extractReasoningRawContent(item);

  if (existing) {
    existing.summaries = mergeReasoningSummaries(existing.summaries, summaries);
    if (rawContent.length > 0) existing.rawContent = rawContent;
    if (typeof item.encrypted_content === "string") {
      existing.encryptedContent = item.encrypted_content;
    }
    return;
  }

  const outputIndex = nextOutputStateIndex(state);
  const reasoningItem: OpenAIReasoningItem = {
    id: String(item.id ?? outputIndex),
    encryptedContent: typeof item.encrypted_content === "string" ? item.encrypted_content : null,
    summaries,
    ...(rawContent.length > 0 ? { rawContent } : {}),
  };
  state.reasoningStates.set(outputIndex, reasoningItem);
  state.reasoningOutputIndexesById.set(reasoningItem.id, outputIndex);
}

type OpenAIRenderableBlock = Extract<ContentBlock, { type: "thinking" | "text" }>;

function buildOrderedBlocks(state: OpenAIReadState): OpenAIRenderableBlock[] {
  const orderedReasoningEntries = [...state.reasoningStates.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, item]) => hasRenderableReasoning(item));
  const orderedTextEntries = [...state.textStates.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([outputIndex, textParts]) => ({ outputIndex, text: joinedTextContent(textParts) }))
    .filter((entry) => entry.text.length > 0);
  const orderedEntries = [
    ...orderedReasoningEntries.map(([outputIndex, item]) => ({ outputIndex, kind: "reasoning" as const, item })),
    ...orderedTextEntries.map(({ outputIndex, text }) => ({ outputIndex, kind: "text" as const, text })),
  ].sort((a, b) => a.outputIndex - b.outputIndex);

  const orderedBlocks: OpenAIRenderableBlock[] = [];
  for (const entry of orderedEntries) {
    if (entry.kind === "reasoning") {
      finalizeReasoningItem(entry.item, orderedBlocks, { value: "" });
    } else {
      orderedBlocks.push({ type: "text", text: entry.text });
    }
  }
  return orderedBlocks;
}

/**
 * Emit a diff only when it can be represented as ordinary tail streaming.
 *
 * The chunk protocol can append to the current last block and start new blocks,
 * but it cannot patch an earlier block once later blocks already exist. When an
 * OpenAI event revises an earlier block, fall back to a full canonical sync.
 */
function emitTailDiff(before: OpenAIRenderableBlock[], after: OpenAIRenderableBlock[], cb: StreamCallbacks): boolean {
  if (before.length > after.length) return false;

  for (let i = 0; i < before.length; i++) {
    const prev = before[i];
    const next = after[i];
    if (prev.type !== next.type) return false;
    const isLastSharedBlock = i === before.length - 1;
    if (!isLastSharedBlock) {
      if (prev.text !== next.text) return false;
      continue;
    }
    if (!next.text.startsWith(prev.text)) return false;
  }

  if (before.length > 0) {
    const prev = before[before.length - 1];
    const next = after[before.length - 1];
    const suffix = next.text.slice(prev.text.length);
    if (suffix) {
      if (next.type === "text") cb.onText(suffix);
      else cb.onThinking(suffix);
    }
  }

  for (let i = before.length; i < after.length; i++) {
    cb.onBlockStart?.(after[i].type);
    if (after[i].type === "text") cb.onText(after[i].text);
    else cb.onThinking(after[i].text);
  }
  return true;
}

function emitOrSyncBlocks(before: OpenAIRenderableBlock[], after: OpenAIRenderableBlock[], cb: StreamCallbacks): void {
  if (!emitTailDiff(before, after, cb)) cb.onBlocksUpdate?.(after);
}

function updateBlocks(state: OpenAIReadState, cb: StreamCallbacks, mutate: () => void): void {
  const before = buildOrderedBlocks(state);
  mutate();
  emitOrSyncBlocks(before, buildOrderedBlocks(state), cb);
}

function resolveTextContentIndex(event: Record<string, unknown>): number {
  return typeof event.content_index === "number" ? event.content_index : 0;
}

function resolveReasoningContentIndex(state: OpenAIReadState, event: Record<string, unknown>, outputIndex: number): number {
  const contentIndex = typeof event.content_index === "number"
    ? event.content_index
    : (state.currentRawReasoningIndexes.get(outputIndex) ?? 0);
  state.currentRawReasoningIndexes.set(outputIndex, contentIndex);
  return contentIndex;
}

function resolveReasoningSummaryIndex(state: OpenAIReadState, event: Record<string, unknown>, outputIndex: number): number {
  const summaryIndex = typeof event.summary_index === "number"
    ? event.summary_index
    : (state.currentReasoningIndexes.get(outputIndex) ?? 0);
  state.currentReasoningIndexes.set(outputIndex, summaryIndex);
  return summaryIndex;
}

function handleStreamEvent(state: OpenAIReadState, event: Record<string, unknown>, cb: StreamCallbacks): void {
  switch (event.type) {
    case "response.created":
      state.responseId = (event.response as { id?: string } | undefined)?.id;
      break;

    case "response.output_item.added": {
      const outputIndex = event.output_index as number;
      const item = event.item as Record<string, unknown> | undefined;
      if (!item) break;
      if (item.type === "function_call") {
        state.toolStates.set(outputIndex, {
          id: String(item.call_id ?? ""),
          name: String(item.name ?? ""),
          arguments: "",
        });
      } else if (item.type === "message") {
        if (typeof item.id === "string") state.textOutputIndexesById.set(item.id, outputIndex);
        if (!state.textStates.has(outputIndex)) state.textStates.set(outputIndex, []);
      } else if (item.type === "reasoning") {
        const reasoningItem: OpenAIReasoningItem = {
          id: String(item.id ?? outputIndex),
          encryptedContent: typeof item.encrypted_content === "string" ? item.encrypted_content : null,
          summaries: [],
        };
        state.reasoningStates.set(outputIndex, reasoningItem);
        state.reasoningOutputIndexesById.set(reasoningItem.id, outputIndex);
        state.currentReasoningOutputIndex = outputIndex;
      }
      break;
    }

    case "response.output_text.delta": {
      const outputIndex = resolveTextOutputIndex(state, event);
      const delta = String(event.delta ?? "");
      if (outputIndex == null) {
        const itemId = String(event.item_id ?? "assistant");
        if (!state.textStarted.has(itemId)) {
          state.textStarted.add(itemId);
          cb.onBlockStart?.("text");
        }
        cb.onText(delta);
        break;
      }
      updateBlocks(state, cb, () => {
        appendTextContent(state, outputIndex, resolveTextContentIndex(event), delta);
      });
      break;
    }

    case "response.output_text.done": {
      const outputIndex = resolveTextOutputIndex(state, event);
      if (outputIndex == null) break;
      updateBlocks(state, cb, () => {
        setTextContent(state, outputIndex, resolveTextContentIndex(event), String(event.text ?? ""));
      });
      break;
    }

    case "response.function_call_arguments.delta": {
      const outputIndex = event.output_index as number;
      const toolState = state.toolStates.get(outputIndex);
      if (toolState) toolState.arguments += String(event.delta ?? "");
      break;
    }

    case "response.reasoning_summary_part.added": {
      const outputIndex = resolveReasoningOutputIndex(state, event);
      if (outputIndex == null) break;
      state.currentReasoningOutputIndex = outputIndex;
      ensureReasoningSummaryState(state, outputIndex, resolveReasoningSummaryIndex(state, event, outputIndex));
      break;
    }

    case "response.reasoning_text.delta": {
      const outputIndex = resolveReasoningOutputIndex(state, event);
      if (outputIndex == null) break;
      state.currentReasoningOutputIndex = outputIndex;
      const contentIndex = resolveReasoningContentIndex(state, event, outputIndex);
      const reasoning = state.reasoningStates.get(outputIndex);
      if (!reasoning) break;
      updateBlocks(state, cb, () => {
        ensureRawReasoningSlot(reasoning, contentIndex);
        reasoning.rawContent![contentIndex] += String(event.delta ?? "");
      });
      break;
    }

    case "response.reasoning_text.done": {
      const outputIndex = resolveReasoningOutputIndex(state, event);
      if (outputIndex == null) break;
      state.currentReasoningOutputIndex = outputIndex;
      const contentIndex = resolveReasoningContentIndex(state, event, outputIndex);
      const reasoning = state.reasoningStates.get(outputIndex);
      if (!reasoning) break;
      updateBlocks(state, cb, () => {
        ensureRawReasoningSlot(reasoning, contentIndex);
        reasoning.rawContent![contentIndex] = String(event.text ?? "");
      });
      break;
    }

    case "response.reasoning_summary_text.delta": {
      const outputIndex = resolveReasoningOutputIndex(state, event);
      if (outputIndex == null) break;
      state.currentReasoningOutputIndex = outputIndex;
      const summaryIndex = resolveReasoningSummaryIndex(state, event, outputIndex);
      const reasoning = ensureReasoningSummaryState(state, outputIndex, summaryIndex);
      if (!reasoning) break;
      updateBlocks(state, cb, () => {
        reasoning.summaries[summaryIndex] += String(event.delta ?? "");
      });
      break;
    }

    case "response.reasoning_summary_text.done": {
      const outputIndex = resolveReasoningOutputIndex(state, event);
      if (outputIndex == null) break;
      state.currentReasoningOutputIndex = outputIndex;
      const summaryIndex = resolveReasoningSummaryIndex(state, event, outputIndex);
      const reasoning = ensureReasoningSummaryState(state, outputIndex, summaryIndex);
      if (!reasoning) break;
      updateBlocks(state, cb, () => {
        reasoning.summaries[summaryIndex] = String(event.text ?? "");
      });
      break;
    }

    case "response.output_item.done": {
      const outputIndex = typeof event.output_index === "number"
        ? event.output_index
        : resolveReasoningOutputIndex(state, event);
      const item = event.item as Record<string, unknown> | undefined;
      if (!item || outputIndex == null) break;
      if (item.type === "function_call") {
        const toolState = state.toolStates.get(outputIndex);
        const rawArgs = toolState?.arguments || String(item.arguments ?? "{}");
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
        } catch {
          log("warn", `openai api: failed to parse tool input for ${String(item.name ?? "unknown")}`);
        }
        state.toolCalls.push({
          id: toolState?.id || String(item.call_id ?? ""),
          name: toolState?.name || String(item.name ?? ""),
          input,
        });
        state.toolStates.delete(outputIndex);
      } else if (item.type === "reasoning") {
        updateBlocks(state, cb, () => {
          handleCompletedReasoningItem(state, item);
          if (state.currentReasoningOutputIndex === outputIndex) {
            state.currentReasoningOutputIndex = null;
          }
        });
      } else if (item.type === "message") {
        updateBlocks(state, cb, () => {
          handleCompletedMessageItem(state, item);
        });
      }
      break;
    }

    case "response.completed":
    case "response.incomplete": {
      const response = event.response as {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
        };
        incomplete_details?: { reason?: string };
        output?: Array<Record<string, unknown>>;
      } | undefined;
      updateBlocks(state, cb, () => {
        state.inputTokens = response?.usage?.input_tokens;
        state.outputTokens = response?.usage?.output_tokens;
        for (const item of response?.output ?? []) {
          if (item.type === "reasoning") {
            handleCompletedReasoningItem(state, item);
          } else if (item.type === "function_call") {
            if (!state.toolCalls.some((call) => call.id === String(item.call_id ?? ""))) {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(String(item.arguments ?? "{}")) as Record<string, unknown>;
              } catch {}
              state.toolCalls.push({
                id: String(item.call_id ?? ""),
                name: String(item.name ?? ""),
                input,
              });
            }
          } else if (item.type === "message") {
            handleCompletedMessageItem(state, item);
          }
        }
      });
      state.stopReason = event.type === "response.completed"
        ? (state.toolCalls.length > 0 ? "tool_use" : "stop")
        : String(response?.incomplete_details?.reason ?? "incomplete");
      break;
    }

    case "response.failed": {
      const response = event.response as { error?: unknown } | undefined;
      throw buildOpenAIStreamError(extractOpenAIErrorPayload(response?.error), "OpenAI response failed");
    }

    case "error": {
      const error = extractOpenAIErrorPayload(event.error) ?? extractOpenAIErrorPayload(event);
      throw buildOpenAIStreamError(error, "OpenAI stream error");
    }
  }
}

function finalizeReadState(state: OpenAIReadState): StreamResult {
  const orderedReasoningEntries = [...state.reasoningStates.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, item]) => hasRenderableReasoning(item));
  const orderedReasoningItems = orderedReasoningEntries.map(([, item]) => item);
  const orderedTextEntries = [...state.textStates.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([outputIndex, textParts]) => ({ outputIndex, text: joinedTextContent(textParts) }))
    .filter((entry) => entry.text.length > 0);
  const orderedBlocks = buildOrderedBlocks(state);

  const fullText = orderedTextEntries.map(({ text }) => text).join("");
  const fullThinking = orderedBlocks
    .filter((block): block is Extract<ContentBlock, { type: "thinking" }> => block.type === "thinking")
    .map((block) => block.text)
    .join("");
  if (!state.stopReason && state.toolCalls.length > 0) state.stopReason = "tool_use";

  return {
    text: fullText,
    thinking: fullThinking,
    stopReason: state.stopReason,
    blocks: orderedBlocks,
    toolCalls: state.toolCalls,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    assistantProviderData: {
      openai: {
        ...(state.responseId ? { responseId: state.responseId } : {}),
        reasoningItems: orderedReasoningItems,
      },
    },
  };
}

export function readOpenAIEventsForTest(
  events: Record<string, unknown>[],
  callbacks: Partial<StreamCallbacks> = {},
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
  for (const event of events) {
    handleStreamEvent(state, event, cb);
  }
  return finalizeReadState(state);
}

function parseEventData(chunk: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const pieces = chunk.split("\n\n");
  for (const piece of pieces) {
    const lines = piece.split("\n").map((line) => line.trim()).filter(Boolean);
    const dataLines = lines.filter((line) => line.startsWith("data: "));
    if (dataLines.length === 0) continue;
    const data = dataLines.map((line) => line.slice(6)).join("\n");
    if (data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return events;
}

export async function readOpenAIStream(res: Response, cb: StreamCallbacks, stallTimeoutMs: number): Promise<StreamResult> {
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
    for (const event of parseEventData(ready)) {
      handleStreamEvent(state, event, cb);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const event of parseEventData(buffer)) {
      handleStreamEvent(state, event, cb);
    }
  }

  return finalizeReadState(state);
}
