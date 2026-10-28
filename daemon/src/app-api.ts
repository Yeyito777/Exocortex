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

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  APP_API_VERSION,
  APP_DEFAULT_IDLE_TTL_MS,
  APP_LIFETIMES,
  APP_MAX_IDLE_TTL_MS,
  APP_MAX_SYSTEM_TEXT_BYTES,
  APP_SYSTEM_BASES,
  APPS_FOLDER_NAME,
  isAppName,
  type AppConversationInfo,
  type AppLifetime,
  type AppSystemBase,
  type AppToolDef,
} from "@exocortex/shared/app-api";
import { worktreeName } from "@exocortex/shared/paths";
import type { AttachAppConversationCommand, ClientCapabilitiesCommand, ListAppConversationsCommand, TurnResultEvent } from "./protocol";
import type { ConnectedClient, DaemonServer } from "./server";
import type { ProviderId, ModelId, StoredMessage } from "./messages";
import * as convStore from "./conversations";
import {
  appConversationExpiresAt,
  getAppRecord,
  isAppConversation,
  isHiddenConversation,
  listAppRecords,
  flushAppRegistry,
  registerAppConversation,
  removeAppConversationRecord,
  setAppTools,
  setLastTurnResult,
  touchAppConversation,
  type AppConversationRecord,
} from "./app-registry";
import { appToolBroker, appToolFor, resolveAppBuiltinTools, validateAppToolDefs } from "./app-tools";
import { createEphemeralWorkspace, daemonCreatedAppWorkspace, removeAppWorkspace, removeClaudeProjectDir, removeClaudeSessionFiles, sweepEphemeralLeftovers } from "./app-workspaces";
import { onAssistantTurnEnded, type AssistantTurnEnd } from "./conversation-lifecycle";
import { setConversationToolResolver } from "./tools/registry";
import { getModelInfo } from "./providers/registry";
import { getClaudeCodeSession } from "./providers/anthropic/session";
import { forgetConversationAccount } from "./providers/anthropic/account-pool";
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
}

interface AppCreateFields {
  app?: unknown;
  lifetime?: unknown;
  idleTtlMs?: unknown;
  system?: unknown;
  cwd?: unknown;
  tools?: unknown;
}

const APP_ONLY_FIELDS = ["lifetime", "idleTtlMs", "system", "cwd", "tools"] as const;

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

// ── Owners, awaits and turn results ─────────────────────────────────

const owners = new Map<string, ConnectedClient>();
interface PendingAwait { client: ConnectedClient; reqId: string | undefined; turnId: string }
const awaits = new Map<string, PendingAwait[]>();
let server: DaemonServer | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let stopTurnListener: (() => void) | null = null;
let shuttingDown = false;
const SWEEP_INTERVAL_MS = 60_000;

export function appConversationOwner(convId: string): ConnectedClient | null {
  const owner = owners.get(convId);
  return owner && !owner.socket.destroyed ? owner : null;
}

/** Make `client` the owner: it gets the conversation's events and app tool calls. */
export function setAppConversationOwner(convId: string, client: ConnectedClient): void {
  owners.set(convId, client);
  server?.subscribe(client, convId);
  appToolBroker.ownerAttached(convId);
}

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
  };
}

/**
 * Every assistant turn's end: answer the sends that awaited it and, for an app
 * conversation, tell its current owner and keep the result for one attaching
 * later. A turn that only paused (a Chrono sleep) or that a daemon restart
 * will replay is not over.
 */
function onTurnEnded(end: AssistantTurnEnd): void {
  if (end.manualCompaction || end.suspended || (end.aborted && end.daemonRestart)) return;
  const result = buildTurnResult(end);
  const list = awaits.get(end.convId) ?? [];
  const waiting = list.filter(entry => entry.turnId === result.turnId);
  if (waiting.length > 0) {
    const rest = list.filter(entry => entry.turnId !== result.turnId);
    if (rest.length > 0) awaits.set(end.convId, rest);
    else awaits.delete(end.convId);
  }
  for (const entry of waiting) {
    if (!entry.client.socket.destroyed) server?.sendTo(entry.client, { ...result, ...(entry.reqId ? { reqId: entry.reqId } : {}) });
  }
  if (!isAppConversation(end.convId)) return;
  touchAppConversation(end.convId);
  setLastTurnResult(end.convId, result);
  const owner = appConversationOwner(end.convId);
  if (owner && !waiting.some(entry => entry.client === owner)) server?.sendTo(owner, result);
}

// ── Reporting ───────────────────────────────────────────────────────

export function appConversationInfo(record: AppConversationRecord): AppConversationInfo {
  const summary = convStore.getIndexedSummary(record.convId);
  const expiresAt = appConversationExpiresAt(record);
  const workspace = daemonCreatedAppWorkspace(record);
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
  };
}

export function welcomeAppClient(client: ConnectedClient, cmd: ClientCapabilitiesCommand): void {
  const app = cmd.app as { name?: unknown; version?: unknown } | null | undefined;
  if (!app || typeof app !== "object" || !isAppName(app.name)) {
    server?.sendTo(client, { type: "error", reqId: cmd.reqId, message: "app.name must match ^[a-z0-9][a-z0-9-]{0,39}$" });
    return;
  }
  const name = app.name;
  client.app = { name, ...(typeof app.version === "string" ? { version: app.version.slice(0, 100) } : {}) };
  server?.sendTo(client, {
    type: "app_welcome",
    ...(cmd.reqId ? { reqId: cmd.reqId } : {}),
    appApiVersion: APP_API_VERSION,
    app: name,
    instance: worktreeName() ?? "main",
    pid: process.pid,
  });
  log("info", `app-api: ${client.id} is app ${name}${client.app.version ? ` ${client.app.version}` : ""}`);
}

export function listAppConversations(client: ConnectedClient, cmd: ListAppConversationsCommand): void {
  const conversations = listAppRecords()
    .filter(record => (!cmd.app || record.app === cmd.app) && (cmd.includeSaved === true || record.lifetime !== "saved"))
    .filter(record => convStore.hasConversation(record.convId))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map(appConversationInfo);
  server?.sendTo(client, { type: "app_conversations_list", reqId: cmd.reqId, conversations });
}

/** attach_app_conversation: become the owner, optionally replacing the app tools. */
export function attachAppConversation(client: ConnectedClient, cmd: AttachAppConversationCommand): void {
  const record = getAppRecord(cmd.convId);
  if (!record || !convStore.hasConversation(cmd.convId)) {
    server?.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `App conversation ${cmd.convId} not found` });
    return;
  }
  const current = appConversationOwner(cmd.convId);
  if (record.lifetime === "ephemeral" && current && current !== client) {
    server?.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: "An ephemeral conversation belongs to the connection that created it" });
    return;
  }
  if (client.app && client.app.name !== record.app) {
    server?.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: `Conversation ${cmd.convId} belongs to app ${record.app}` });
    return;
  }
  if (cmd.tools?.app !== undefined) {
    let tools: AppToolDef[];
    try { tools = validateAppToolDefs(cmd.tools.app); } catch (error) {
      server?.sendTo(client, { type: "error", reqId: cmd.reqId, convId: cmd.convId, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    setAppTools(cmd.convId, tools);
  }
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
  const sessions = claudeSessions(messages);
  if (live?.sessionId) sessions.push({ sessionId: live.sessionId, ...(record.cwd ? { cwd: record.cwd } : {}) });
  live?.close(`its app conversation ended (${reason})`);
  const existed = convStore.purge(convId) || !convStore.hasConversation(convId);
  // The daemon's own working directory is the Claude Code project of its sessions alone.
  const workspace = daemonCreatedAppWorkspace(record);
  removeClaudeSessionFiles(sessions);
  if (workspace) removeClaudeProjectDir(workspace);
  removeAppWorkspace(record);
  const event = { type: "conversation_deleted" as const, convId, reason };
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
  for (const [convId, owner] of [...owners]) {
    if (owner !== client) continue;
    owners.delete(convId);
    const record = getAppRecord(convId);
    if (record?.lifetime === "ephemeral") {
      void endAppConversation(convId, "owner_disconnected").catch(error => {
        log("error", `app-api: ending ${convId} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else {
      appToolBroker.ownerDetached(convId);
    }
  }
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

/**
 * Startup, after conversations load: read the records, forget those whose
 * conversation is gone, clear what crashed ephemeral conversations left, and
 * delete expired temporary ones.
 */
export async function recoverAppConversations(): Promise<void> {
  const loaded = listAppRecords().length;
  for (const record of listAppRecords()) {
    if (!convStore.hasConversation(record.convId)) removeAppConversationRecord(record.convId);
  }
  const swept = sweepEphemeralLeftovers();
  if (swept.workspaces > 0 || swept.claudeProjects > 0) {
    log("info", `app-api: removed ${swept.workspaces} ephemeral working director(ies) and ${swept.claudeProjects} Claude Code project(s) an earlier daemon left`);
  }
  const expired = await sweepExpiredAppConversations();
  log("info", `app-api: ${loaded} saved/temporary app conversation(s)${expired.length ? `, ${expired.length} expired and deleted` : ""}`);
}

/** Daemon shutdown: ephemeral conversations end with it. */
export async function shutdownAppConversations(): Promise<void> {
  shuttingDown = true;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  for (const record of listAppRecords()) {
    if (record.lifetime !== "ephemeral") continue;
    try { await endAppConversation(record.convId, "owner_disconnected"); } catch (error) {
      log("warn", `app-api: ending ${record.convId} at shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  flushAppRegistry();
}

/** Wire the app API into a daemon's server. */
export function configureAppApi(target: DaemonServer, options: { ownerWaitMs?: number; sweepIntervalMs?: number | null } = {}): () => void {
  server = target;
  shuttingDown = false;
  // Test doubles of the server may lack these.
  target.setHiddenConversationFilter?.(isHiddenConversation);
  const stopClose = typeof target.onClientClosed === "function" ? target.onClientClosed(onClientClosed) : () => {};
  setConversationToolResolver((convId, name) => appToolFor(convId, name));
  appToolBroker.configure({
    owner: convId => appConversationOwner(convId),
    send: (owner, event) => target.sendTo(owner as ConnectedClient, event),
    ...(options.ownerWaitMs !== undefined ? { ownerWaitMs: options.ownerWaitMs } : {}),
  });
  stopTurnListener?.();
  stopTurnListener = onAssistantTurnEnded(onTurnEnded);
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
    stopTurnListener?.();
    stopTurnListener = null;
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    setConversationToolResolver(null);
    appToolBroker.configure(null);
    owners.clear();
    awaits.clear();
    server = null;
  };
}
