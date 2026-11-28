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
 *
 * At the plan's limit the CLI sends no ACP error: it writes the refusal as
 * one last text chunk ("\n⚠ Individual quota reached. ... Resets in
 * 4h16m56s.\n") and ends the prompt `end_turn`
 * (test-fixtures/quota-refusal.acp.jsonl). Such a chunk is held back; if the
 * prompt then ends, the turn ended at the limit (takeGeminiQuotaRefusal),
 * and if more output follows it was the agent's own text after all.
 */

import { randomUUID } from "node:crypto";
import type { ApiContentBlock, ApiMessage } from "../../messages";
import { chronoCallPresentation } from "../../tools/chrono";
import { antigravityKindStyle, exocortexNameForAntigravity, summarizeAntigravityTool } from "../../tools/antigravity";
import { resolveToolCallPresentationFromCache } from "../../helper-tool-manifest";
import { takeHostToolAttachments } from "../anthropic/host-tool-attachments";
import type { ContentBlock, ProviderRound, StreamCallbacks, StreamResult } from "../types";
import { setSessionHead } from "./prompt";
import { AgyTranscriptReader, agyTranscriptPath, backgroundTaskOf, modelCallTokens, stepStartedAt, type AgyBackgroundTask } from "./transcript";
import type { GeminiAssistantProviderData } from "./types";
import { geminiQuotaError, isGeminiQuotaText, type GeminiQuotaError } from "./usage";

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
  now: () => number;
  /** When the latest session/update arrived. */
  lastUpdateAt: number;
  /** When the model call now running started: the prompt was sent, or its round's tools finished. */
  callStartedAt: number | null;
  /** When the round's first tool call arrived: the end of the model call that made it. */
  roundToolAt: number | null;
  /** Open run_command calls: when each started and how long the CLI waits before moving it to the background. */
  commands: Map<string, RunningCommand>;
  /** The CLI's own log of the session, for per-call tokens and background tasks (transcript.ts). */
  transcript: AgyTranscriptReader | null;
  /** Background tasks the log announced that no call has claimed yet. */
  announcedTasks: AgyBackgroundTask[];
  /** Model calls the log showed since the last rate was reported. */
  loggedCalls: LoggedModelCall[];
  /** A cancel is in flight: a call it stops reports failure, which is an interruption. */
  cancelling: boolean;
  /** A call that ran as a background task finished. */
  onBackgroundEnd?: (taskId: string) => void;
  /** A text chunk worded as the CLI words a quota refusal, held back until it is known to be the turn's last output. */
  heldRefusal: string | null;
}

/** A model call from the CLI's log: its tokens and, to the second, when it started and ended. */
interface LoggedModelCall {
  tokens: number;
  startedAt: number | null;
  /** The next step's start, once logged. */
  endedAt: number | null;
}

interface RunningCommand {
  startedAt: number;
  waitMs: number;
  command: string;
  /** Set once the call is known to run in the background. */
  taskId?: string;
}

export interface BackgroundedCommand {
  toolCallId: string;
  taskId: string;
  command: string;
  startedAt: number;
  logPath: string | null;
}

export interface GeminiStreamStateOptions {
  /** null: no transcript (helpers, tests). Default: the session's own. */
  transcript?: AgyTranscriptReader | null;
  now?: () => number;
}

export function createGeminiStreamState(callbacks: StreamCallbacks, cwd: string, sessionId: string, options: GeminiStreamStateOptions = {}): GeminiStreamState {
  const now = options.now ?? Date.now;
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
    now,
    lastUpdateAt: now(),
    callStartedAt: now(),
    roundToolAt: null,
    commands: new Map(),
    transcript: options.transcript === undefined ? new AgyTranscriptReader(agyTranscriptPath(sessionId)) : options.transcript,
    announcedTasks: [],
    loggedCalls: [],
    cancelling: false,
    heldRefusal: null,
  };
}

/** Take in what the CLI logged since the last read: model calls' tokens and announced background tasks. */
function readTranscript(state: GeminiStreamState): void {
  for (const step of state.transcript?.read() ?? []) {
    const startedAt = stepStartedAt(step);
    const previous = state.loggedCalls.at(-1);
    if (previous && previous.endedAt === null && startedAt !== null) previous.endedAt = startedAt;
    const tokens = modelCallTokens(step);
    state.outputTokens += tokens;
    if (tokens > 0) state.loggedCalls.push({ tokens, startedAt, endedAt: null });
    const task = backgroundTaskOf(step);
    if (task) state.announcedTasks.push(task);
  }
}

/** The CLI logs step times to the second. */
const LOG_RESOLUTION_MS = 1_000;
/** A model call timed only by the log's seconds counts toward the rate when it took at least this long. */
const MIN_LOGGED_CALL_MS = 3_000;

/**
 * Report the rates of the model calls that ended since the last report. The
 * span Exocortex timed (from the end of the previous round's tools to `endedAt`,
 * the first tool call or the result) is one model call's only when the log
 * shows just that call in it. Otherwise (a backgrounded command holds a round
 * open while the agent makes more calls, or the round's call was already
 * counted) each call logged with an end is timed by the log's own seconds.
 */
function reportCallRates(state: GeminiStreamState, tokens: number, endedAt: number | null): void {
  const calls = state.loggedCalls;
  state.loggedCalls = [];
  const startedAt = state.callStartedAt;
  const only = calls.length === 1 ? calls[0] : null;
  const timedSpan = startedAt !== null && endedAt !== null && endedAt > startedAt
    && (calls.length === 0 || (only !== null && (only.startedAt === null
      || (only.startedAt >= startedAt - LOG_RESOLUTION_MS && only.startedAt <= endedAt))));
  if (timedSpan) {
    if (tokens > 0) state.callbacks.onGenerationRate?.(tokens / ((endedAt - startedAt) / 1000));
    return;
  }
  for (const call of calls) {
    if (call.startedAt === null || call.endedAt === null) continue;
    const ms = call.endedAt - call.startedAt;
    if (ms >= MIN_LOGGED_CALL_MS) state.callbacks.onGenerationRate?.(call.tokens / (ms / 1000));
  }
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
  readTranscript(state);
  reportCallRates(state, state.outputTokens - state.committedOutputTokens, state.roundToolAt);
  // The next model call starts once this round's tools are done.
  state.callStartedAt = state.now();
  state.roundToolAt = null;
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

const DIFF_LINES = 40;

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * An edit's ACP diff as its changed lines: what the call line (which already
 * names the file) does not say. A new file reads as its size.
 */
export function diffText(oldText: string | undefined, newText: string): string {
  if (oldText === undefined || oldText === null) {
    const lines = lineCount(newText);
    return `Wrote ${lines} line${lines === 1 ? "" : "s"}`;
  }
  const before = oldText.split("\n");
  const after = newText.split("\n");
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  const removed = before.slice(start, endBefore).map(line => `- ${line}`);
  const added = after.slice(start, endAfter).map(line => `+ ${line}`);
  const changed = [...removed, ...added];
  if (changed.length === 0) return "No change";
  const shown = changed.slice(0, DIFF_LINES);
  if (changed.length > DIFF_LINES) shown.push(`… ${changed.length - DIFF_LINES} more changed lines`);
  return [`@@ line ${start + 1} @@`, ...shown].join("\n");
}

function resultText(update: Json): string {
  const rawOutput = asRecord(update.rawOutput);
  const parts: string[] = [];
  for (const item of Array.isArray(update.content) ? update.content : []) {
    const record = asRecord(item);
    const inner = asRecord(record?.content);
    if (record?.type === "content" && inner?.type === "text" && typeof inner.text === "string") parts.push(inner.text);
    else if (record?.type === "diff" && typeof record.newText === "string") parts.push(diffText(str(record.oldText), record.newText));
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
  // A tool Exocortex has no entry for takes the look of its ACP kind's counterpart.
  const toolStyle = antigravityKindStyle(name, str(update.kind));
  const presentation = { ...bashStyles, ...(name === "chrono" ? chronoCallPresentation(input) : undefined), ...(toolStyle ? { toolStyle } : {}) };
  const named = Object.keys(presentation).length > 0 ? { presentation } : {};
  state.toolNames.set(id, name);
  state.openToolUses.add(id);
  state.roundToolAt ??= state.now();
  if (name === "run_command" && update.status !== "completed" && update.status !== "failed") {
    const waitMs = typeof input.WaitMsBeforeAsync === "number" ? input.WaitMsBeforeAsync : Number(input.WaitMsBeforeAsync);
    state.commands.set(id, { startedAt: state.now(), waitMs: Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : DEFAULT_ASYNC_WAIT_MS, command: str(input.CommandLine) ?? "" });
  }
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
  endCommand(state, id);
  // Text the agent wrote while the call ran (a background command) comes before its result.
  flushPending(state);
  const toolName = state.toolNames.get(id) ?? "";
  const host = state.hostResults.get(id);
  state.hostResults.delete(id);
  const error = asRecord(asRecord(update.rawOutput)?.error);
  const failed = update.status === "failed" ? state.cancelling ? INTERRUPTED_TOOL_OUTPUT : "The tool failed." : "";
  const output = host?.output ?? (resultText(update) || (error ? str(error.message) ?? failed : failed));
  const isError = host?.isError ?? update.status === "failed";
  const images = takeHostToolAttachments(id);
  const shown = images?.length ? { images } : {};
  state.blocks.push({ type: "tool_result", toolUseId: id, toolName, output, isError, ...shown });
  pushMessageContent(state, "user", { type: "tool_result", tool_use_id: id, content: output, is_error: isError, ...(images?.length ? { attachments: images } : {}) });
  state.callbacks.onToolResult?.({ type: "tool_result", toolCallId: id, toolName, output, isError, ...shown });
  if (state.openToolUses.size === 0) commitRound(state);
}

/** A run_command call ended: a background task it ran is over. */
function endCommand(state: GeminiStreamState, id: string): void {
  const command = state.commands.get(id);
  if (!command) return;
  state.commands.delete(id);
  if (command.taskId) state.onBackgroundEnd?.(command.taskId);
}

/** How long the CLI runs a command before moving it to the background, when the call does not say. */
const DEFAULT_ASYNC_WAIT_MS = 5_000;
/** Past its wait, how long a command may go unannounced in the CLI's log before it is taken as backgrounded anyway. */
const ANNOUNCE_GRACE_MS = 5_000;

/**
 * Commands that moved to the background since the last call: still running
 * past their WaitMsBeforeAsync. Each is matched to the task the CLI's log
 * announced for it (its id and log file); unannounced after a grace period,
 * it is named by its call.
 */
export function takeBackgroundedCommands(state: GeminiStreamState): BackgroundedCommand[] {
  const now = state.now();
  const due = [...state.commands].filter(([id, command]) => !command.taskId && state.openToolUses.has(id) && now - command.startedAt >= command.waitMs);
  if (due.length === 0) return [];
  readTranscript(state);
  const taken: BackgroundedCommand[] = [];
  for (const [id, command] of due) {
    const firstLine = command.command.trim().split("\n")[0];
    let index = state.announcedTasks.findIndex(task => task.description === command.command.trim());
    if (index < 0 && firstLine) index = state.announcedTasks.findIndex(task => task.description.split("\n")[0] === firstLine);
    if (index < 0 && due.length === 1 && state.announcedTasks.length === 1) index = 0;
    const task = index >= 0 ? state.announcedTasks.splice(index, 1)[0] : null;
    if (!task && now - command.startedAt < command.waitMs + ANNOUNCE_GRACE_MS) continue;
    command.taskId = task?.taskId ?? `${state.sessionId}/${id}`;
    taken.push({ toolCallId: id, taskId: command.taskId, command: command.command, startedAt: command.startedAt, logPath: task?.logPath ?? null });
  }
  return taken;
}

/** Background tasks of calls still open (to close them when the prompt ends). */
export function runningBackgroundTasks(state: GeminiStreamState): string[] {
  return [...state.commands.values()].flatMap(command => command.taskId ? [command.taskId] : []);
}

/** The CLI's error line: "\n⚠ <message>\n", alone in its chunk. */
const CLI_ERROR_RE = /^\n?⚠ ([^\n]+)\n?$/;

function streamText(state: GeminiStreamState, text: string): void {
  if (state.pendingThinking) flushPending(state);
  if (!state.pendingText) state.callbacks.onBlockStart?.("text");
  state.pendingText += text;
  state.callbacks.onText(text);
}

/** More output came after a held chunk: it was the agent's own text. */
function releaseHeldRefusal(state: GeminiStreamState): void {
  const held = state.heldRefusal;
  if (held === null) return;
  state.heldRefusal = null;
  streamText(state, held);
}

/**
 * The prompt ended: whether its last output was the plan's quota refusal, as
 * the error the usage-limit wait acts on (its reset parsed from the text).
 * The refusal never reaches the record.
 */
export function takeGeminiQuotaRefusal(state: GeminiStreamState): GeminiQuotaError | null {
  const held = state.heldRefusal;
  if (held === null) return null;
  state.heldRefusal = null;
  return geminiQuotaError(CLI_ERROR_RE.exec(held)![1].trim(), state.now());
}

/**
 * Keep what a refused prompt did. Its finished rounds are already committed;
 * text written before the refusal is committed as a round with a resume mark,
 * since the CLI's session holds it, so the turn continues that session once
 * the quota resets.
 */
export function commitRefusedRound(state: GeminiStreamState): void {
  commitInterruptedRound(state);
  commitRound(state);
}

/** Feed one session/update into the turn. */
export function pushGeminiUpdate(state: GeminiStreamState, update: Json): void {
  const cb = state.callbacks;
  state.lastUpdateAt = state.now();
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "tool_call" || kind === "tool_call_update") {
    const text = kind === "agent_message_chunk" ? str(asRecord(update.content)?.text) : undefined;
    const error = text ? CLI_ERROR_RE.exec(text) : null;
    if (error && isGeminiQuotaText(error[1])) {
      releaseHeldRefusal(state);
      state.heldRefusal = text!;
      cb.onActivity?.();
      return;
    }
    releaseHeldRefusal(state);
  }
  switch (kind) {
    case "agent_message_chunk": {
      const text = str(asRecord(update.content)?.text);
      if (!text) return;
      streamText(state, text);
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
    endCommand(state, id);
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
  readTranscript(state);
  const tokensBefore = state.outputTokens;
  if (usage) {
    state.outputTokens = num(usage.outputTokens) + num(usage.thoughtTokens);
    state.inputTokens = num(usage.inputTokens) + num(usage.cachedReadTokens);
    state.cachedInputTokens = num(usage.cachedReadTokens);
  }
  // The last model call: from the end of the last round's tools to the result.
  reportCallRates(state, Math.max(usage ? state.outputTokens : tokensBefore, tokensBefore) - state.committedOutputTokens, state.now());
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
