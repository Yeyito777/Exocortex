import { log } from "../../log";
import type { ApiToolCall } from "../types";
import type { ContentBlock, StreamCallbacks, StreamResult } from "../types";
import { extractReasoningSummaries, finalizeReasoningItem, mergeReasoningSummaries } from "./reasoning";
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
  fullText: string;
  fullThinking: { value: string };
  blocks: ContentBlock[];
  toolCalls: ApiToolCall[];
  textStarted: Set<string>;
  toolStates: Map<number, OpenAIStreamToolState>;
  reasoningStates: Map<number, OpenAIReasoningItem>;
  reasoningOutputIndexesById: Map<string, number>;
  currentReasoningIndexes: Map<number, number>;
  startedReasoningSummaries: Set<string>;
  currentReasoningOutputIndex: number | null;
}

function finalizeTextBlock(text: string, blocks: ContentBlock[]): void {
  if (text) blocks.push({ type: "text", text });
}

function createReadState(): OpenAIReadState {
  return {
    stopReason: "",
    fullText: "",
    fullThinking: { value: "" },
    blocks: [],
    toolCalls: [],
    textStarted: new Set<string>(),
    toolStates: new Map<number, OpenAIStreamToolState>(),
    reasoningStates: new Map<number, OpenAIReasoningItem>(),
    reasoningOutputIndexesById: new Map<string, number>(),
    currentReasoningIndexes: new Map<number, number>(),
    startedReasoningSummaries: new Set<string>(),
    currentReasoningOutputIndex: null,
  };
}

function reasoningSummaryKey(outputIndex: number, summaryIndex: number): string {
  return `${outputIndex}:${summaryIndex}`;
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

function startReasoningSummary(
  state: OpenAIReadState,
  outputIndex: number,
  summaryIndex: number,
  cb: StreamCallbacks,
): OpenAIReasoningItem | undefined {
  const reasoning = state.reasoningStates.get(outputIndex);
  if (!reasoning) return undefined;
  ensureReasoningSummarySlot(reasoning, summaryIndex);
  const key = reasoningSummaryKey(outputIndex, summaryIndex);
  if (!state.startedReasoningSummaries.has(key)) {
    state.startedReasoningSummaries.add(key);
    cb.onBlockStart?.("thinking");
  }
  return reasoning;
}

function nextReasoningStateIndex(state: OpenAIReadState): number {
  let index = state.reasoningStates.size;
  while (state.reasoningStates.has(index)) index++;
  return index;
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

  if (existing) {
    existing.summaries = mergeReasoningSummaries(existing.summaries, summaries);
    if (typeof item.encrypted_content === "string") {
      existing.encryptedContent = item.encrypted_content;
    }
    return;
  }

  const outputIndex = nextReasoningStateIndex(state);
  const reasoningItem: OpenAIReasoningItem = {
    id: String(item.id ?? outputIndex),
    encryptedContent: typeof item.encrypted_content === "string" ? item.encrypted_content : null,
    summaries,
  };
  state.reasoningStates.set(outputIndex, reasoningItem);
  state.reasoningOutputIndexesById.set(reasoningItem.id, outputIndex);
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
      const itemId = String(event.item_id ?? "assistant");
      if (!state.textStarted.has(itemId)) {
        state.textStarted.add(itemId);
        cb.onBlockStart?.("text");
      }
      const delta = String(event.delta ?? "");
      state.fullText += delta;
      cb.onText(delta);
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
      const summaryIndex = Number(event.summary_index ?? 0);
      state.currentReasoningIndexes.set(outputIndex, summaryIndex);
      startReasoningSummary(state, outputIndex, summaryIndex, cb);
      break;
    }

    case "response.reasoning_summary_text.delta": {
      const outputIndex = resolveReasoningOutputIndex(state, event);
      if (outputIndex == null) break;
      state.currentReasoningOutputIndex = outputIndex;
      const summaryIndex = typeof event.summary_index === "number"
        ? event.summary_index
        : (state.currentReasoningIndexes.get(outputIndex) ?? 0);
      state.currentReasoningIndexes.set(outputIndex, summaryIndex);
      const reasoning = startReasoningSummary(state, outputIndex, summaryIndex, cb);
      if (!reasoning) break;
      const delta = String(event.delta ?? "");
      reasoning.summaries[summaryIndex] += delta;
      cb.onThinking(delta);
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
        const reasoning = state.reasoningStates.get(outputIndex);
        if (reasoning) {
          if (typeof item.id === "string") {
            reasoning.id = item.id;
            state.reasoningOutputIndexesById.set(item.id, outputIndex);
          }
          if (typeof item.encrypted_content === "string") {
            reasoning.encryptedContent = item.encrypted_content;
          }
          state.reasoningStates.set(outputIndex, reasoning);
        }
        if (state.currentReasoningOutputIndex === outputIndex) {
          state.currentReasoningOutputIndex = null;
        }
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
        } else if (item.type === "message" && !state.fullText) {
          const content = Array.isArray(item.content) ? item.content : [];
          state.fullText = content
            .filter((part): part is { type?: string; text?: string } => !!part && typeof part === "object")
            .filter((part) => part.type === "output_text")
            .map((part) => part.text ?? "")
            .join("");
        }
      }
      state.stopReason = event.type === "response.completed"
        ? (state.toolCalls.length > 0 ? "tool_use" : "stop")
        : String(response?.incomplete_details?.reason ?? "incomplete");
      break;
    }

    case "response.failed": {
      const response = event.response as { error?: { message?: string } } | undefined;
      throw new Error(response?.error?.message ?? "OpenAI response failed");
    }

    case "error": {
      const err = event.error as { message?: string } | undefined;
      throw new Error(err?.message ?? "OpenAI stream error");
    }
  }
}

function finalizeReadState(state: OpenAIReadState): StreamResult {
  finalizeTextBlock(state.fullText, state.blocks);
  const orderedReasoningItems = [...state.reasoningStates.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item)
    .filter((item) => item.summaries.some((summary) => summary.length > 0));
  for (const item of orderedReasoningItems) {
    finalizeReasoningItem(item, state.blocks, state.fullThinking);
  }

  if (!state.stopReason && state.toolCalls.length > 0) state.stopReason = "tool_use";

  return {
    text: state.fullText,
    thinking: state.fullThinking.value,
    stopReason: state.stopReason,
    blocks: [
      ...state.blocks.filter((block) => block.type === "thinking"),
      ...state.blocks.filter((block) => block.type === "text"),
    ],
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
    onSignature: callbacks.onSignature,
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
