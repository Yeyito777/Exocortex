/**
 * The app API (docs/app-api.md): programs use the user's daemon as a
 * dependency through their own conversations.
 *
 * This module owns what is particular to app conversations: validating their
 * create fields, their owners (the connection that receives their app tool
 * calls), awaited turn results, lifetimes (a temporary one expires, an
 * ephemeral one ends with its owner) and ending them for good, removing only
 * what the daemon created. Turns themselves run through the ordinary
 * orchestrator.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  APP_API_VERSION,
  APP_DEFAULT_IDLE_TTL_MS,
  APP_DEFAULT_RECONNECT_GRACE_MS,
  APP_LIFETIMES,
  APP_MAX_IDLE_TTL_MS,
  APP_MAX_RECONNECT_GRACE_MS,
  APP_MAX_SYSTEM_TEXT_BYTES,
  APP_OWNER_WAIT_MS,
  APP_ROUTE_CREDITS,
  APP_ROUTE_WHEN_LIMITED,
  APP_SESSION_PATTERN,
  APP_SYSTEM_BASES,
  APPS_FOLDER_NAME,
  isAppName,
  type AppConversationInfo,
  type AppLifetime,
  type AppRouteSpec,
  type AppSystemBase,
  type AppToolDef,
} from "@exocortex/shared/app-api";
import { readExocortexConfig } from "@exocortex/shared/config";
import { worktreeName } from "@exocortex/shared/paths";
import type { AttachAppConversationCommand, ClientCapabilitiesCommand, EndAppSessionCommand, Event, ListAppConversationsCommand, TurnResultEvent } from "./protocol";
import type { ConnectedClient, DaemonServer } from "./server";
import type { Block, ProviderId, ModelId, StoredMessage } from "./messages";
import * as convStore from "./conversations";
import {
  appConversationExpiresAt,
  ephemeralConversationsSurviveRestart,
  getAppRecord,
  isAppConversation,
  isHiddenConversation,
  listAppRecords,
  flushAppRegistry,
  registerAppConversation,
  removeAppConversationRecord,
  setAppRoute,
  setAppTools,
  setEphemeralConversationsSurviveRestart,
  setLastTurnResult,
  touchAppConversation,
  type AppConversationRecord,
} from "./app-registry";
import { appToolBroker, appToolFor, resolveAppBuiltinTools, validateAppToolDefs } from "./app-tools";
import { createEphemeralWorkspace, daemonCreatedAppWorkspace, ephemeralWorkspaceRoot, removeAppWorkspace, removeClaudeProjectDir, removeClaudeSessionFiles, sweepEphemeralLeftovers } from "./app-workspaces";
import { onAssistantTurnEnded, onLiveTurnRebased, type AssistantTurnEnd } from "./conversation-lifecycle";
import { getDaemonShutdownMode } from "./daemon-lifecycle";
import { setConversationToolResolver } from "./tools/registry";
import { getModelInfo } from "./providers/registry";
import { getClaudeCodeSession } from "./providers/anthropic/session";
import { conversationOnApiCredits, forgetConversationAccount, getConversationAccount, touchConversationAccount } from "./providers/anthropic/account-pool";
import type { AnthropicAssistantProviderData } from "./providers/anthropic/types";
import { log } from "./log";

// ── Create fields ──────────────────────────────────────────────────

/** The app fields of a new_conversation or app_run, validated. */
export interface AppCreateSpec {
  app: string;
  lifetime: AppLifetime;
  idleTtlMs?: number;
  system: { text: string; base: AppSystemBase };
  cwd?: string;
  builtin: string[] | "all";
  appTools: AppToolDef[];
  route?: AppRouteSpec;
}

interface AppCreateFields {
  app?: unknown;
  lifetime?: unknown;
  idleTtlMs?: unknown;
  system?: unknown;
  cwd?: unknown;
  tools?: unknown;
  route?: unknown;
}

const APP_ONLY_FIELDS = ["lifetime", "idleTtlMs", "system", "cwd", "tools", "route"] as const;

/** An app conversation's `route` preferences, validated; undefined when it asks for nothing but the defaults. */
export function parseAppRoute(value: unknown): AppRouteSpec | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("route must be an object");
  const { credits, whenLimited } = value as { credits?: unknown; whenLimited?: unknown };
  if (credits !== undefined && !APP_ROUTE_CREDITS.includes(credits as never)) throw new Error(`route.credits must be one of ${APP_ROUTE_CREDITS.join(", ")}`);
  if (whenLimited !== undefined && !APP_ROUTE_WHEN_LIMITED.includes(whenLimited as never)) throw new Error(`route.whenLimited must be one of ${APP_ROUTE_WHEN_LIMITED.join(", ")}`);
  const route: AppRouteSpec = {
    ...(credits === "never" ? { credits: "never" as const } : {}),
    ...(whenLimited === "error" ? { whenLimited: "error" as const } : {}),
  };
  return Object.keys(route).length > 0 ? route : undefined;
}

/**
 * Validate a create request's app fields. Null for an ordinary conversation
 * (no app named, none declared by the connection); throws naming the problem.
 */
export function parseAppCreate(cmd: AppCreateFields, client: Pick<ConnectedClient, "app">, defaultLifetime: AppLifetime = "saved"): AppCreateSpec | null {
  const declared = client.app?.name;
  if (cmd.app !== undefined && !isAppName(cmd.app)) throw new Error("app must match ^[a-z0-9][a-z0-9-]{0,39}$");
  if (cmd.app !== undefined && declared && cmd.app !== declared) throw new Error(`This connection is app ${declared}, not ${String(cmd.app)}`);
  const app = (cmd.app as string | undefined) ?? declared;
  if (!app) {
    const field = APP_ONLY_FIELDS.find(name => cmd[name] !== undefined);
    if (field) throw new Error(`${field} is only for app conversations: name the app (app, or client_capabilities.app)`);
    return null;
  }

  const lifetime = cmd.lifetime ?? defaultLifetime;
  if (!APP_LIFETIMES.includes(lifetime as AppLifetime)) throw new Error(`lifetime must be one of ${APP_LIFETIMES.join(", ")}`);
  let idleTtlMs: number | undefined;
  if (cmd.idleTtlMs !== undefined) {
    if (lifetime !== "temporary") throw new Error("idleTtlMs is only for temporary conversations");
    if (!Number.isSafeInteger(cmd.idleTtlMs) || (cmd.idleTtlMs as number) <= 0 || (cmd.idleTtlMs as number) > APP_MAX_IDLE_TTL_MS) {
      throw new Error(`idleTtlMs must be a positive number of milliseconds up to ${APP_MAX_IDLE_TTL_MS}`);
    }
    idleTtlMs = cmd.idleTtlMs as number;
  } else if (lifetime === "temporary") {
    idleTtlMs = APP_DEFAULT_IDLE_TTL_MS;
  }

  const system = cmd.system ?? {};
  if (typeof system !== "object" || system === null || Array.isArray(system)) throw new Error("system must be an object");
  const { text = "", base = "none" } = system as { text?: unknown; base?: unknown };
  if (typeof text !== "string") throw new Error("system.text must be a string");
  if (Buffer.byteLength(text) > APP_MAX_SYSTEM_TEXT_BYTES) throw new Error(`system.text is larger than ${APP_MAX_SYSTEM_TEXT_BYTES} bytes`);
  if (!APP_SYSTEM_BASES.includes(base as AppSystemBase)) throw new Error(`system.base must be one of ${APP_SYSTEM_BASES.join(", ")}`);

  let cwd: string | undefined;
  if (cmd.cwd !== undefined) {
    if (typeof cmd.cwd !== "string" || !isAbsolute(cmd.cwd)) throw new Error("cwd must be an absolute path");
    let isDirectory = false;
    try { isDirectory = statSync(cmd.cwd).isDirectory(); } catch { /* missing */ }
    if (!isDirectory) throw new Error(`cwd ${cmd.cwd} is not an existing directory`);
    cwd = resolve(cmd.cwd);
  }

  const route = parseAppRoute(cmd.route);
  const tools = cmd.tools ?? {};
  if (typeof tools !== "object" || tools === null || Array.isArray(tools)) throw new Error("tools must be an object");
  const { builtin = [], app: appTools } = tools as { builtin?: unknown; app?: unknown };
  if (builtin !== "all" && !(Array.isArray(builtin) && builtin.every(name => typeof name === "string"))) {
    throw new Error('tools.builtin must be an array of tool names or "all"');
  }
  return {
    app,
    lifetime: lifetime as AppLifetime,
    ...(idleTtlMs !== undefined ? { idleTtlMs } : {}),
    system: { text, base: base as AppSystemBase },
    ...(cwd ? { cwd } : {}),
    builtin: builtin === "all" ? "all" : [...new Set(builtin as string[])],
    appTools: validateAppToolDefs(appTools),
    ...(route ? { route } : {}),
  };
}

/** Check the tools against the provider and model the conversation will use. */
export function checkAppToolsForModel(spec: AppCreateSpec, provider: ProviderId, model: ModelId): void {
  const builtin = resolveAppBuiltinTools(spec.builtin, provider, { ephemeral: spec.lifetime === "ephemeral" });
  const anyTools = builtin.exocortexTools.length > 0 || (builtin.claudeCodeTools?.length ?? 0) > 0 || spec.builtin === "all" || spec.appTools.length > 0;
  if (anyTools && getModelInfo(provider, model)?.supportsTools === false) {
    throw new Error(`${provider}/${model} cannot use tools; choose another model or no tools`);
  }
}

/** Record a new app conversation, before it is created. Returns its record. */
export function registerAppCreate(convId: string, spec: AppCreateSpec, now = Date.now()): AppConversationRecord {
  const record: AppConversationRecord = {
    convId,
    app: spec.app,
    lifetime: spec.lifetime,
    createdAt: now,
    lastActivityAt: now,
    ...(spec.idleTtlMs !== undefined ? { idleTtlMs: spec.idleTtlMs } : {}),
    system: spec.system,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    ...(spec.lifetime === "ephemeral" && !spec.cwd ? { ephemeralWorkspace: createEphemeralWorkspace(convId) } : {}),
    builtin: spec.builtin,
    appTools: spec.appTools,
    ...(spec.route ? { route: spec.route } : {}),
  };
  registerAppConversation(record);
  return record;
}

/** Undo registerAppCreate when creating the conversation failed. */
export function abandonAppCreate(convId: string): void {
  const record = getAppRecord(convId);
  if (!record) return;
  removeAppConversationRecord(convId);
  removeAppWorkspace(record);
}

/** The sidebar folder of a saved app conversation: `apps/<app>/`, created (apps muted) when missing. */
export function ensureAppFolder(app: string): string {
  const apps = convStore.ensureTopLevelFolder(APPS_FOLDER_NAME, { mutedOnCreate: true });
  const folder = apps ? convStore.ensureChildFolder(apps.id, app) : null;
  if (!folder) throw new Error(`Failed to create the ${APPS_FOLDER_NAME}/${app} folder`);
  return folder.id;
}

/** An app conversation's title when the app gives none: the first line of its first prompt. */
export function appTitleFromPrompt(text: string): string {
  const line = text.split("\n").find(candidate => candidate.trim())?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

// ── Sessions and owners ─────────────────────────────────────────────

/**
 * What owns app conversations: an app client's session, not its socket. A
 * client that reconnects (a dropped connection, a daemon restart) with its
 * session token takes its conversations back. While a session is away its
 * ephemeral conversations wait `graceMs` for it, then end; turn results and
 * endings meanwhile are kept and sent when it is back.
 */
interface AppSession {
  id: string;
  app: string;
  client: ConnectedClient | null;
  graceMs: number;
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** When it lost its connection (or this daemon took it over from the one before). */
  disconnectedAt: number | null;
  /** Events of its conversations while it was away: turn_result and conversation_deleted. */
  pending: Event[];
  /** For a connection that declared no app (e.g. the exo CLI attaching): no grace, never handed over. */
  anonymous: boolean;
}

const sessions = new Map<string, AppSession>();
const clientSessions = new WeakMap<ConnectedClient, AppSession>();
const owners = new Map<string, AppSession>();
interface PendingAwait { client: ConnectedClient; reqId: string | undefined; turnId: string }
const awaits = new Map<string, PendingAwait[]>();
/** Each app conversation's latest turn's blocks (memory only; lastTurnResult keeps none), for a send again answered from it. */
const lastTurnBlocks = new Map<string, { turnId: string; blocks: Block[] }>();
let server: DaemonServer | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let stopTurnListener: (() => void) | null = null;
let stopRebaseListener: (() => void) | null = null;
let shuttingDown = false;
let graceOverrideMs: number | null = null;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_PENDING_EVENTS = 64;

function defaultGraceMs(): number {
  if (graceOverrideMs !== null) return graceOverrideMs;
  const configured = readExocortexConfig().appApi?.reconnectGraceMs;
  return Number.isSafeInteger(configured) && (configured as number) >= 0
    ? Math.min(configured as number, APP_MAX_RECONNECT_GRACE_MS)
    : APP_DEFAULT_RECONNECT_GRACE_MS;
}

function newSession(id: string, app: string, graceMs: number, anonymous: boolean): AppSession {
  const session: AppSession = { id, app, client: null, graceMs, graceTimer: null, disconnectedAt: null, pending: [], anonymous };
  sessions.set(id, session);
  return session;
}

/** The session a connection owns conversations through: its app session, else one made for it. */
function sessionOf(client: ConnectedClient): AppSession {
  const known = clientSessions.get(client);
  if (known && sessions.get(known.id) === known) return known;
  const session = newSession(`anon-${client.id}-${randomBytes(6).toString("hex")}`, client.app?.name ?? "", 0, true);
  session.client = client;
  clientSessions.set(client, session);
  return session;
}

function ownedBy(session: AppSession): string[] {
  const ids: string[] = [];
  for (const [convId, owner] of owners) if (owner === session) ids.push(convId);
  return ids;
}

function connectedClient(session: AppSession | undefined): ConnectedClient | null {
  const client = session?.client;
  return client && !client.socket.destroyed ? client : null;
}

export function appConversationOwner(convId: string): ConnectedClient | null {
  return connectedClient(owners.get(convId));
}

/** How long a call to an app tool of `convId` waits for an owner: a minute, or what is left of its session's grace. */
function ownerWaitMs(convId: string, base: number): number {
  const session = owners.get(convId);
  if (!session || session.client || session.disconnectedAt === null) return base;
  return Math.max(base, session.graceMs - (Date.now() - session.disconnectedAt));
}

/** Make `client` the owner: it gets the conversation's events (caught up with a running turn) and app tool calls. */
export function setAppConversationOwner(convId: string, client: ConnectedClient): void {
  owners.set(convId, sessionOf(client));
  server?.subscribe(client, convId);
  sendTurnCatchup(client, convId);
  appToolBroker.ownerAttached(convId);
}

function catchesUp(client: ConnectedClient): boolean {
  return client.capabilities?.has("turn-catchup") === true;
}

/**
 * A running turn as it has streamed so far, to an app client that asked for
 * catch-ups. Sent in the same tick as its subscription (or the event that
 * rebased the stream), so the stream events after it are exactly the newer ones.
 */
function sendTurnCatchup(client: ConnectedClient, convId: string): void {
  if (!server || !catchesUp(client)) return;
  const catchup = convStore.getTurnCatchup(convId);
  if (catchup) server.sendTo(client, { type: "turn_catchup", ...catchup });
}

/** A turn_result keeps the turn's blocks only for a client that asked for catch-ups. */
function eventFor(client: ConnectedClient, event: Event): Event {
  if (event.type !== "turn_result" || !event.blocks || catchesUp(client)) return event;
  const { blocks: _blocks, ...rest } = event;
  return rest;
}

function deliverPending(session: AppSession): void {
  const client = connectedClient(session);
  if (!client) return;
  for (const event of session.pending.splice(0)) server?.sendTo(client, eventFor(client, event));
}

/** Send an event to a conversation's owner, or keep it for the owner's session while it is away. */
function sendToOwnerSession(convId: string, event: Event, except?: ConnectedClient): void {
  const session = owners.get(convId);
  if (!session) return;
  const client = connectedClient(session);
  // While a restart's turns settle the connections are going away: kept for the next daemon.
  if (client && server) {
    if (client !== except) server.sendTo(client, eventFor(client, event));
    return;
  }
  if (session.anonymous) return;
  session.pending.push(event);
  if (session.pending.length > MAX_PENDING_EVENTS) session.pending.splice(0, session.pending.length - MAX_PENDING_EVENTS);
}

/** A connection takes a session (new, or back after a drop or a restart). */
function connectSession(session: AppSession, client: ConnectedClient): void {
  if (session.graceTimer) clearTimeout(session.graceTimer);
  session.graceTimer = null;
  session.disconnectedAt = null;
  const previous = session.client;
  if (previous && previous !== client && !previous.socket.destroyed) {
    log("info", `app-api: ${client.id} takes over the session of ${session.app} from ${previous.id}`);
    clientSessions.delete(previous);
  }
  session.client = client;
  clientSessions.set(client, session);
  for (const convId of ownedBy(session)) {
    server?.subscribe(client, convId);
    appToolBroker.ownerAttached(convId);
  }
}

/** A session's running turns, to its connection: after its welcome and what it missed, in the tick it subscribed. */
function catchUpSession(session: AppSession): void {
  const client = connectedClient(session);
  if (client) for (const convId of ownedBy(session)) sendTurnCatchup(client, convId);
}

/** A session lost its connection: its ephemeral conversations wait out its grace. */
function disconnectSession(session: AppSession, now = Date.now()): void {
  session.client = null;
  session.disconnectedAt = now;
  const owned = ownedBy(session);
  for (const convId of owned) appToolBroker.ownerDetached(convId);
  if (owned.length === 0 && session.pending.length === 0) {
    sessions.delete(session.id);
    return;
  }
  armGrace(session);
}

function armGrace(session: AppSession): void {
  if (session.graceTimer) clearTimeout(session.graceTimer);
  session.graceTimer = null;
  const remaining = session.graceMs - (Date.now() - (session.disconnectedAt ?? Date.now()));
  if (remaining <= 0) {
    void expireSession(session);
    return;
  }
  session.graceTimer = setTimeout(() => { void expireSession(session); }, remaining);
  session.graceTimer.unref?.();
}

/** A session is over: its ephemeral conversations end, the rest just lose their owner. Returns those that ended. */
async function releaseSession(session: AppSession, requester?: { client: ConnectedClient }): Promise<string[]> {
  sessions.delete(session.id);
  if (session.graceTimer) clearTimeout(session.graceTimer);
  session.graceTimer = null;
  const ended: string[] = [];
  for (const convId of ownedBy(session)) {
    owners.delete(convId);
    if (getAppRecord(convId)?.lifetime !== "ephemeral") {
      appToolBroker.ownerDetached(convId);
      continue;
    }
    try {
      if (await endAppConversation(convId, "owner_disconnected", requester)) ended.push(convId);
    } catch (error) {
      log("error", `app-api: ending ${convId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return ended;
}

/** A session did not come back in time. */
async function expireSession(session: AppSession): Promise<void> {
  session.graceTimer = null;
  if (session.client || sessions.get(session.id) !== session) return;
  const owned = ownedBy(session).length;
  const ended = await releaseSession(session);
  if (!session.anonymous && owned > 0) {
    log("info", `app-api: a session of ${session.app} did not reconnect within ${session.graceMs} ms${ended.length ? `; ended ${ended.length} ephemeral conversation(s)` : ""}`);
  }
}

// ── Awaits and turn results ─────────────────────────────────────────

/** A send that waits for its turn's end; answered by onTurnEnded. */
export function registerTurnAwait(client: ConnectedClient, reqId: string | undefined, convId: string, turnId: string): void {
  const list = awaits.get(convId) ?? [];
  list.push({ client, reqId, turnId });
  awaits.set(convId, list);
}

/** Forget an await whose turn never ran (refused before it started). */
export function dropTurnAwait(client: ConnectedClient, reqId: string | undefined, convId: string, turnId: string): void {
  const list = awaits.get(convId);
  if (!list) return;
  const rest = list.filter(entry => !(entry.client === client && entry.reqId === reqId && entry.turnId === turnId));
  if (rest.length > 0) awaits.set(convId, rest);
  else awaits.delete(convId);
}

/** The final assistant message's text: text after the last tool round. */
export function finalAssistantText(blocks: AssistantTurnEnd["blocks"]): string {
  let texts: string[] = [];
  for (const block of blocks) {
    if (block.type === "tool_call" || block.type === "tool_result") texts = [];
    else if (block.type === "text" && block.text) texts.push(block.text);
  }
  return texts.join("\n\n");
}

export function buildTurnResult(end: AssistantTurnEnd): TurnResultEvent {
  const stopReason = end.aborted ? "aborted" : end.ok ? "end_turn" : "error";
  return {
    type: "turn_result",
    convId: end.convId,
    turnId: String(end.promptStartedAt ?? ""),
    text: finalAssistantText(end.blocks),
    stopReason,
    ...(stopReason === "error" && end.error ? { error: end.error } : {}),
    usage: { outputTokens: end.tokens, durationMs: end.durationMs },
    ...(end.billing ? { billing: end.billing } : {}),
    ...(end.limited ? { limited: end.limited } : {}),
  };
}

/**
 * Every assistant turn's end: answer the sends that awaited it and, for an app
 * conversation, tell its owner (or keep it for the owner's session) and keep
 * the result for one attaching later. A turn that only paused (a Chrono
 * sleep) or that a daemon restart will replay is not over.
 */
function onTurnEnded(end: AssistantTurnEnd): void {
  if (end.manualCompaction || end.suspended || (end.aborted && end.daemonRestart)) return;
  const result = buildTurnResult(end);
  // The whole turn, for clients that follow its stream; never kept in lastTurnResult.
  const withBlocks: TurnResultEvent = end.turnBlocks ? { ...result, blocks: [...end.turnBlocks] } : result;
  const list = awaits.get(end.convId) ?? [];
  const waiting = list.filter(entry => entry.turnId === result.turnId);
  if (waiting.length > 0) {
    const rest = list.filter(entry => entry.turnId !== result.turnId);
    if (rest.length > 0) awaits.set(end.convId, rest);
    else awaits.delete(end.convId);
  }
  for (const entry of waiting) {
    if (!entry.client.socket.destroyed) server?.sendTo(entry.client, { ...eventFor(entry.client, withBlocks), ...(entry.reqId ? { reqId: entry.reqId } : {}) });
  }
  const record = getAppRecord(end.convId);
  if (!record) return;
  touchAppConversation(end.convId);
  setLastTurnResult(end.convId, result);
  if (withBlocks.blocks) lastTurnBlocks.set(end.convId, { turnId: result.turnId, blocks: withBlocks.blocks });
  const owner = appConversationOwner(end.convId);
  if (!owner || !waiting.some(entry => entry.client === owner)) sendToOwnerSession(end.convId, withBlocks);
  // An app_run's ephemeral conversation ends with its turn, also one a restart replayed.
  if (record.endAfterTurn && !shuttingDown) void finishAppRun(end.convId);
}

/** A turn's result again, for a send repeated after its turn ended: with its blocks for a client that follows streams. */
export function repeatedTurnResult(client: ConnectedClient, last: TurnResultEvent): TurnResultEvent {
  const known = lastTurnBlocks.get(last.convId);
  return known?.turnId === last.turnId && catchesUp(client) ? { ...last, blocks: known.blocks } : last;
}

/** The end of an app_run whose ephemeral conversation is not kept. */
export async function finishAppRun(convId: string): Promise<void> {
  // A graceful restart hands it over instead: the next daemon ends it after the replayed turn.
  if (shuttingDown) return;
  try {
    await endAppConversation(convId, "run_finished");
  } catch (error) {
    log("error", `app-api: ending ${convId} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── Reporting ───────────────────────────────────────────────────────

export function appConversationInfo(record: AppConversationRecord): AppConversationInfo {
  const summary = convStore.getIndexedSummary(record.convId);
  const expiresAt = appConversationExpiresAt(record);
  const workspace = daemonCreatedAppWorkspace(record);
  const account = summary?.provider === "anthropic" ? getConversationAccount(record.convId)?.account : undefined;
  return {
    convId: record.convId,
    app: record.app,
    lifetime: record.lifetime,
    title: summary?.title ?? "",
    provider: summary?.provider ?? "",
    model: summary?.model ?? "",
    ...(summary?.effort ? { effort: summary.effort } : {}),
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    ...(expiresAt !== undefined ? { expiresAt, idleTtlMs: record.idleTtlMs } : {}),
    ownerConnected: appConversationOwner(record.convId) !== null,
    streaming: convStore.isStreaming(record.convId),
    ...(record.cwd ? { cwd: record.cwd } : {}),
    ...(workspace ? { workspace } : {}),
    systemBase: record.system.base,
    builtinTools: record.builtin === "all" ? "all" : [...record.builtin],
    appTools: record.appTools.map(tool => tool.name),
    ...(record.route ? { route: { ...record.route } } : {}),
    ...(account ? { account } : {}),
    ...(conversationOnApiCredits(record.convId) ? { billing: "api-credits" as const } : {}),
  };
}

export function welcomeAppClient(client: ConnectedClient, cmd: ClientCapabilitiesCommand): void {
  const app = cmd.app as { name?: unknown; version?: unknown; session?: unknown; reconnectGraceMs?: unknown } | null | undefined;
  const fail = (message: string) => server?.sendTo(client, { type: "error", reqId: cmd.reqId, message });
  if (!app || typeof app !== "object" || !isAppName(app.name)) return void fail("app.name must match ^[a-z0-9][a-z0-9-]{0,39}$");
  if (app.session !== undefined && (typeof app.session !== "string" || !APP_SESSION_PATTERN.test(app.session))) {
    return void fail("app.session must match ^[A-Za-z0-9_-]{16,128}$ (the session app_welcome gave you)");
  }
  if (app.reconnectGraceMs !== undefined
      && (!Number.isSafeInteger(app.reconnectGraceMs) || (app.reconnectGraceMs as number) < 0 || (app.reconnectGraceMs as number) > APP_MAX_RECONNECT_GRACE_MS)) {
    return void fail(`app.reconnectGraceMs must be a whole number of milliseconds from 0 to ${APP_MAX_RECONNECT_GRACE_MS}`);
  }
  const name = app.name;
  let session = typeof app.session === "string" ? sessions.get(app.session) : undefined;
  if (session && session.app !== name) return void fail(`Session belongs to app ${session.app}`);
  const resumed = session !== undefined;
  session ??= newSession(typeof app.session === "string" ? app.session : randomBytes(18).toString("base64url"), name, 0, false);
  session.graceMs = typeof app.reconnectGraceMs === "number" ? app.reconnectGraceMs : defaultGraceMs();
  // A connection that declares itself again leaves the session it had.
  const earlier = clientSessions.get(client);
  if (earlier && earlier !== session && earlier.client === client) disconnectSession(earlier);
  client.app = { name, ...(typeof app.version === "string" ? { version: app.version.slice(0, 100) } : {}) };
  connectSession(session, client);
  server?.sendTo(client, {
    type: "app_welcome",
    ...(cmd.reqId ? { reqId: cmd.reqId } : {}),
    appApiVersion: APP_API_VERSION,
    app: name,
    instance: worktreeName() ?? "main",
    pid: process.pid,
    session: session.id,
    reconnectGraceMs: session.graceMs,
    resumed,
    conversations: ownedBy(session),
    ...(catchesUp(client) ? { turnCatchup: true } : {}),
  });
  // What ended while it was away, after the welcome; then where its running turns are.
  deliverPending(session);
  catchUpSession(session);
  log("info", `app-api: ${client.id} is app ${name}${client.app.version ? ` ${client.app.version}` : ""}${resumed ? ` (session resumed, ${ownedBy(session).length} conversation(s))` : ""}`);
}

/** end_app_session: the client is done; its ephemeral conversations end now. */
export async function endAppSession(client: ConnectedClient, cmd: EndAppSessionCommand): Promise<void> {
  const session = clientSessions.get(client);
  let ended: string[] = [];
  if (session && sessions.get(session.id) === session) {
    clientSessions.delete(client);
    ended = await releaseSession(session, { client });
  }
  server?.sendTo(client, { type: "app_session_ended", ...(cmd.reqId ? { reqId: cmd.reqId } : {}), ended });
}

export function listAppConversations(client: ConnectedClient, cmd: ListAppConversationsCommand): void {
  const conversations = listAppRecords()
    .filter(record => (!cmd.app || record.app === cmd.app) && (cmd.includeSaved === true || record.lifetime !== "saved"))
    .filter(record => convStore.hasConversation(record.convId))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map(appConversationInfo);
  server?.sendTo(client, { type: "app_conversations_list", reqId: cmd.reqId, conversations });
}

/** attach_app_conversation: become the owner, optionally replacing the app tools and route. */
export function attachAppConversation(client: ConnectedClient, cmd: AttachAppConversationCommand): void {
  const record = getAppRecord(cmd.convId);
  const fail = (message: string) => server?.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message });
  if (!record || !convStore.hasConversation(cmd.convId)) return void fail(`App conversation ${cmd.convId} not found`);
  if (client.app && client.app.name !== record.app) return void fail(`Conversation ${cmd.convId} belongs to app ${record.app}`);
  const owner = owners.get(cmd.convId);
  if (record.lifetime === "ephemeral" && owner && owner !== clientSessions.get(client) && (owner.client || !owner.anonymous)) {
    return void fail("An ephemeral conversation belongs to the session that created it");
  }
  let tools: AppToolDef[] | undefined;
  let route: AppRouteSpec | undefined;
  try {
    if (cmd.tools?.app !== undefined) tools = validateAppToolDefs(cmd.tools.app);
    if (cmd.route !== undefined) route = parseAppRoute(cmd.route);
  } catch (error) {
    return void fail(error instanceof Error ? error.message : String(error));
  }
  if (tools) setAppTools(cmd.convId, tools);
  if (cmd.route !== undefined) setAppRoute(cmd.convId, route);
  touchAppConversation(cmd.convId);
  setAppConversationOwner(cmd.convId, client);
  server?.sendTo(client, {
    type: "app_conversation_attached",
    reqId: cmd.reqId,
    convId: cmd.convId,
    conversation: appConversationInfo(record),
    ...(record.lastTurnResult ? { lastTurnResult: record.lastTurnResult } : {}),
  });
}

// ── Startup: app commands wait for recovery ─────────────────────────

let ready = true;
const held: (() => void)[] = [];
/** What an app client may send before startup recovery is done. */
const BEFORE_READY = new Set(["client_capabilities", "ping", "app_tool_result"]);

/**
 * An app client's command while the daemon is still starting (conversations
 * loading, interrupted turns not yet replayed) waits until it is done, so an
 * attach right after a restart sees the replayed turn running rather than a
 * conversation that seems idle or missing. True when held.
 */
export function holdAppCommandUntilReady(client: ConnectedClient, type: string, run: () => void): boolean {
  if (ready || !client.app || BEFORE_READY.has(type)) return false;
  held.push(run);
  return true;
}

/** Startup recovery is done: run what app clients sent meanwhile, in order. */
export function markAppApiReady(): void {
  if (ready) return;
  ready = true;
  const runs = held.splice(0);
  if (runs.length > 0) log("info", `app-api: running ${runs.length} app command(s) held during startup`);
  for (const run of runs) run();
}

// ── Ending ──────────────────────────────────────────────────────────

export type AppConversationEndReason = "deleted" | "expired" | "owner_disconnected" | "run_finished";

/** Claude Code sessions of a conversation's turns, from their resume points. */
function claudeSessions(messages: readonly (StoredMessage | undefined)[]): { sessionId: string; cwd?: string }[] {
  const sessions = new Map<string, string | undefined>();
  for (const message of messages) {
    const data = (message?.providerData as Partial<AnthropicAssistantProviderData> | undefined)?.anthropic;
    if (data?.sessionId) sessions.set(data.sessionId, data.cwd);
  }
  return [...sessions].map(([sessionId, cwd]) => ({ sessionId, ...(cwd ? { cwd } : {}) }));
}

/**
 * End an app conversation for good: its unanswered app tool calls, its turn,
 * its Claude Code process and session files, its stored history, and the
 * working directory the daemon created for it (never an app cwd).
 */
export async function endAppConversation(convId: string, reason: AppConversationEndReason, requester?: { client: ConnectedClient; reqId?: string }): Promise<boolean> {
  const record = getAppRecord(convId);
  if (!record) return false;
  let messages: readonly (StoredMessage | undefined)[] = [];
  try {
    messages = (await convStore.getAsync(convId))?.messages ?? [];
  } catch (error) {
    log("warn", `app-api: could not read ${convId} before deleting it: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (getAppRecord(convId) !== record) return false;
  appToolBroker.conversationEnded(convId);
  const live = getClaudeCodeSession(convId);
  const claude = claudeSessions(messages);
  if (live?.sessionId) claude.push({ sessionId: live.sessionId, ...(record.cwd ? { cwd: record.cwd } : {}) });
  live?.close(`its app conversation ended (${reason})`);
  const existed = convStore.purge(convId) || !convStore.hasConversation(convId);
  // The daemon's own working directory is the Claude Code project of its sessions alone.
  const workspace = daemonCreatedAppWorkspace(record);
  removeClaudeSessionFiles(claude);
  if (workspace) removeClaudeProjectDir(workspace);
  removeAppWorkspace(record);
  const event = { type: "conversation_deleted" as const, convId, reason };
  // An owner away (reconnecting) hears of it when it is back.
  if (!appConversationOwner(convId)) sendToOwnerSession(convId, event);
  if (requester) {
    server?.sendTo(requester.client, { ...event, ...(requester.reqId ? { reqId: requester.reqId } : {}) });
    if (typeof server?.broadcastExcept === "function") server.broadcastExcept(event, requester.client);
  } else {
    server?.broadcast(event);
  }
  // Pending awaits of a turn that will never end.
  for (const entry of awaits.get(convId) ?? []) {
    if (!entry.client.socket.destroyed) {
      server?.sendTo(entry.client, { type: "turn_result", convId, turnId: entry.turnId, text: "", stopReason: "aborted", ...(entry.reqId ? { reqId: entry.reqId } : {}) });
    }
  }
  awaits.delete(convId);
  owners.delete(convId);
  lastTurnBlocks.delete(convId);
  forgetConversationAccount(convId);
  removeAppConversationRecord(convId);
  log("info", `app-api: ended ${record.lifetime} conversation ${convId} of ${record.app} (${reason})`);
  return existed;
}

function onClientClosed(client: ConnectedClient): void {
  if (shuttingDown) return;
  for (const [convId, list] of awaits) {
    const rest = list.filter(entry => entry.client !== client);
    if (rest.length > 0) awaits.set(convId, rest);
    else awaits.delete(convId);
  }
  const session = clientSessions.get(client);
  clientSessions.delete(client);
  if (!session || session.client !== client || sessions.get(session.id) !== session) return;
  disconnectSession(session);
}

/** Delete temporary conversations past their idle time (never one that is running). */
export async function sweepExpiredAppConversations(now = Date.now()): Promise<string[]> {
  const expired: string[] = [];
  for (const record of listAppRecords()) {
    const expiresAt = appConversationExpiresAt(record);
    if (expiresAt === undefined || expiresAt > now) continue;
    if (convStore.isStreaming(record.convId) || appToolBroker.pendingCount(record.convId) > 0) continue;
    if (await endAppConversation(record.convId, "expired")) expired.push(record.convId);
  }
  return expired;
}

// ── Graceful restarts: the next daemon takes over ───────────────────

/**
 * At a graceful restart, the next daemon takes the app sessions (their
 * conversations, grace and undelivered events) and the ephemeral
 * conversations themselves: their records and what the stores keep of them
 * only in memory (convStore.ephemeralConversationState: history, queued
 * messages, pending instructions; and their Claude account), in a file only
 * the user can read in the instance's temporary directory, which the next
 * daemon reads and deletes as it starts. Everything else is the ordinary
 * restart: their Claude Code processes carry on under their relays, an
 * interrupted turn is replayed from the same interrupted-streams list as any
 * other, and queued messages and pending instructions are delivered and
 * applied with everyone's.
 */
interface HandoffSession {
  id: string;
  app: string;
  graceMs: number;
  owns: string[];
  pending: Event[];
}

interface HandoffFile {
  version: 1;
  writtenAt: number;
  sessions: HandoffSession[];
  conversations: (convStore.EphemeralConversationState & { record: AppConversationRecord; account: { account: string; lastUsedAt: number } | null })[];
}

/** A handover older than this is from a restart that never came back: ignored. */
const HANDOFF_MAX_AGE_MS = 15 * 60_000;
/**
 * A graceful restart is under way: owners, sessions and turn results stay
 * live while the turns settle (a turn ending meanwhile is kept for its
 * session), until handOffAppConversations writes them.
 */
let handingOff = false;

function handoffPath(): string {
  return join(ephemeralWorkspaceRoot(), "handoff.json");
}

/** After the turns settle at a graceful restart: write what the next daemon takes over. Returns the conversations handed over. */
export function handOffAppConversations(): number {
  if (!handingOff) return 0;
  handingOff = false;
  flushAppRegistry();
  const conversations: HandoffFile["conversations"] = [];
  for (const record of listAppRecords()) {
    if (record.lifetime !== "ephemeral") continue;
    const state = convStore.ephemeralConversationState(record.convId);
    if (state) conversations.push({ record, ...state, account: getConversationAccount(record.convId) });
  }
  const sessionsToHand: HandoffSession[] = [...sessions.values()]
    .filter(session => !session.anonymous)
    .map(session => ({ id: session.id, app: session.app, graceMs: session.graceMs, owns: ownedBy(session), pending: session.pending }));
  // This daemon is going away: what it handed over is the next one's.
  stopTurnListener?.();
  stopTurnListener = null;
  owners.clear();
  sessions.clear();
  awaits.clear();
  lastTurnBlocks.clear();
  if (conversations.length === 0 && sessionsToHand.length === 0) return 0;
  const path = handoffPath();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify({ version: 1, writtenAt: Date.now(), sessions: sessionsToHand, conversations } satisfies HandoffFile), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    log("error", `app-api: could not hand app conversations to the next daemon: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
  log("info", `app-api: handed ${sessionsToHand.length} app session(s) and ${conversations.length} ephemeral conversation(s) to the next daemon`);
  return conversations.length;
}

function readHandoff(): HandoffFile | null {
  const path = handoffPath();
  if (!existsSync(path)) return null;
  let file: HandoffFile | null = null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as HandoffFile;
    if (parsed?.version === 1 && Array.isArray(parsed.sessions) && Array.isArray(parsed.conversations)) file = parsed;
  } catch (error) {
    log("warn", `app-api: ignoring an unreadable handover file: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Read once: nothing of an ephemeral conversation stays on disk.
  rmSync(path, { force: true });
  if (file && Date.now() - file.writtenAt > HANDOFF_MAX_AGE_MS) {
    log("warn", `app-api: ignoring a handover from ${new Date(file.writtenAt).toISOString()}, too old`);
    return null;
  }
  return file;
}

/** Take over what the daemon before handed over. Returns the working directories of the conversations it restored. */
function restoreHandedOff(): Set<string> {
  const keep = new Set<string>();
  const file = readHandoff();
  if (!file) return keep;
  let restored = 0;
  for (const handed of file.conversations) {
    const { record, conversation, account } = handed;
    if (record?.lifetime !== "ephemeral" || conversation?.id !== record.convId || convStore.hasConversation(record.convId)) continue;
    try {
      registerAppConversation(record);
      convStore.adoptEphemeralConversation(handed);
    } catch (error) {
      removeAppConversationRecord(record.convId);
      log("warn", `app-api: could not restore ${record.convId}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (account) touchConversationAccount(record.convId, account.account, account.lastUsedAt);
    const workspace = daemonCreatedAppWorkspace(record);
    if (workspace) keep.add(workspace);
    restored++;
  }
  const now = Date.now();
  for (const handed of file.sessions) {
    // Its client may have reconnected already, while this daemon was loading.
    let session = sessions.get(handed.id);
    if (session && session.app !== handed.app) continue;
    if (!session) {
      session = newSession(handed.id, handed.app, handed.graceMs, false);
      session.disconnectedAt = now;
    }
    session.pending.unshift(...(handed.pending ?? []));
    for (const convId of handed.owns ?? []) {
      if (!isAppConversation(convId) || !convStore.hasConversation(convId) || owners.has(convId)) continue;
      owners.set(convId, session);
      if (session.client) server?.subscribe(session.client, convId);
    }
    if (session.client) {
      deliverPending(session);
      catchUpSession(session);
    } else if (ownedBy(session).length > 0 || session.pending.length > 0) armGrace(session);
    else sessions.delete(session.id);
  }
  // An ephemeral conversation whose owner had no session (graceless) ends as it would have.
  for (const record of listAppRecords()) {
    if (record.lifetime === "ephemeral" && !owners.has(record.convId)) void endAppConversation(record.convId, "owner_disconnected");
  }
  log("info", `app-api: took over ${file.sessions.length} app session(s) and ${restored} ephemeral conversation(s) from the daemon before`);
  return keep;
}

/**
 * Startup, after the records (loadAppRegistry) and conversations load: take
 * over what a graceful restart handed over, forget records whose
 * conversation is gone, clear what crashed ephemeral conversations left, and
 * delete expired temporary ones.
 */
export async function recoverAppConversations(): Promise<void> {
  const keep = restoreHandedOff();
  const loaded = listAppRecords().filter(record => record.lifetime !== "ephemeral").length;
  for (const record of listAppRecords()) {
    if (!convStore.hasConversation(record.convId)) removeAppConversationRecord(record.convId);
  }
  const swept = sweepEphemeralLeftovers(keep);
  if (swept.workspaces > 0 || swept.claudeProjects > 0) {
    log("info", `app-api: removed ${swept.workspaces} ephemeral working director(ies) and ${swept.claudeProjects} Claude Code project(s) an earlier daemon left`);
  }
  const expired = await sweepExpiredAppConversations();
  log("info", `app-api: ${loaded} saved/temporary app conversation(s)${expired.length ? `, ${expired.length} expired and deleted` : ""}`);
}

/**
 * Daemon shutdown. A graceful restart keeps everything for the next daemon
 * (handOffAppConversations writes it once the turns settle); any other exit
 * ends the ephemeral conversations with it.
 */
export async function shutdownAppConversations(): Promise<void> {
  shuttingDown = true;
  // Their turns are about to be interrupted: a replayed turn asks again if it still needs the answer.
  appToolBroker.cancelAllForShutdown();
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  for (const session of sessions.values()) {
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = null;
  }
  if (getDaemonShutdownMode() === "restart" && ephemeralConversationsSurviveRestart()) {
    handingOff = true;
    flushAppRegistry();
    return;
  }
  for (const record of listAppRecords()) {
    if (record.lifetime !== "ephemeral") continue;
    try { await endAppConversation(record.convId, "owner_disconnected"); } catch (error) {
      log("warn", `app-api: ending ${record.convId} at shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  flushAppRegistry();
}

/** Wire the app API into a daemon's server. */
export function configureAppApi(target: DaemonServer, options: {
  ownerWaitMs?: number;
  sweepIntervalMs?: number | null;
  /** App clients' commands wait for markAppApiReady (startup recovery). */
  holdUntilReady?: boolean;
  /** Tests: the default reconnect grace. */
  reconnectGraceMs?: number;
} = {}): () => void {
  server = target;
  shuttingDown = false;
  handingOff = false;
  owners.clear();
  sessions.clear();
  awaits.clear();
  lastTurnBlocks.clear();
  graceOverrideMs = options.reconnectGraceMs ?? null;
  ready = options.holdUntilReady !== true;
  held.length = 0;
  const survives = readExocortexConfig().appApi?.ephemeralSurvivesRestart;
  setEphemeralConversationsSurviveRestart(survives !== false);
  // Test doubles of the server may lack these.
  target.setHiddenConversationFilter?.(isHiddenConversation);
  const stopClose = typeof target.onClientClosed === "function" ? target.onClientClosed(onClientClosed) : () => {};
  setConversationToolResolver((convId, name) => appToolFor(convId, name));
  const baseOwnerWait = options.ownerWaitMs ?? APP_OWNER_WAIT_MS;
  appToolBroker.configure({
    owner: convId => appConversationOwner(convId),
    send: (owner, event) => target.sendTo(owner as ConnectedClient, event),
    ownerWaitMs: convId => ownerWaitMs(convId, baseOwnerWait),
  });
  stopTurnListener?.();
  stopTurnListener = onAssistantTurnEnded(onTurnEnded);
  stopRebaseListener?.();
  // A stream started or was replaced: its owner catches up again.
  stopRebaseListener = onLiveTurnRebased((convId) => {
    const owner = appConversationOwner(convId);
    if (owner) sendTurnCatchup(owner, convId);
  });
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  if (options.sweepIntervalMs !== null) {
    sweepTimer = setInterval(() => {
      void sweepExpiredAppConversations().catch(error => {
        log("error", `app-api: expiry sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, options.sweepIntervalMs ?? SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }
  return () => {
    stopClose();
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    for (const session of sessions.values()) if (session.graceTimer) clearTimeout(session.graceTimer);
    stopRebaseListener?.();
    stopRebaseListener = null;
    setConversationToolResolver(null);
    appToolBroker.configure(null);
    ready = true;
    held.length = 0;
    graceOverrideMs = null;
    server = null;
    // Kept for handOffAppConversations while a graceful restart's turns settle.
    if (handingOff) return;
    stopTurnListener?.();
    stopTurnListener = null;
    owners.clear();
    sessions.clear();
    awaits.clear();
    lastTurnBlocks.clear();
  };
}
