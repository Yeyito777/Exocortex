/**
 * Anthropic provider backed by Claude Code (via the Claude Agent SDK).
 *
 * Conversation turns run Claude Code as-is — its system prompt, built-in
 * tools, settings, CLAUDE.md, MCP servers and skills — in the conversation's
 * workspace, plus a few Exocortex host tools over MCP (see host-tools.ts) and
 * Exocortex's instructions appended to the system prompt.
 * Exocortex streams and records what Claude Code does.
 * One-shot helper requests (titles, summaries, compaction) run tool-free.
 *
 * Every request goes through the Claude Code CLI's claude.ai login, so usage
 * bills the Claude subscription; API-key environment overrides are stripped.
 */

import { randomUUID } from "node:crypto";
import { query, type Options as ClaudeQueryOptions, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAbortError } from "../../abort";
import { log } from "../../log";
import type { ApiMessage, EffortLevel, ModelId } from "../../messages";
import type { StreamCallbacks, StreamOptions, StreamResult } from "../types";
import { requireSubscriptionAuth } from "./auth";
import { claudeSubscriptionEnv, getClaudeBinary } from "./cli";
import { createHostToolServer } from "./host-tools";
import { buildClaudeHelperPrompt, buildClaudeUserContent, planClaudePrompt, type ClaudePromptPlan } from "./prompt";
import { commitInterruptedRound, createClaudeStreamState, finalizeClaudeStream, pushClaudeMessage, type ClaudeStreamState } from "./stream";

/** Claude Code tools that need an interactive answer Exocortex cannot give. */
const INTERACTIVE_ONLY_TOOLS = ["AskUserQuestion"];
/** Claude Code's own schedulers; Exocortex's chrono (a host tool) replaces them. */
const SCHEDULER_TOOLS = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList"];
const STDERR_TAIL_CHARS = 4000;
/**
 * Claude Code can sit inside one long tool call (a build, a test run) without
 * emitting messages. While its process is alive, keep the daemon's
 * stale-stream watchdog from treating that as a hung provider.
 */
const HEARTBEAT_INTERVAL_MS = 60_000;

type ClaudeEffort = NonNullable<ClaudeQueryOptions["effort"]>;

function toClaudeEffort(effort: EffortLevel | undefined): ClaudeEffort | undefined {
  switch (effort) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return effort;
    case "none":
    case "minimal":
      return "low";
    default:
      return undefined;
  }
}

function thinkingFor(effort: EffortLevel | undefined): ClaudeQueryOptions["thinking"] {
  return effort === "none" || effort === "minimal"
    ? { type: "disabled" }
    : { type: "adaptive", display: "summarized" };
}

/** Conversation turns carry Exocortex's tool surface; helper calls do not. */
function isAgentTurn(options: StreamOptions): boolean {
  return Array.isArray(options.tools) && options.tools.length > 0;
}

function baseOptions(model: ModelId, options: StreamOptions, cwd: string, stderr: (data: string) => void): ClaudeQueryOptions {
  const effort = toClaudeEffort(options.effort);
  return {
    model,
    cwd,
    pathToClaudeCodeExecutable: getClaudeBinary(),
    env: { ...claudeSubscriptionEnv(), CLAUDE_AGENT_SDK_CLIENT_APP: "exocortex-daemon" },
    includePartialMessages: true,
    thinking: thinkingFor(options.effort),
    ...(effort ? { effort } : {}),
    stderr,
  };
}

function agentTurnOptions(model: ModelId, options: StreamOptions, cwd: string, plan: ClaudePromptPlan, stderr: (data: string) => void): ClaudeQueryOptions {
  const hostTools = createHostToolServer(options.tools, options.toolExecutor, options.signal);
  return {
    ...baseOptions(model, options, cwd, stderr),
    // Behave like the `claude` CLI started in this directory, plus Exocortex's
    // additions (see buildClaudeCodeSystemAppend). Render it fresh every turn
    // rather than reusing the forked session's recorded prompt, so edited app
    // or conversation instructions apply on the next turn.
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(options.system ? { append: options.system } : {}),
      snapshot: false,
    },
    settingSources: ["user", "project", "local"],
    // Exocortex has no permission prompt UI; Claude Code runs unattended.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: [...INTERACTIVE_ONLY_TOOLS, ...SCHEDULER_TOOLS],
    ...(hostTools ? { mcpServers: { [hostTools.name]: hostTools } } : {}),
    ...(plan.resume ? { resume: plan.resume.sessionId, resumeSessionAt: plan.resume.resumeAt, forkSession: true } : {}),
  };
}

function helperOptions(model: ModelId, options: StreamOptions, cwd: string, stderr: (data: string) => void): ClaudeQueryOptions {
  return {
    ...baseOptions(model, options, cwd, stderr),
    ...(options.system ? { systemPrompt: options.system } : {}),
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    maxTurns: 1,
    persistSession: false,
  };
}

/** The turn's prompt, stamped with the uuid its result will carry. */
function singleUserMessage(content: SDKUserMessage["message"]["content"], uuid: string): AsyncIterable<SDKUserMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null } as SDKUserMessage;
    },
  };
}

function hasOutput(state: ClaudeStreamState): boolean {
  return state.blocks.length > 0 || state.outputTokens > 0;
}

async function runClaudeQuery(
  prompt: string | AsyncIterable<SDKUserMessage>,
  queryOptions: ClaudeQueryOptions,
  state: ClaudeStreamState,
  signal: AbortSignal | undefined,
  stderrTail: () => string,
): Promise<StreamResult> {
  const runtime = query({ prompt, options: queryOptions });
  const heartbeat = setInterval(() => state.callbacks.onActivity?.(), HEARTBEAT_INTERVAL_MS);
  const onAbort = () => {
    clearInterval(heartbeat);
    try { runtime.close(); } catch { /* best-effort */ }
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      throw createAbortError();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    for await (const message of runtime) {
      if (signal?.aborted) throw createAbortError();
      pushClaudeMessage(state, message as unknown as Record<string, unknown>);
      if (state.done) break;
    }
    if (signal?.aborted) throw createAbortError();
    return finalizeClaudeStream(state);
  } catch (error) {
    if (signal?.aborted) {
      commitInterruptedRound(state);
      throw createAbortError();
    }
    const tail = stderrTail().trim();
    if (tail && error instanceof Error && !error.message.includes(tail)) {
      log("warn", `anthropic: Claude Code stderr: ${tail}`);
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    onAbort();
  }
}

export async function streamMessage(
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const { signal } = options;
  await requireSubscriptionAuth(signal);

  let stderr = "";
  const onStderr = (data: string) => { stderr = (stderr + data).slice(-STDERR_TAIL_CHARS); };
  const cwd = options.workingDirectory ?? process.cwd();

  if (!isAgentTurn(options)) {
    log("info", `anthropic: Claude Code helper request (model=${model}, effort=${options.effort ?? "default"})`);
    const state = createClaudeStreamState(callbacks, cwd);
    return runClaudeQuery(buildClaudeHelperPrompt(messages), helperOptions(model, options, cwd, onStderr), state, signal, () => stderr);
  }

  const plan = planClaudePrompt(messages, cwd);
  log("info", `anthropic: Claude Code turn (model=${model}, effort=${options.effort ?? "default"}, cwd=${cwd}, resume=${plan.resume?.sessionId ?? "none"}, pending=${plan.pending.length})`);
  const promptUuid = randomUUID();
  const state = createClaudeStreamState(callbacks, cwd, promptUuid);
  try {
    return await runClaudeQuery(
      singleUserMessage(buildClaudeUserContent(plan.pending), promptUuid),
      agentTurnOptions(model, options, cwd, plan, onStderr),
      state,
      signal,
      () => stderr,
    );
  } catch (error) {
    // A missing/unforkable session (deleted, moved, or rejected) should not
    // strand the conversation: replay the whole history into a new session.
    if (!plan.resume || signal?.aborted || hasOutput(state)) throw error;
    log("warn", `anthropic: resuming Claude Code session ${plan.resume.sessionId} failed (${error instanceof Error ? error.message : error}); starting a new session`);
    const fresh: ClaudePromptPlan = { resume: null, pending: messages };
    stderr = "";
    const freshUuid = randomUUID();
    return runClaudeQuery(
      singleUserMessage(buildClaudeUserContent(fresh.pending), freshUuid),
      agentTurnOptions(model, options, cwd, fresh, onStderr),
      createClaudeStreamState(callbacks, cwd, freshUuid),
      signal,
      () => stderr,
    );
  }
}
