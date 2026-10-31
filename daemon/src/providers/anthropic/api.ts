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
 * The exception: while every subscription account is at a usage limit, or a
 * /proxy link is down, turns run on Claude API credits when the owner has
 * configured them (api-credits.ts), through the same Claude Code path.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "fs";
import { join } from "path";
import type { Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import { claudeCodeSafetyHooks } from "./safety-hooks";
import { claudeSdks, loadClaudeSdks } from "./sdk";
import { classifyNetworkFailure } from "../errors";
import { createAbortError } from "../../abort";
import { log } from "../../log";
import type { ApiMessage, EffortLevel, ModelId } from "../../messages";
import type { StreamCallbacks, StreamOptions, StreamResult } from "../types";
import { requireSubscriptionAuth } from "./auth";
import { claudeProcessOptions } from "./cli";
import { AuthError } from "../errors";
import { getClaudeAccount, MAIN_ACCOUNT_ID, mainClaudeConfigDir } from "./accounts";
import { CLAUDE_SESSION_ALIASES_FILE, claudeProjectDirName, claudeSessionAlias } from "./session-prune";
import { dataDir } from "@exocortex/shared/paths";
import { apiCreditSwitchNotice, beginAccountTurn, beginApiCreditTurn, multipleClaudeAccounts, noteAccountAuthFailure, routeClaudeTurn, touchConversationAccount, touchConversationCredit, type ClaudeTurnRoute } from "./account-pool";
import { ApiCreditExhaustedError, ApiCreditUsageMeter, classifyApiCreditError, noteApiCreditFailure, type ApiCreditKey } from "./api-credits";
import { isUsageLimitError } from "../../usage-limit-wait";
import { noteAccountUsageRefusal } from "./usage";
import { noteClaudeAccountWorking } from "./auth-cache";
import { accountSwitchNotice } from "./routing";
import { isProviderProxied, onProxiedClaudeApiCredits, onProxiedClaudeMove, providerProxyRoute } from "../../provider-proxy/route";
import { claudeProcessPrompt, createAppToolServer, createHostToolServer, hostToolDefs, type HostToolBinding } from "./host-tools";
import type { ClaudeCodeAppSurface } from "../types";
import { appToolCallView } from "../../app-tools";
import { ephemeralConversationsSurviveRestart, isEphemeralConversation } from "../../app-registry";
import type { ConversationRouteNotice } from "../../protocol";
import { buildClaudeHelperPrompt, buildClaudeUserContent, planClaudePrompt, trailingUserMessages, type ClaudePromptPlan } from "./prompt";
import { ClaudeRelay, reconnectRelays, relaysEnabled } from "./relay-client";
import type { RelayMeta } from "./relay-protocol";
import { claudeSessionKey, getClaudeCodeSession, HEARTBEAT_INTERVAL_MS, historyMark, openClaudeCodeSession } from "./session";
import { createClaudeStreamState, finalizeClaudeStream, pushClaudeMessage, type ClaudeStreamState } from "./stream";

/** Claude Code tools that need an interactive answer Exocortex cannot give. */
const INTERACTIVE_ONLY_TOOLS = ["AskUserQuestion"];
/** Claude Code's own schedulers; Exocortex's chrono (a host tool) replaces them. */
const SCHEDULER_TOOLS = ["ScheduleWakeup", "CronCreate", "CronDelete", "CronList"];
/** Claude Code's own subagent tool (`Task` is its legacy name); Exocortex delegates through exo. */
const SUBAGENT_TOOLS = ["Agent", "Task"];
const STDERR_TAIL_CHARS = 4000;
const APP_SESSION_TITLE = "Exocortex app conversation";

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

/** Conversation turns carry Exocortex's tool surface (an app conversation's may be empty); helper calls do not. */
function isAgentTurn(options: StreamOptions): boolean {
  return (Array.isArray(options.tools) && options.tools.length > 0) || options.claudeCodeApp !== undefined;
}

/**
 * What an app conversation (docs/app-api.md) changes about a Claude Code
 * process: on bases `none` and `agent` no filesystem settings (so no
 * CLAUDE.md, hooks or user settings), no auto-memory, skills, or MCP servers
 * but Exocortex's own, and only the selected built-in tools. Ordinary
 * conversations get exactly what they always did.
 */
function claudeCodeSurfaceOptions(system: string | undefined, app: ClaudeCodeAppSurface | undefined, env: ClaudeQueryOptions["env"]): Partial<ClaudeQueryOptions> {
  if (!app) return { systemPrompt: systemPromptOption(system), settingSources: ["user", "project", "local"] };
  // A session title of its own spares Claude Code a title-generating model call.
  const common = { title: APP_SESSION_TITLE, ...(app.tools ? { tools: app.tools } : {}) };
  if (app.base === "full") {
    return { systemPrompt: systemPromptOption(system), settingSources: ["user", "project", "local"], ...common };
  }
  return {
    ...common,
    systemPrompt: app.base === "none" ? system ?? "" : systemPromptOption(system),
    settingSources: [],
    strictMcpConfig: true,
    skills: [],
    env: {
      ...env,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    },
  };
}

/** The in-process MCP servers of a turn: Exocortex's host tools and, in an app conversation, the app's own tools. */
function mcpServerOptions(
  hostToolsList: unknown[] | undefined,
  app: Pick<ClaudeCodeAppSurface, "appTools"> | undefined,
  binding: (() => Promise<HostToolBinding>) | null,
): Pick<ClaudeQueryOptions, "mcpServers"> {
  const hostTools = createHostToolServer(hostToolsList, binding);
  const appTools = app ? createAppToolServer(app.appTools, binding) : null;
  if (!hostTools && !appTools) return {};
  return { mcpServers: { ...(hostTools ? { [hostTools.name]: hostTools } : {}), ...(appTools ? { [appTools.name]: appTools } : {}) } };
}

/** What a process is started with that a later turn may need changed; compared by fingerprint, never sent. */
function processPrompt(options: StreamOptions): string {
  const prompt = claudeProcessPrompt(options.system ?? "", hostToolDefs(options.tools));
  const app = options.claudeCodeApp;
  return app ? `${prompt}\u0000${JSON.stringify([app.base, app.tools ?? null, app.appTools])}` : prompt;
}

/** Behave like the `claude` CLI started in the workspace, plus Exocortex's additions (see buildClaudeCodeSystemAppend). */
function systemPromptOption(append: string | undefined): ClaudeQueryOptions["systemPrompt"] {
  // Rendered fresh for each process rather than reusing the forked session's
  // recorded prompt, so edited app or conversation instructions apply to the next one.
  return { type: "preset", preset: "claude_code", ...(append ? { append } : {}), snapshot: false };
}

function baseOptions(model: ModelId, options: StreamOptions, cwd: string, stderr: (data: string) => void, account: string, convId?: string, apiCredit: ApiCreditKey | null = null): ClaudeQueryOptions {
  const effort = toClaudeEffort(options.effort);
  return {
    ...claudeProcessOptions(cwd, account, convId, apiCredit),
    model,
    includePartialMessages: true,
    thinking: thinkingFor(options.effort),
    ...(effort ? { effort } : {}),
    stderr,
  };
}

export function agentTurnOptions(
  model: ModelId,
  options: StreamOptions,
  cwd: string,
  plan: ClaudePromptPlan,
  stderr: (data: string) => void,
  binding: () => Promise<HostToolBinding>,
  account: string,
  convId?: string,
  apiCredit: ApiCreditKey | null = null,
): ClaudeQueryOptions {
  const app = options.claudeCodeApp;
  const base = baseOptions(model, options, cwd, stderr, account, convId, apiCredit);
  return {
    ...base,
    ...claudeCodeSurfaceOptions(options.system, app, base.env),
    // Exocortex has no permission prompt UI; Claude Code runs unattended.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: [...INTERACTIVE_ONLY_TOOLS, ...SCHEDULER_TOOLS, ...SUBAGENT_TOOLS],
    // Permissions are bypassed, so the user's safety denylist is a hook.
    hooks: claudeCodeSafetyHooks(cwd),
    // Exocortex can stop each background task (its Tasks UI), so an interrupt
    // stops only the turn and spares them, as in Claude Code itself.
    perTaskStopAffordance: true,
    ...mcpServerOptions(options.tools, app, options.toolExecutor ? binding : null),
    // An ephemeral app conversation leaves no session files: its process stays instead.
    ...(app?.ephemeral ? { persistSession: false } : {}),
    ...(plan.resume ? { resume: plan.resume.sessionId, resumeSessionAt: plan.resume.resumeAt, forkSession: true } : {}),
  };
}

function helperOptions(model: ModelId, options: StreamOptions, cwd: string, stderr: (data: string) => void, account: string, apiCredit: ApiCreditKey | null): ClaudeQueryOptions {
  return {
    ...baseOptions(model, options, cwd, stderr, account, undefined, apiCredit),
    ...(options.system ? { systemPrompt: options.system } : {}),
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    maxTurns: 1,
    persistSession: false,
  };
}

/** When a resume point's session file was pruned, the kept session that holds the same point (session-prune.ts). */
export function prunedSessionAlias(resume: NonNullable<ClaudePromptPlan["resume"]>, account: string): string | null {
  // Under /proxy the local Claude Code runs in the main configuration directory.
  const configDir = isProviderProxied("anthropic") ? mainClaudeConfigDir() : getClaudeAccount(account)?.configDir ?? mainClaudeConfigDir();
  const dir = join(configDir, "projects", claudeProjectDirName(resume.cwd));
  if (existsSync(join(dir, `${resume.sessionId}.jsonl`))) return null;
  const alias = claudeSessionAlias(join(dataDir(), CLAUDE_SESSION_ALIASES_FILE), resume.sessionId);
  return alias && existsSync(join(dir, `${alias}.jsonl`)) ? alias : null;
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
  apiCredit: ApiCreditKey | null,
): Promise<StreamResult> {
  const runtime = claudeSdks().claude.query({ prompt, options: queryOptions });
  const meter = apiCredit ? new ApiCreditUsageMeter(apiCredit) : null;
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
      const record = message as unknown as Record<string, unknown>;
      if (meter && record.type === "stream_event") meter.observe(record.event, typeof record.parent_tool_use_id === "string" ? record.parent_tool_use_id : "main");
      pushClaudeMessage(state, record);
      if (state.done) break;
    }
    if (signal?.aborted) throw createAbortError();
    return finalizeClaudeStream(state);
  } catch (error) {
    if (signal?.aborted) throw createAbortError();
    logStderr(error, stderrTail());
    throw error;
  } finally {
    meter?.flushAll();
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

function accountStreamState(callbacks: StreamCallbacks, cwd: string, account: string, apiCredit: ApiCreditKey | null, promptUuid: string | null = null, appConvId?: string): ClaudeStreamState {
  const state = createClaudeStreamState(callbacks, cwd, promptUuid);
  state.account = account === MAIN_ACCOUNT_ID ? null : account;
  state.apiCredit = apiCredit !== null;
  if (appConvId) state.appToolCall = appToolCallView(appConvId);
  return state;
}

/** The structured twin of apiCreditSwitchNotice's text, for programs (docs/app-api.md). */
function creditRouteNotice(account: string, creditKey: string | null): ConversationRouteNotice {
  return creditKey ? { kind: "api_credits", account, creditKey } : { kind: "subscription", account };
}

/**
 * A turn's notices for moves onto or off API credits; returns their end.
 * Under /proxy (a turn on this machine's key aside: the link is down) the remote decides what bills each request, so only its reports
 * (forwarder.ts) say which, as they come: this daemon's route (always `main`)
 * knows nothing of the remote's limits, and announcing it would flip back and
 * forth every turn.
 */
export function creditSwitchNotices(convId: string | undefined, route: ClaudeTurnRoute, callbacks: Pick<StreamCallbacks, "onProviderNotice" | "onBilling">): () => void {
  if (!isProviderProxied("anthropic") || route.apiCredit) {
    const notice = apiCreditSwitchNotice(convId, route);
    if (notice) callbacks.onProviderNotice?.(notice, creditRouteNotice(route.account, route.apiCredit?.label ?? null));
    return () => {};
  }
  if (!convId) return () => {};
  let reported: string | null | undefined;
  return onProxiedClaudeApiCredits(convId, (label) => {
    if (reported === label) return;
    reported = label;
    if (label !== null) {
      log("info", `anthropic: proxied conversation ${convId} runs on the /proxy remote's API credits "${label}"`);
      callbacks.onBilling?.("api-credits");
    }
    const notice = apiCreditSwitchNotice(convId, { ...route, apiCredit: label === null ? null : { id: label, label, renewsOnDay: null } });
    if (notice) callbacks.onProviderNotice?.(notice, creditRouteNotice(route.account, label));
  });
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
    apiCredit: live.apiCredit,
  } : null, signal, plan?.resume ? plan.resume.account ?? MAIN_ACCOUNT_ID : null, options.tracking?.conversationId);
  const account = route.account;
  const apiCredit = route.apiCredit;
  // A turn on API credits does not use the account's login, only its configuration directory.
  if (!apiCredit) await requireSubscriptionAuth(signal, account);
  await loadClaudeSdks();
  if (apiCredit) {
    const moved = route.apiCreditMovedFrom ? ` moves from API-credit key "${route.apiCreditMovedFrom.label}" and` : "";
    log("info", `anthropic: ${convId ?? "a helper request"}${moved} runs on API credits "${apiCredit.label}" (${route.proxyDownAlias ? `/proxy ${route.proxyDownAlias} is down` : "every Claude subscription account is at a usage limit"}; key: ${route.apiCreditDetail ?? "?"}; configuration from account ${account})`);
  } else if (route.movedFrom) {
    log("info", `anthropic: conversation ${convId ?? "?"} moves from Claude account ${route.movedFrom} to ${account} (${route.reason}: ${route.detail})`);
    callbacks.onProviderNotice?.(accountSwitchNotice(route), { kind: "account", account, movedFrom: route.movedFrom });
  } else if (multipleClaudeAccounts()) {
    log("info", `anthropic: Claude account ${account} for ${convId ?? "a helper request"} (${route.reason}: ${route.detail})`);
  }
  const stopCreditNotes = creditSwitchNotices(convId, route, callbacks);
  if (apiCredit) callbacks.onBilling?.("api-credits");
  const endTurn = apiCredit ? beginApiCreditTurn(apiCredit) : beginAccountTurn(account, convId);
  if (convId && !apiCredit) touchConversationAccount(convId, account);
  if (!apiCredit) callbacks = accountCallbacks(callbacks, account);
  // Under /proxy the remote picks the account per request; announce its moves as for local ones.
  const proxied = isProviderProxied("anthropic") && !apiCredit;
  const stopMoveNotices = convId && proxied ? onProxiedClaudeMove(convId, (move) => {
    log("info", `anthropic: proxied conversation ${convId} moved from Claude account ${move.from} to ${move.to} on the /proxy remote (${move.detail})`);
    callbacks.onProviderNotice?.(accountSwitchNotice({ account: move.to, movedFrom: move.from, reason: "new", detail: move.detail }), { kind: "account", account: move.to, movedFrom: move.from });
  }) : null;
  try {
    return await runStreamMessage(messages, model, callbacks, options, cwd, plan, convId, live, account, apiCredit);
  } catch (error) {
    if (apiCredit) {
      // The key's refusal, never the subscription account's: out of credits, rejected, or rate-limited.
      const refusal = signal?.aborted ? null : noteApiCreditFailure(apiCredit, error);
      // Out of credits or rejected: the turn waits for the next key or a subscription, as at a usage limit.
      if ((refusal === "spent" || refusal === "rejected") && !(error instanceof ApiCreditExhaustedError)) {
        throw new ApiCreditExhaustedError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
    if (error instanceof AuthError && !signal?.aborted) noteAccountAuthFailure(account, error.message);
    if (!signal?.aborted && isUsageLimitError(error) && !proxied) noteAccountUsageRefusal(account, (error as Error).message);
    throw error;
  } finally {
    stopMoveNotices?.();
    stopCreditNotes();
    endTurn();
    if (convId && !apiCredit) touchConversationAccount(convId, account);
    // The turn's last request renews the key's cache: its warm window counts from here.
    if (convId && apiCredit) touchConversationCredit(convId, apiCredit.id);
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
  apiCredit: ApiCreditKey | null,
): Promise<StreamResult> {
  const { signal } = options;
  let stderr = "";
  const onStderr = (data: string) => { stderr = (stderr + data).slice(-STDERR_TAIL_CHARS); };

  if (!agentPlan) {
    log("info", `anthropic: Claude Code helper request (model=${model}, effort=${options.effort ?? "default"}, account=${account}${apiCredit ? `, api-credits=${apiCredit.label}` : ""})`);
    const state = accountStreamState(callbacks, cwd, account, apiCredit);
    return runClaudeQuery(buildClaudeHelperPrompt(messages), helperOptions(model, options, cwd, onStderr, account, apiCredit), state, signal, () => stderr, apiCredit);
  }

  const plan = agentPlan;
  const key = claudeSessionKey(model, options.effort, cwd, apiCredit ? null : providerProxyRoute("anthropic")?.alias, account, apiCredit?.id);

  // The conversation's Claude Code process is still running (background tasks,
  // or a quick follow-up): continue in it.
  // A process takes its system prompt and the MCP tools' text when it starts: either changing starts a new one.
  const system = processPrompt(options);
  const app = options.claudeCodeApp;
  const appConvId = app ? convId : undefined;
  if (live?.canContinue(key, plan.resume, plan.pending, system)) {
    const input = live.planInput(plan.pending);
    log("info", `anthropic: Claude Code turn in its running process (model=${model}, effort=${options.effort ?? "default"}, cwd=${cwd}, account=${account}${apiCredit ? `, api-credits=${apiCredit.label}` : ""}, session=${live.sessionId}, input=${input.kind})`);
    const state = accountStreamState(callbacks, cwd, account, apiCredit, input.kind === "prompt" ? randomUUID() : null, appConvId);
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
    ? "its system prompt or tool text changed"
    : live.account !== account ? "the conversation moved to another Claude account"
    : (live.apiCredit?.id ?? null) !== (apiCredit?.id ?? null) ? "the conversation moved between the subscription and API credits"
    : "the conversation moved on from it");

  const start = (resumePlan: ClaudePromptPlan) => {
    const history = resumePlan.resume ? null : historyMark(resumePlan.pending);
    // A pruned session resumes from the kept file holding the same point (session-prune.ts).
    const resumeFrom = resumePlan.resume ? prunedSessionAlias(resumePlan.resume, account) : null;
    if (resumeFrom && resumePlan.resume) log("info", `anthropic: Claude Code session ${resumePlan.resume.sessionId} was pruned; resuming ${resumeFrom}, which holds the same point`);
    const processPlan: ClaudePromptPlan = resumeFrom && resumePlan.resume ? { ...resumePlan, resume: { ...resumePlan.resume, sessionId: resumeFrom } } : resumePlan;
    // A conversation's process runs under a relay, so it can outlive this daemon. An
    // ephemeral app conversation's does only while restarts hand those over (app-api.ts).
    const meta: RelayMeta | null = convId && relaysEnabled() && (!app?.ephemeral || ephemeralConversationsSurviveRestart()) ? {
      convId,
      key,
      cwd,
      hostTools: hostToolDefs(options.tools),
      ...(options.system ? { systemAppend: options.system } : {}),
      ...(app ? { app: { base: app.base, ...(app.tools ? { tools: app.tools } : {}), appTools: app.appTools } } : {}),
      resume: resumePlan.resume ? { sessionId: resumePlan.resume.sessionId, resumeAt: resumePlan.resume.resumeAt } : null,
      history,
      ...(account !== MAIN_ACCOUNT_ID ? { account } : {}),
      ...(apiCredit ? { apiCredit: { id: apiCredit.id, label: apiCredit.label, renewsOnDay: apiCredit.renewsOnDay } } : {}),
    } : null;
    const relay = meta ? new ClaudeRelay(onStderr) : null;
    const session = openClaudeCodeSession(convId, key, (input, binding) => claudeSdks().claude.query({
      prompt: input,
      options: {
        ...agentTurnOptions(model, options, cwd, processPlan, onStderr, binding, account, convId, apiCredit),
        ...(relay && meta ? { spawnClaudeCodeProcess: spawnOptions => relay.launch(spawnOptions, meta) } : {}),
      },
    }), { relay, resume: resumePlan.resume, history, system, account, apiCredit, ...(app?.ephemeral ? { keepAlive: true } : {}) });
    session.rememberAgentTitles(messages);
    return session;
  };
  // An ephemeral app conversation's sessions live only in its process (persistSession: false):
  // a new process starts from the whole history instead of a session file that was never written.
  const startPlan: ClaudePromptPlan = app?.ephemeral && agentPlan.resume ? { resume: null, pending: messages } : agentPlan;
  log("info", `anthropic: Claude Code turn (model=${model}, effort=${options.effort ?? "default"}, cwd=${cwd}, account=${account}${apiCredit ? `, api-credits=${apiCredit.label}` : ""}, resume=${startPlan.resume?.sessionId ?? "none"}, pending=${startPlan.pending.length})`);
  const state = accountStreamState(callbacks, cwd, account, apiCredit, randomUUID(), appConvId);
  const session = start(startPlan);
  try {
    return await session.run(state, buildClaudeUserContent(plan.pending), options.toolExecutor, signal, trailingUserMessages(plan.pending), options.queuedInput);
  } catch (error) {
    if (!signal?.aborted) logStderr(error, stderr);
    // A missing/unforkable session (deleted, moved, or rejected) should not
    // strand the conversation: replay the whole history into a new session.
    // A network failure is not that: the same session resumes once the network is back.
    if (!startPlan.resume || signal?.aborted || hasOutput(state) || classifyNetworkFailure(error) || isUsageLimitError(error)) throw error;
    if (apiCredit && classifyApiCreditError(error)) throw error;
    log("warn", `anthropic: resuming Claude Code session ${startPlan.resume.sessionId} failed (${error instanceof Error ? error.message : error}); starting a new session`);
    session.close("resuming its session failed");
    const fresh: ClaudePromptPlan = { resume: null, pending: messages };
    stderr = "";
    try {
      return await start(fresh).run(accountStreamState(callbacks, cwd, account, apiCredit, randomUUID(), appConvId), buildClaudeUserContent(fresh.pending), options.toolExecutor, signal, trailingUserMessages(fresh.pending), options.queuedInput);
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
      const app = meta.app ? { ...meta.app, ephemeral: false } : undefined;
      const processOptions = claudeProcessOptions(meta.cwd, meta.account, meta.convId, meta.apiCredit ?? null);
      return claudeSdks().claude.query({
        prompt: input,
        // Claude Code is already running: only what the SDK re-sends when it
        // connects matters, and it matches what started the process.
        options: {
          ...processOptions,
          ...(app ? claudeCodeSurfaceOptions(meta.systemAppend, app, processOptions.env) : { systemPrompt: systemPromptOption(meta.systemAppend) }),
          perTaskStopAffordance: true,
          // Same hooks as at start, so the process's registered callback ids still resolve.
          hooks: claudeCodeSafetyHooks(meta.cwd),
          ...mcpServerOptions(meta.hostTools, app, binding),
          spawnClaudeCodeProcess: () => relay,
        },
      });
    }, {
      relay,
      // An ephemeral app conversation's process holds its only copy of the session.
      ...(isEphemeralConversation(meta.convId) ? { keepAlive: true } : {}),
      system: meta.app
        ? `${claudeProcessPrompt(meta.systemAppend ?? "", meta.hostTools)}\u0000${JSON.stringify([meta.app.base, meta.app.tools ?? null, meta.app.appTools])}`
        : claudeProcessPrompt(meta.systemAppend ?? "", meta.hostTools),
      ...(meta.account ? { account: meta.account } : {}),
      ...(meta.apiCredit ? { apiCredit: meta.apiCredit } : {}),
    });
    if (hello.pending) pending.push(meta.convId);
    log("info", `anthropic: adopted the Claude Code process for ${meta.convId} (relay pid ${hello.pid}${meta.account ? `, account ${meta.account}` : ""}${hello.pending ? ", turn running" : ""})`);
  }
  return pending;
}
