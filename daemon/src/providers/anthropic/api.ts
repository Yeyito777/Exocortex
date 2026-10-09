/**
 * Anthropic provider backed by Claude Code (via the Claude Agent SDK).
 *
 * Conversation turns run Claude Code as-is — its system prompt, built-in
 * tools, settings, CLAUDE.md, MCP servers and skills — in the conversation's
 * workspace, plus a few Exocortex host tools over MCP (see host-tools.ts) and
 * Exocortex's instructions appended to the system prompt.
 * Exocortex streams and records what Claude Code does. A process with
 * background tasks running outlives its turn (see session.ts).
 * One-shot helper requests (titles, summaries, compaction) run tool-free.
 *
 * Every request goes through the Claude Code CLI's claude.ai login, so usage
 * bills the Claude subscription; API-key environment overrides are stripped.
 */

import { randomUUID } from "node:crypto";
import { query, type Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import { createAbortError } from "../../abort";
import { log } from "../../log";
import type { ApiMessage, EffortLevel, ModelId } from "../../messages";
import type { StreamCallbacks, StreamOptions, StreamResult } from "../types";
import { requireSubscriptionAuth } from "./auth";
import { claudeSubscriptionEnv, getClaudeBinary } from "./cli";
import { createHostToolServer, type HostToolBinding } from "./host-tools";
import { buildClaudeHelperPrompt, buildClaudeUserContent, planClaudePrompt, type ClaudePromptPlan } from "./prompt";
import { claudeSessionKey, getClaudeCodeSession, HEARTBEAT_INTERVAL_MS, openClaudeCodeSession } from "./session";
import { createClaudeStreamState, finalizeClaudeStream, pushClaudeMessage, type ClaudeStreamState } from "./stream";

/** Claude Code tools that need an interactive answer Exocortex cannot give. */
const INTERACTIVE_ONLY_TOOLS = ["AskUserQuestion"];
/** Claude Code's own schedulers; Exocortex's chrono (a host tool) replaces them. */
const SCHEDULER_TOOLS = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList"];
const STDERR_TAIL_CHARS = 4000;

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

function agentTurnOptions(
  model: ModelId,
  options: StreamOptions,
  cwd: string,
  plan: ClaudePromptPlan,
  stderr: (data: string) => void,
  binding: () => Promise<HostToolBinding>,
): ClaudeQueryOptions {
  const hostTools = createHostToolServer(options.tools, options.toolExecutor ? binding : null);
  return {
    ...baseOptions(model, options, cwd, stderr),
    // Behave like the `claude` CLI started in this directory, plus Exocortex's
    // additions (see buildClaudeCodeSystemAppend). Render it fresh for each
    // process rather than reusing the forked session's recorded prompt, so
    // edited app or conversation instructions apply to the next one.
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
    // Exocortex can stop each background task (its Tasks UI), so an interrupt
    // stops only the turn and spares them, as in Claude Code itself.
    perTaskStopAffordance: true,
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

function hasOutput(state: ClaudeStreamState): boolean {
  return state.blocks.length > 0 || state.outputTokens > 0;
}

function logStderr(error: unknown, stderr: string): void {
  const tail = stderr.trim();
  if (tail && error instanceof Error && !error.message.includes(tail)) {
    log("warn", `anthropic: Claude Code stderr: ${tail}`);
  }
}

/** One-shot helper request: a single prompt, no tools, no session. */
async function runClaudeQuery(
  prompt: string,
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
    if (signal?.aborted) throw createAbortError();
    logStderr(error, stderrTail());
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
  const convId = options.tracking?.conversationId;
  const key = claudeSessionKey(model, options.effort, cwd);

  // The conversation's Claude Code process is still running (background tasks,
  // or a quick follow-up): continue in it.
  const live = convId ? getClaudeCodeSession(convId) : undefined;
  if (live?.canContinue(key, plan.resume)) {
    const input = live.planInput(plan.pending);
    log("info", `anthropic: Claude Code turn in its running process (model=${model}, effort=${options.effort ?? "default"}, cwd=${cwd}, session=${live.sessionId}, input=${input.kind})`);
    const state = createClaudeStreamState(callbacks, cwd, input.kind === "prompt" ? randomUUID() : null);
    if (input.kind === "none") {
      state.done = true;
      return finalizeClaudeStream(state);
    }
    try {
      return await live.run(state, input.kind === "prompt" ? input.content : null, options.toolExecutor, signal);
    } catch (error) {
      if (!signal?.aborted) logStderr(error, stderr);
      throw error;
    }
  }
  // Other settings or a rewound history: the old process cannot continue.
  live?.close("the conversation moved on from it");

  const start = (resumePlan: ClaudePromptPlan) => openClaudeCodeSession(convId, key, (input, binding) => query({
    prompt: input,
    options: agentTurnOptions(model, options, cwd, resumePlan, onStderr, binding),
  }));
  log("info", `anthropic: Claude Code turn (model=${model}, effort=${options.effort ?? "default"}, cwd=${cwd}, resume=${plan.resume?.sessionId ?? "none"}, pending=${plan.pending.length})`);
  const state = createClaudeStreamState(callbacks, cwd, randomUUID());
  const session = start(plan);
  try {
    return await session.run(state, buildClaudeUserContent(plan.pending), options.toolExecutor, signal);
  } catch (error) {
    if (!signal?.aborted) logStderr(error, stderr);
    // A missing/unforkable session (deleted, moved, or rejected) should not
    // strand the conversation: replay the whole history into a new session.
    if (!plan.resume || signal?.aborted || hasOutput(state)) throw error;
    log("warn", `anthropic: resuming Claude Code session ${plan.resume.sessionId} failed (${error instanceof Error ? error.message : error}); starting a new session`);
    session.close("resuming its session failed");
    const fresh: ClaudePromptPlan = { resume: null, pending: messages };
    stderr = "";
    try {
      return await start(fresh).run(createClaudeStreamState(callbacks, cwd, randomUUID()), buildClaudeUserContent(fresh.pending), options.toolExecutor, signal);
    } catch (freshError) {
      if (!signal?.aborted) logStderr(freshError, stderr);
      throw freshError;
    }
  }
}
