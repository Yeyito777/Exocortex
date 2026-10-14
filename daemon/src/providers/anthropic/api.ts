/**
 * Anthropic provider backed by Claude Code (via the Claude Agent SDK).
 *
 * Conversation turns run Claude Code as-is — its system prompt, built-in
 * tools, settings, CLAUDE.md, MCP servers and skills — in the conversation's
 * workspace, plus a few Exocortex host tools over MCP (see host-tools.ts) and
 * Exocortex's instructions appended to the system prompt.
 * Exocortex streams and records what Claude Code does. A process with
 * background tasks running outlives its turn (see session.ts), and through a
 * relay (relay.ts) the daemon too.
 * One-shot helper requests (titles, summaries, compaction) run tool-free.
 *
 * Every request goes through the Claude Code CLI's claude.ai login, so usage
 * bills the Claude subscription; API-key environment overrides are stripped.
 */

import { randomUUID } from "node:crypto";
import type { Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import { claudeSdks, loadClaudeSdks } from "./sdk";
import { classifyNetworkFailure } from "../errors";
import { createAbortError } from "../../abort";
import { log } from "../../log";
import type { ApiMessage, EffortLevel, ModelId } from "../../messages";
import type { StreamCallbacks, StreamOptions, StreamResult } from "../types";
import { requireSubscriptionAuth } from "./auth";
import { claudeProcessOptions } from "./cli";
import { AuthError } from "../errors";
import { MAIN_ACCOUNT_ID } from "./accounts";
import { beginAccountTurn, noteAccountAuthFailure, routeClaudeTurn, touchConversationAccount } from "./account-pool";
import { noteClaudeAccountWorking } from "./auth-cache";
import { accountSwitchNotice } from "./routing";
import { providerProxyRoute } from "../../provider-proxy/route";
import { createHostToolServer, hostToolDefs, type HostToolBinding } from "./host-tools";
import { buildClaudeHelperPrompt, buildClaudeUserContent, planClaudePrompt, trailingUserMessages, type ClaudePromptPlan } from "./prompt";
import { ClaudeRelay, reconnectRelays, relaysEnabled } from "./relay-client";
import type { RelayMeta } from "./relay-protocol";
import { claudeSessionKey, getClaudeCodeSession, HEARTBEAT_INTERVAL_MS, historyMark, openClaudeCodeSession } from "./session";
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

/** Behave like the `claude` CLI started in the workspace, plus Exocortex's additions (see buildClaudeCodeSystemAppend). */
function systemPromptOption(append: string | undefined): ClaudeQueryOptions["systemPrompt"] {
  // Rendered fresh for each process rather than reusing the forked session's
  // recorded prompt, so edited app or conversation instructions apply to the next one.
  return { type: "preset", preset: "claude_code", ...(append ? { append } : {}), snapshot: false };
}

function baseOptions(model: ModelId, options: StreamOptions, cwd: string, stderr: (data: string) => void, account: string): ClaudeQueryOptions {
  const effort = toClaudeEffort(options.effort);
  return {
    ...claudeProcessOptions(cwd, account),
    model,
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
  account: string,
): ClaudeQueryOptions {
  const hostTools = createHostToolServer(options.tools, options.toolExecutor ? binding : null);
  return {
    ...baseOptions(model, options, cwd, stderr, account),
    systemPrompt: systemPromptOption(options.system),
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

function helperOptions(model: ModelId, options: StreamOptions, cwd: string, stderr: (data: string) => void, account: string): ClaudeQueryOptions {
  return {
    ...baseOptions(model, options, cwd, stderr, account),
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
  const runtime = claudeSdks().claude.query({ prompt, options: queryOptions });
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

/** Callbacks that also count the account's rate-limit reports as proof that its login works. */
function accountCallbacks(callbacks: StreamCallbacks, account: string): StreamCallbacks {
  return {
    ...callbacks,
    onHeaders: (headers) => {
      noteClaudeAccountWorking(account);
      callbacks.onHeaders?.(headers);
    },
  };
}

function accountStreamState(callbacks: StreamCallbacks, cwd: string, account: string, promptUuid: string | null = null): ClaudeStreamState {
  const state = createClaudeStreamState(callbacks, cwd, promptUuid);
  state.account = account === MAIN_ACCOUNT_ID ? null : account;
  return state;
}

export async function streamMessage(
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const { signal } = options;
  const cwd = options.workingDirectory ?? process.cwd();
  const agentTurn = isAgentTurn(options);
  const plan = agentTurn ? planClaudePrompt(messages, cwd) : null;
  const convId = agentTurn ? options.tracking?.conversationId : undefined;
  const live = convId ? getClaudeCodeSession(convId) : undefined;

  // Which Claude account runs it (account-pool.ts, routing.ts).
  const route = await routeClaudeTurn(convId, live && !live.isClosed ? {
    account: live.account,
    open: true,
    backgroundWork: live.hasBackgroundWork,
  } : null, signal, plan?.resume ? plan.resume.account ?? MAIN_ACCOUNT_ID : null);
  const account = route.account;
  await requireSubscriptionAuth(signal, account);
  await loadClaudeSdks();
  if (route.movedFrom) {
    log("info", `anthropic: conversation ${convId ?? "?"} moves from Claude account ${route.movedFrom} to ${account} (${route.reason}: ${route.detail})`);
    callbacks.onProviderNotice?.(accountSwitchNotice(route));
  }
  const endTurn = beginAccountTurn(account);
  if (convId) touchConversationAccount(convId, account);
  callbacks = accountCallbacks(callbacks, account);
  try {
    return await runStreamMessage(messages, model, callbacks, options, cwd, plan, convId, live, account);
  } catch (error) {
    if (error instanceof AuthError && !signal?.aborted) noteAccountAuthFailure(account, error.message);
    throw error;
  } finally {
    endTurn();
    if (convId) touchConversationAccount(convId, account);
  }
}

async function runStreamMessage(
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions,
  cwd: string,
  agentPlan: ClaudePromptPlan | null,
  convId: string | undefined,
  live: ReturnType<typeof getClaudeCodeSession>,
  account: string,
): Promise<StreamResult> {
  const { signal } = options;
  let stderr = "";
  const onStderr = (data: string) => { stderr = (stderr + data).slice(-STDERR_TAIL_CHARS); };

  if (!agentPlan) {
    log("info", `anthropic: Claude Code helper request (model=${model}, effort=${options.effort ?? "default"}, account=${account})`);
    const state = accountStreamState(callbacks, cwd, account);
    return runClaudeQuery(buildClaudeHelperPrompt(messages), helperOptions(model, options, cwd, onStderr, account), state, signal, () => stderr);
  }

  const plan = agentPlan;
  const key = claudeSessionKey(model, options.effort, cwd, providerProxyRoute("anthropic")?.alias, account);

  // The conversation's Claude Code process is still running (background tasks,
  // or a quick follow-up): continue in it.
  const system = options.system ?? "";
  if (live?.canContinue(key, plan.resume, plan.pending, system)) {
    const input = live.planInput(plan.pending);
    log("info", `anthropic: Claude Code turn in its running process (model=${model}, effort=${options.effort ?? "default"}, cwd=${cwd}, account=${account}, session=${live.sessionId}, input=${input.kind})`);
    const state = accountStreamState(callbacks, cwd, account, input.kind === "prompt" ? randomUUID() : null);
    live.rememberAgentTitles(messages);
    if (input.kind === "none") {
      state.done = true;
      return finalizeClaudeStream(state);
    }
    try {
      return input.kind === "prompt"
        ? await live.run(state, input.content, options.toolExecutor, signal, input.messages, options.queuedInput)
        : await live.run(state, null, options.toolExecutor, signal, [], options.queuedInput);
    } catch (error) {
      if (!signal?.aborted) logStderr(error, stderr);
      throw error;
    }
  }
  // Other settings, a changed system prompt, another account, or a rewound history: the old process cannot continue.
  live?.close(live.key === key && !live.systemMatches(system)
    ? "its system prompt changed"
    : live.account !== account ? "the conversation moved to another Claude account" : "the conversation moved on from it");

  const start = (resumePlan: ClaudePromptPlan) => {
    const history = resumePlan.resume ? null : historyMark(resumePlan.pending);
    // A conversation's process runs under a relay, so it can outlive this daemon.
    const meta: RelayMeta | null = convId && relaysEnabled() ? {
      convId,
      key,
      cwd,
      hostTools: hostToolDefs(options.tools),
      ...(options.system ? { systemAppend: options.system } : {}),
      resume: resumePlan.resume ? { sessionId: resumePlan.resume.sessionId, resumeAt: resumePlan.resume.resumeAt } : null,
      history,
      ...(account !== MAIN_ACCOUNT_ID ? { account } : {}),
    } : null;
    const relay = meta ? new ClaudeRelay(onStderr) : null;
    const session = openClaudeCodeSession(convId, key, (input, binding) => claudeSdks().claude.query({
      prompt: input,
      options: {
        ...agentTurnOptions(model, options, cwd, resumePlan, onStderr, binding, account),
        ...(relay && meta ? { spawnClaudeCodeProcess: spawnOptions => relay.launch(spawnOptions, meta) } : {}),
      },
    }), { relay, resume: resumePlan.resume, history, system, account });
    session.rememberAgentTitles(messages);
    return session;
  };
  log("info", `anthropic: Claude Code turn (model=${model}, effort=${options.effort ?? "default"}, cwd=${cwd}, account=${account}, resume=${plan.resume?.sessionId ?? "none"}, pending=${plan.pending.length})`);
  const state = accountStreamState(callbacks, cwd, account, randomUUID());
  const session = start(plan);
  try {
    return await session.run(state, buildClaudeUserContent(plan.pending), options.toolExecutor, signal, trailingUserMessages(plan.pending), options.queuedInput);
  } catch (error) {
    if (!signal?.aborted) logStderr(error, stderr);
    // A missing/unforkable session (deleted, moved, or rejected) should not
    // strand the conversation: replay the whole history into a new session.
    // A network failure is not that: the same session resumes once the network is back.
    if (!plan.resume || signal?.aborted || hasOutput(state) || classifyNetworkFailure(error)) throw error;
    log("warn", `anthropic: resuming Claude Code session ${plan.resume.sessionId} failed (${error instanceof Error ? error.message : error}); starting a new session`);
    session.close("resuming its session failed");
    const fresh: ClaudePromptPlan = { resume: null, pending: messages };
    stderr = "";
    try {
      return await start(fresh).run(accountStreamState(callbacks, cwd, account, randomUUID()), buildClaudeUserContent(fresh.pending), options.toolExecutor, signal, trailingUserMessages(fresh.pending), options.queuedInput);
    } catch (freshError) {
      if (!signal?.aborted) logStderr(freshError, stderr);
      throw freshError;
    }
  }
}

/**
 * Take over the Claude Code processes an earlier daemon left running (see
 * relay.ts), so their turns and background tasks carry on in this one.
 * Returns the conversations whose process is running a turn no Exocortex turn
 * shows: replaying them shows it.
 */
export async function adoptClaudeCodeProcesses(hasConversation: (convId: string) => boolean): Promise<string[]> {
  if (!relaysEnabled()) return [];
  const pending: string[] = [];
  const relays = await reconnectRelays();
  if (relays.length > 0) await loadClaudeSdks();
  for (const relay of relays) {
    const hello = relay.hello!;
    const { meta } = hello;
    if (relay.exitCode !== null) continue;
    // Relays come newest first: an older one for the same conversation is stale.
    if (!hasConversation(meta.convId) || getClaudeCodeSession(meta.convId)) {
      log("info", `anthropic: stopping a Claude Code process left for ${meta.convId}, which ${hasConversation(meta.convId) ? "has a newer one" : "no longer exists"}`);
      void relay.terminate();
      continue;
    }
    openClaudeCodeSession(meta.convId, meta.key, (input, binding) => {
      const hostTools = createHostToolServer(meta.hostTools, binding);
      return claudeSdks().claude.query({
        prompt: input,
        // Claude Code is already running: only what the SDK re-sends when it
        // connects matters, and it matches what started the process.
        options: {
          ...claudeProcessOptions(meta.cwd, meta.account),
          systemPrompt: systemPromptOption(meta.systemAppend),
          perTaskStopAffordance: true,
          ...(hostTools ? { mcpServers: { [hostTools.name]: hostTools } } : {}),
          spawnClaudeCodeProcess: () => relay,
        },
      });
    }, { relay, system: meta.systemAppend ?? "", ...(meta.account ? { account: meta.account } : {}) });
    if (hello.pending) pending.push(meta.convId);
    log("info", `anthropic: adopted the Claude Code process for ${meta.convId} (relay pid ${hello.pid}${meta.account ? `, account ${meta.account}` : ""}${hello.pending ? ", turn running" : ""})`);
  }
  return pending;
}
