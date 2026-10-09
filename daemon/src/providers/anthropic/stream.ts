/**
 * Translate Claude Code SDK messages into Exocortex stream callbacks and a
 * StreamResult.
 *
 * Claude Code runs the whole agent loop (its own tools included), so one
 * Exocortex provider request spans many Anthropic API calls. Live deltas come
 * from `stream_event` partials; the canonical record comes from the complete
 * `assistant` / tool-result `user` messages, which are kept as a normal
 * tool_use → tool_result message sequence.
 *
 * Each tool round is handed to the agent loop (onProviderRound) as soon as its
 * last result arrives, so Exocortex persists it mid-turn like its own rounds.
 * The round's tool-result message carries the Claude Code resume point, so an
 * interrupted turn resumes the session after its last committed round.
 */

import { log } from "../../log";
import type { ApiContentBlock, ApiMessage } from "../../messages";
import { claudeCodeResultText, exocortexToolName, summarizeClaudeCodeTool } from "../../tools/claude-code";
import { AuthError } from "../errors";
import type { ContentBlock, ProviderRound, StreamCallbacks, StreamResult } from "../types";
import { REPLAYED_FIELD } from "./relay-protocol";
import type { AnthropicAssistantProviderData } from "./types";
import { CLAUDE_RATE_LIMIT_HEADER } from "./usage";

type SdkRecord = Record<string, unknown>;

export class ClaudeOverageError extends Error {}

export interface ClaudeStreamState {
  callbacks: StreamCallbacks;
  cwd: string;
  /** uuid of the prompt Exocortex sent; only the result answering it ends the turn. Null ends on any result. */
  promptUuid: string | null;
  /** uuids of queued input Claude Code took into the turn; a result answering one ends it too. */
  inputUuids: string[];
  /** Blocks and messages not yet committed as a round. */
  blocks: ContentBlock[];
  messages: ApiMessage[];
  toolNames: Map<string, string>;
  /** Titles of Claude Code's tasks and agents by id, shared with its process's later turns. */
  taskTitles: Map<string, string>;
  /** Descriptions of this turn's Agent calls by tool use id, to title the agents they start. */
  agentCalls: Map<string, string>;
  /** Tool calls of the current round still waiting for a result. */
  openToolUses: Set<string>;
  /** Output tokens already reported with committed rounds. */
  committedOutputTokens: number;
  now: () => number;
  /** When Claude Code last reported sending an API request. */
  requestedAt: number | null;
  /** When the main-thread API call now streaming was requested; null between calls. */
  callStartedAt: number | null;
  /** The call hit an API retry; like the agent loop's retried requests, it is not timed. */
  callRetried: boolean;
  sessionId: string | null;
  lastChainUuid: string | null;
  /** Context size of the latest API call (prompt incl. cache reads/writes). */
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheMissInputTokens?: number;
  outputTokens: number;
  /** Output tokens of the API call currently streaming. */
  currentCallOutputTokens: number;
  /** A thinking block opened but has not produced text yet (summaries can be empty). */
  thinkingStartPending: boolean;
  done: boolean;
  stopReason: string;
}

export function createClaudeStreamState(
  callbacks: StreamCallbacks,
  cwd: string,
  promptUuid: string | null = null,
  now: () => number = () => performance.now(),
): ClaudeStreamState {
  return {
    callbacks,
    cwd,
    promptUuid,
    inputUuids: [],
    blocks: [],
    messages: [],
    toolNames: new Map(),
    taskTitles: new Map(),
    agentCalls: new Map(),
    openToolUses: new Set(),
    committedOutputTokens: 0,
    now,
    requestedAt: null,
    callStartedAt: null,
    callRetried: false,
    sessionId: null,
    lastChainUuid: null,
    outputTokens: 0,
    currentCallOutputTokens: 0,
    thinkingStartPending: false,
    done: false,
    stopReason: "",
  };
}

function asRecord(value: unknown): SdkRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as SdkRecord : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((part) => {
      const record = asRecord(part);
      if (record?.type === "text") return str(record.text) ?? "";
      if (record?.type === "image") return "[image]";
      // ToolSearch answers with the tools it loaded.
      if (record?.type === "tool_reference" && str(record.tool_name)) return `Loaded ${record.tool_name}`;
      return JSON.stringify(part);
    })
    .join("\n");
}

/** Append to the canonical message list, merging consecutive same-role messages. */
function pushMessageContent(state: ClaudeStreamState, role: ApiMessage["role"], block: ApiContentBlock): void {
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === role && Array.isArray(last.content)) {
    last.content.push(block);
  } else {
    state.messages.push({ role, content: [block] });
  }
}

function handleStreamEvent(state: ClaudeStreamState, event: SdkRecord): void {
  const cb = state.callbacks;
  switch (event.type) {
    case "message_start": {
      const usage = asRecord(asRecord(event.message)?.usage);
      if (usage) {
        const fresh = num(usage.input_tokens);
        const cacheRead = num(usage.cache_read_input_tokens);
        const cacheWrite = num(usage.cache_creation_input_tokens);
        state.inputTokens = fresh + cacheRead + cacheWrite;
        state.cachedInputTokens = cacheRead;
        state.cacheMissInputTokens = fresh + cacheWrite;
      }
      state.currentCallOutputTokens = 0;
      state.callStartedAt = state.requestedAt ?? state.now();
      state.requestedAt = null;
      cb.onFirstResponseEvent?.();
      return;
    }
    case "content_block_start": {
      const type = asRecord(event.content_block)?.type;
      state.thinkingStartPending = type === "thinking";
      if (type === "text") cb.onBlockStart?.(type);
      else cb.onActivity?.();
      return;
    }
    case "content_block_delta": {
      const delta = asRecord(event.delta);
      if (delta?.type === "text_delta") {
        const text = str(delta.text);
        if (text) cb.onText(text);
      } else if (delta?.type === "thinking_delta") {
        const thinking = str(delta.thinking);
        if (!thinking) {
          cb.onActivity?.();
          return;
        }
        if (state.thinkingStartPending) {
          state.thinkingStartPending = false;
          cb.onBlockStart?.("thinking");
        }
        cb.onThinking(thinking);
      } else {
        cb.onActivity?.();
      }
      return;
    }
    case "message_delta": {
      const usage = asRecord(event.usage);
      if (usage && typeof usage.output_tokens === "number") {
        // message_delta carries the cumulative output count for this API call.
        state.outputTokens += usage.output_tokens - state.currentCallOutputTokens;
        state.currentCallOutputTokens = usage.output_tokens;
      }
      reportCallRate(state);
      return;
    }
    default:
      cb.onActivity?.();
  }
}

/**
 * Rate of the API call that just finished, timed like the agent loop times its
 * own requests: from sending it to its last token. Rounds cannot be timed
 * instead: Claude Code runs tools while the model is still generating, so a
 * round's tool results can arrive before its call ends.
 */
function reportCallRate(state: ClaudeStreamState): void {
  const startedAt = state.callStartedAt;
  const retried = state.callRetried;
  state.callStartedAt = null;
  state.callRetried = false;
  if (startedAt === null || retried || state.currentCallOutputTokens <= 0) return;
  const seconds = (state.now() - startedAt) / 1000;
  if (seconds > 0) state.callbacks.onGenerationRate?.(state.currentCallOutputTokens / seconds);
}

function handleAssistantMessage(state: ClaudeStreamState, message: SdkRecord): void {
  const content = asRecord(message.message)?.content;
  for (const raw of Array.isArray(content) ? content : []) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "text") {
      const text = str(block.text) ?? "";
      if (!text) continue;
      state.blocks.push({ type: "text", text });
      pushMessageContent(state, "assistant", { type: "text", text });
    } else if (block.type === "thinking") {
      const thinking = str(block.thinking) ?? "";
      const signature = str(block.signature) ?? "";
      if (signature) state.callbacks.onSignature?.(signature);
      if (!thinking) continue;
      state.blocks.push({ type: "thinking", text: thinking, signature });
      pushMessageContent(state, "assistant", { type: "thinking", thinking, signature });
    } else if (block.type === "tool_use") {
      const id = str(block.id) ?? "";
      const name = exocortexToolName(str(block.name) ?? "tool");
      const input = asRecord(block.input) ?? {};
      const { label, detail } = summarizeClaudeCodeTool(name, input, state.taskTitles);
      const summary = detail || label;
      // A task named only while its process remembers it keeps that name in history.
      const named = detail !== summarizeClaudeCodeTool(name, input).detail ? { presentation: { detail } } : {};
      state.toolNames.set(id, name);
      if ((name === "Agent" || name === "Task") && typeof input.description === "string") state.agentCalls.set(id, input.description);
      state.openToolUses.add(id);
      state.blocks.push({ type: "tool_call", id, name, input, summary, ...named });
      pushMessageContent(state, "assistant", { type: "tool_use", id, name, input, ...named });
      state.callbacks.onToolCall?.({ type: "tool_call", toolCallId: id, toolName: name, input, summary, ...named });
    }
  }
}

function resumePoint(state: ClaudeStreamState): AnthropicAssistantProviderData | undefined {
  if (!state.sessionId || !state.lastChainUuid) return undefined;
  return { anthropic: { sessionId: state.sessionId, resumeAt: state.lastChainUuid, cwd: state.cwd } };
}

/**
 * Hand the finished tool round to the agent loop and start the next one.
 * A round closed by an interruption gets no resume point: the session stops
 * mid-round there, so the next turn forks before it and reads it as history.
 */
function commitRound(state: ClaudeStreamState, resumable = true): void {
  const onProviderRound = state.callbacks.onProviderRound;
  if (!onProviderRound || state.messages.length === 0) return;
  const last = state.messages[state.messages.length - 1];
  const providerData = resumable ? resumePoint(state) : undefined;
  if (providerData) last.providerData = providerData;
  const round: ProviderRound = {
    blocks: state.blocks,
    messages: state.messages,
    outputTokens: state.outputTokens - state.committedOutputTokens,
    inputTokens: state.inputTokens,
  };
  state.blocks = [];
  state.messages = [];
  state.committedOutputTokens = state.outputTokens;
  onProviderRound(round);
}

/** Learn the title of the agent an Agent call started, so later calls addressing it can name it. */
function noteAgentTitle(state: ClaudeStreamState, toolUseId: string, toolUseResult: unknown): void {
  const description = state.agentCalls.get(toolUseId);
  if (description === undefined) return;
  state.agentCalls.delete(toolUseId);
  const agentId = str(asRecord(toolUseResult)?.agentId);
  if (agentId && description) state.taskTitles.set(agentId, description);
}

function handleUserMessage(state: ClaudeStreamState, message: SdkRecord): void {
  const content = asRecord(message.message)?.content;
  if (!Array.isArray(content)) return;
  let closedToolUse = false;
  for (const raw of content) {
    const block = asRecord(raw);
    if (block?.type !== "tool_result") continue;
    const toolUseId = str(block.tool_use_id) ?? "";
    closedToolUse = state.openToolUses.delete(toolUseId) || closedToolUse;
    const toolName = state.toolNames.get(toolUseId) ?? "";
    noteAgentTitle(state, toolUseId, message.tool_use_result);
    const output = claudeCodeResultText(toolName, toolResultText(block.content));
    const isError = block.is_error === true;
    state.blocks.push({ type: "tool_result", toolUseId, toolName, output, isError });
    pushMessageContent(state, "user", { type: "tool_result", tool_use_id: toolUseId, content: output, is_error: isError });
    state.callbacks.onToolResult?.({ type: "tool_result", toolCallId: toolUseId, toolName, output, isError });
  }
  if (closedToolUse && state.openToolUses.size === 0) commitRound(state);
}

/**
 * Claude Code took queued input into the turn here: at a tool boundary, or as
 * the turn it runs right after the result. Hand what came before it to the
 * agent loop as a round, so the input follows it, and go on to the result
 * that answers it.
 */
export function takeQueuedInput(state: ClaudeStreamState, uuid: string): void {
  if (state.openToolUses.size === 0) commitRound(state);
  state.inputUuids.push(uuid);
  state.done = false;
}

const INTERRUPTED_TOOL_OUTPUT = "Interrupted before this tool call finished.";

/**
 * Keep the tool calls of an interrupted turn that were still running (a
 * Bash command, a chrono sleep) instead of dropping them with the stream.
 */
export function commitInterruptedRound(state: ClaudeStreamState): void {
  if (state.openToolUses.size === 0) return;
  for (const toolUseId of state.openToolUses) {
    const toolName = state.toolNames.get(toolUseId) ?? "";
    state.blocks.push({ type: "tool_result", toolUseId, toolName, output: INTERRUPTED_TOOL_OUTPUT, isError: true });
    pushMessageContent(state, "user", { type: "tool_result", tool_use_id: toolUseId, content: INTERRUPTED_TOOL_OUTPUT, is_error: true });
    state.callbacks.onToolResult?.({ type: "tool_result", toolCallId: toolUseId, toolName, output: INTERRUPTED_TOOL_OUTPUT, isError: true });
  }
  state.openToolUses.clear();
  commitRound(state, false);
}

/**
 * Whether a result answers Exocortex's prompt. Claude Code also runs turns of
 * its own: for finished background tasks, and on resuming a session whose
 * process died with some running, a model-less report. A turn without a
 * prompt shows one of those and ends with its result.
 */
function answersPrompt(state: ClaudeStreamState, message: SdkRecord): boolean {
  if (!state.promptUuid) return true;
  const uuids = Array.isArray(message.user_message_uuids)
    ? message.user_message_uuids
    : typeof message.user_message_uuid === "string" ? [message.user_message_uuid] : [];
  if (uuids.length > 0) return uuids.some(uuid => uuid === state.promptUuid || state.inputUuids.includes(uuid));
  return asRecord(message.origin)?.kind !== "task-notification";
}

function handleRateLimit(state: ClaudeStreamState, info: SdkRecord): void {
  state.callbacks.onHeaders?.(new Headers({ [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify(info) }));
  // Exocortex only draws on the Claude subscription. Stop instead of running
  // a turn on paid extra usage.
  if (info.isUsingOverage === true || info.overageInUse === true) {
    throw new ClaudeOverageError("Claude Code started drawing on extra usage (overage) instead of the Claude subscription, so Exocortex stopped this turn. Wait for the subscription limit to reset.");
  }
}

function resultError(message: SdkRecord): Error {
  const errors = Array.isArray(message.errors) ? message.errors.filter((e): e is string => typeof e === "string") : [];
  const text = errors.join("\n") || str(message.result) || `Claude Code ended with ${str(message.subtype) ?? "an error"}`;
  if (/auth|login|401|oauth|credential/i.test(text)) {
    return new AuthError(`${text} Run \`claude auth login\` and try again.`);
  }
  return new Error(`Claude Code: ${text}`);
}

/** Feed one SDK message into the state. Throws on terminal errors. */
export function pushClaudeMessage(state: ClaudeStreamState, message: SdkRecord): void {
  pushMessage(state, message);
  // Replayed after a daemon restart, in a burst: the API calls it covers cannot be timed.
  if (message[REPLAYED_FIELD] === true) {
    state.requestedAt = null;
    state.callStartedAt = null;
  }
}

function pushMessage(state: ClaudeStreamState, message: SdkRecord): void {
  const sessionId = str(message.session_id);
  if (sessionId) state.sessionId = sessionId;

  // Subagent (Task tool) traffic: keep the watchdog alive, don't render it.
  if (message.parent_tool_use_id) {
    state.callbacks.onActivity?.();
    return;
  }

  switch (message.type) {
    case "stream_event": {
      const event = asRecord(message.event);
      if (event) handleStreamEvent(state, event);
      return;
    }
    case "assistant": {
      if (message.uuid) state.lastChainUuid = String(message.uuid);
      handleAssistantMessage(state, message);
      return;
    }
    case "user": {
      if (message.isReplay) return;
      if (message.uuid) state.lastChainUuid = String(message.uuid);
      handleUserMessage(state, message);
      return;
    }
    case "rate_limit_event": {
      const info = asRecord(message.rate_limit_info);
      if (info) handleRateLimit(state, info);
      return;
    }
    case "result": {
      if (!answersPrompt(state, message)) {
        log("info", `anthropic: skipping a Claude Code result that does not answer the prompt (origin=${str(asRecord(message.origin)?.kind) ?? "none"})`);
        state.callbacks.onActivity?.();
        return;
      }
      if (message.subtype !== "success" || message.is_error === true) throw resultError(message);
      state.done = true;
      state.stopReason = str(message.stop_reason) ?? "end_turn";
      return;
    }
    case "system": {
      if (message.subtype === "compact_boundary") log("info", "anthropic: Claude Code compacted its session context");
      // A request sent while a main-thread call streams is a subagent's.
      if (message.subtype === "status" && message.status === "requesting" && state.callStartedAt === null) state.requestedAt = state.now();
      if (message.subtype === "api_retry") state.callRetried = true;
      state.callbacks.onActivity?.();
      return;
    }
    default:
      state.callbacks.onActivity?.();
  }
}

export function finalizeClaudeStream(state: ClaudeStreamState): StreamResult {
  if (!state.done) throw new Error("Claude Code exited before finishing the turn.");
  const text = state.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n\n");
  const thinking = state.blocks.filter((b) => b.type === "thinking").map((b) => (b as { text: string }).text).join("\n\n");
  const lastMessage = state.messages[state.messages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") {
    // Keep the replay structurally valid: a turn must end on an assistant message.
    state.messages.push({ role: "assistant", content: [] });
  }
  const final = state.messages[state.messages.length - 1];
  const providerData = resumePoint(state);
  if (providerData) final.providerData = providerData;
  return {
    text,
    thinking,
    // Exocortex conventions: "stop" for a finished turn; tools already ran inside Claude Code.
    stopReason: state.stopReason === "max_tokens" ? "max_tokens" : "stop",
    blocks: state.blocks,
    toolCalls: [],
    transcriptMessages: state.messages,
    inputTokens: state.inputTokens,
    cachedInputTokens: state.cachedInputTokens,
    cacheMissInputTokens: state.cacheMissInputTokens,
    outputTokens: state.outputTokens,
    ...(final.providerData ? { assistantProviderData: final.providerData } : {}),
  };
}
