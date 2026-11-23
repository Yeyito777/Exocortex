/**
 * Translate a turn's ACP session/update notifications into Exocortex stream
 * callbacks and a StreamResult.
 *
 * The Antigravity CLI runs the whole agent loop, its own tools included, so
 * one Exocortex provider request spans many model calls. Text and thought
 * chunks stream live; each tool call and its result become a normal
 * tool_use → tool_result message pair, and a round is handed to the agent
 * loop (onProviderRound) as soon as its last open call finishes, carrying the
 * session's resume mark (prompt.ts).
 */

import { randomUUID } from "node:crypto";
import type { ApiContentBlock, ApiMessage } from "../../messages";
import { chronoCallPresentation } from "../../tools/chrono";
import { exocortexNameForAntigravity, summarizeAntigravityTool } from "../../tools/antigravity";
import { resolveToolCallPresentationFromCache } from "../../helper-tool-manifest";
import { takeHostToolAttachments } from "../anthropic/host-tool-attachments";
import type { ContentBlock, ProviderRound, StreamCallbacks, StreamResult } from "../types";
import { setSessionHead } from "./prompt";
import type { GeminiAssistantProviderData } from "./types";

type Json = Record<string, unknown>;

export interface GeminiStreamState {
  callbacks: StreamCallbacks;
  cwd: string;
  sessionId: string;
  blocks: ContentBlock[];
  messages: ApiMessage[];
  /** Text/thought deltas of the block now streaming. */
  pendingText: string;
  pendingThinking: string;
  /** Tool calls of the current round still waiting for a result. */
  openToolUses: Set<string>;
  toolNames: Map<string, string>;
  /** Host tool results Exocortex produced, by call id, for the update that closes them. */
  hostResults: Map<string, { output: string; isError: boolean }>;
  /** Latest context size the CLI reported. */
  contextTokens?: number;
  outputTokens: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  committedOutputTokens: number;
  lastMark: string | null;
  done: boolean;
  stopReason: string;
}

export function createGeminiStreamState(callbacks: StreamCallbacks, cwd: string, sessionId: string): GeminiStreamState {
  return {
    callbacks,
    cwd,
    sessionId,
    blocks: [],
    messages: [],
    pendingText: "",
    pendingThinking: "",
    openToolUses: new Set(),
    toolNames: new Map(),
    hostResults: new Map(),
    outputTokens: 0,
    committedOutputTokens: 0,
    lastMark: null,
    done: false,
    stopReason: "",
  };
}

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pushMessageContent(state: GeminiStreamState, role: ApiMessage["role"], block: ApiContentBlock): void {
  const last = state.messages.at(-1);
  if (last && last.role === role && Array.isArray(last.content)) last.content.push(block);
  else state.messages.push({ role, content: [block] });
}

/** Close the streaming text/thought block into the canonical record. */
function flushPending(state: GeminiStreamState): void {
  if (state.pendingThinking) {
    const text = state.pendingThinking;
    state.pendingThinking = "";
    state.blocks.push({ type: "thinking", text, signature: "" });
    pushMessageContent(state, "assistant", { type: "thinking", thinking: text, signature: "" });
  }
  if (state.pendingText) {
    const text = state.pendingText;
    state.pendingText = "";
    state.blocks.push({ type: "text", text });
    pushMessageContent(state, "assistant", { type: "text", text });
  }
}

function resumePoint(state: GeminiStreamState): GeminiAssistantProviderData {
  const mark = randomUUID();
  state.lastMark = mark;
  setSessionHead(state.sessionId, mark);
  return { gemini: { sessionId: state.sessionId, mark, cwd: state.cwd } };
}

/** Hand the finished tool round to the agent loop. An interrupted one gets no resume mark. */
function commitRound(state: GeminiStreamState, resumable = true): void {
  const onProviderRound = state.callbacks.onProviderRound;
  if (!onProviderRound || state.messages.length === 0) return;
  if (resumable) state.messages[state.messages.length - 1].providerData = resumePoint(state);
  const round: ProviderRound = {
    blocks: state.blocks,
    messages: state.messages,
    outputTokens: state.outputTokens - state.committedOutputTokens,
    inputTokens: state.contextTokens,
  };
  state.blocks = [];
  state.messages = [];
  state.committedOutputTokens = state.outputTokens;
  onProviderRound(round);
}

function toolInput(update: Json): Json {
  const raw = asRecord(update.rawInput) ?? asRecord(update.args) ?? {};
  const { toolSummary: _summary, ...input } = raw;
  return input;
}

function resultText(update: Json): string {
  const rawOutput = asRecord(update.rawOutput);
  const parts: string[] = [];
  for (const item of Array.isArray(update.content) ? update.content : []) {
    const record = asRecord(item);
    const inner = asRecord(record?.content);
    if (record?.type === "content" && inner?.type === "text" && typeof inner.text === "string") parts.push(inner.text);
    else if (record?.type === "diff") parts.push(`Edited ${str(record.path) ?? "a file"}`);
  }
  if (parts.length > 0) return parts.join("\n");
  if (typeof rawOutput?.output === "string") return rawOutput.output;
  if (rawOutput) return JSON.stringify(rawOutput);
  return "";
}

function handleToolCall(state: GeminiStreamState, update: Json): void {
  const id = str(update.toolCallId) ?? `gemini-${randomUUID()}`;
  if (state.toolNames.has(id)) return;
  flushPending(state);
  const rawName = str(update.name) ?? str(update.title) ?? "tool";
  const name = exocortexNameForAntigravity(rawName);
  const input = toolInput(update);
  const { label, detail } = summarizeAntigravityTool(name, input);
  const summary = detail || label;
  const bashStyles = name === "run_command" ? resolveToolCallPresentationFromCache("bash", { command: input.CommandLine }, state.cwd) : undefined;
  const presentation = { ...bashStyles, ...(name === "chrono" ? chronoCallPresentation(input) : undefined) };
  const named = Object.keys(presentation).length > 0 ? { presentation } : {};
  state.toolNames.set(id, name);
  state.openToolUses.add(id);
  state.blocks.push({ type: "tool_call", id, name, input, summary: presentation.detail || summary, ...named });
  pushMessageContent(state, "assistant", { type: "tool_use", id, name, input, ...named });
  state.callbacks.onToolCall?.({ type: "tool_call", toolCallId: id, toolName: name, input, summary: presentation.detail || summary, ...named });
}

function handleToolUpdate(state: GeminiStreamState, update: Json): void {
  const id = str(update.toolCallId) ?? "";
  if (!state.toolNames.has(id)) {
    // Its tool_call came before this turn (or was never sent): show it now.
    if (update.status !== "completed" && update.status !== "failed") return;
    handleToolCall(state, update);
  }
  if (update.status !== "completed" && update.status !== "failed") {
    state.callbacks.onActivity?.();
    return;
  }
  if (!state.openToolUses.delete(id)) return;
  const toolName = state.toolNames.get(id) ?? "";
  const host = state.hostResults.get(id);
  state.hostResults.delete(id);
  const error = asRecord(asRecord(update.rawOutput)?.error);
  const output = host?.output ?? (resultText(update) || (error ? str(error.message) ?? "The tool failed." : update.status === "failed" ? "The tool failed." : ""));
  const isError = host?.isError ?? update.status === "failed";
  const images = takeHostToolAttachments(id);
  const shown = images?.length ? { images } : {};
  state.blocks.push({ type: "tool_result", toolUseId: id, toolName, output, isError, ...shown });
  pushMessageContent(state, "user", { type: "tool_result", tool_use_id: id, content: output, is_error: isError, ...(images?.length ? { attachments: images } : {}) });
  state.callbacks.onToolResult?.({ type: "tool_result", toolCallId: id, toolName, output, isError, ...shown });
  if (state.openToolUses.size === 0) commitRound(state);
}

/** Feed one session/update into the turn. */
export function pushGeminiUpdate(state: GeminiStreamState, update: Json): void {
  const cb = state.callbacks;
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = str(asRecord(update.content)?.text);
      if (!text) return;
      if (state.pendingThinking) flushPending(state);
      if (!state.pendingText) cb.onBlockStart?.("text");
      state.pendingText += text;
      cb.onText(text);
      return;
    }
    case "agent_thought_chunk": {
      const text = str(asRecord(update.content)?.text);
      if (!text) return;
      if (state.pendingText) flushPending(state);
      if (!state.pendingThinking) cb.onBlockStart?.("thinking");
      state.pendingThinking += text;
      cb.onThinking(text);
      return;
    }
    case "tool_call":
      handleToolCall(state, update);
      return;
    case "tool_call_update":
      handleToolUpdate(state, update);
      return;
    case "usage_update": {
      if (typeof update.used === "number" && update.used > 0) state.contextTokens = update.used;
      cb.onActivity?.();
      return;
    }
    default:
      cb.onActivity?.();
  }
}

const INTERRUPTED_TOOL_OUTPUT = "Interrupted before this tool call finished.";

/** Keep an interrupted turn's still-running calls instead of dropping them with the stream. */
export function commitInterruptedRound(state: GeminiStreamState): void {
  flushPending(state);
  for (const id of state.openToolUses) {
    const toolName = state.toolNames.get(id) ?? "";
    state.blocks.push({ type: "tool_result", toolUseId: id, toolName, output: INTERRUPTED_TOOL_OUTPUT, isError: true });
    pushMessageContent(state, "user", { type: "tool_result", tool_use_id: id, content: INTERRUPTED_TOOL_OUTPUT, is_error: true });
    state.callbacks.onToolResult?.({ type: "tool_result", toolCallId: id, toolName, output: INTERRUPTED_TOOL_OUTPUT, isError: true });
  }
  if (state.openToolUses.size > 0) {
    state.openToolUses.clear();
    commitRound(state, false);
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The prompt's result: close the turn. */
export function finishGeminiTurn(state: GeminiStreamState, result: Json): StreamResult {
  flushPending(state);
  // A call the CLI never closed (it ended the turn around it).
  if (state.openToolUses.size > 0) commitInterruptedRound(state);
  const usage = asRecord(result.usage);
  if (usage) {
    state.outputTokens = num(usage.outputTokens) + num(usage.thoughtTokens);
    state.inputTokens = num(usage.inputTokens) + num(usage.cachedReadTokens);
    state.cachedInputTokens = num(usage.cachedReadTokens);
  }
  state.stopReason = str(result.stopReason) ?? "end_turn";
  state.done = true;
  if (state.messages.at(-1)?.role !== "assistant") state.messages.push({ role: "assistant", content: [] });
  const final = state.messages[state.messages.length - 1];
  final.providerData = resumePoint(state);
  const text = state.blocks.filter(b => b.type === "text").map(b => (b as { text: string }).text).join("\n\n");
  const thinking = state.blocks.filter(b => b.type === "thinking").map(b => (b as { text: string }).text).join("\n\n");
  const context = state.contextTokens ?? state.inputTokens;
  return {
    text,
    thinking,
    stopReason: state.stopReason === "max_tokens" ? "max_tokens" : "stop",
    blocks: state.blocks,
    toolCalls: [],
    transcriptMessages: state.messages,
    ...(context ? { inputTokens: context } : {}),
    ...(state.cachedInputTokens ? { cachedInputTokens: state.cachedInputTokens } : {}),
    outputTokens: state.outputTokens,
    ...(usage ? {
      accountedUsage: {
        inputTokens: state.inputTokens ?? 0,
        cachedInputTokens: state.cachedInputTokens ?? 0,
        cacheMissInputTokens: num(usage.inputTokens),
        outputTokens: state.outputTokens,
        requests: 1,
      },
    } : {}),
    assistantProviderData: final.providerData,
  };
}
