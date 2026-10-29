/**
 * The user's own machines, for client_bash.
 *
 * A machine reaches this daemon in one of two ways: its Exocortex daemon's
 * /proxy link (the hello names the machine; see provider-proxy/link.ts), or a
 * TUI connected over /ssh (client_capabilities names it). The daemon link is
 * preferred: it stays up while the user's TUI is closed or frozen. client_bash
 * sends a command down one of those connections and waits for its result. A
 * machine stays attached exactly as long as its connection, and a lost
 * connection fails the commands still waiting on it.
 *
 * Connections that acknowledge commands and report them alive (every daemon
 * link, TUIs with client-exec-alive) fail a call within seconds when they stop
 * answering, instead of after the command's whole timeout.
 *
 * Several machines can be attached at once (a laptop and a phone), and a
 * command meant for one must never run on another. Each machine has a short
 * client ID (mac, phone): its name in config clientHosts.names, else one made
 * from its platform or hostname and kept in client-hosts.json across
 * restarts. A client_bash call names its machine with host. It may leave host
 * out only while a single machine is connected and the conversation was told
 * that one is the only one (clientHostNotice); nothing is ever picked for it
 * by who attached last or who is viewing the conversation.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { EXEC_ACK_TIMEOUT_MS, EXEC_SILENCE_TIMEOUT_MS, ExecLiveness, execStallMessage } from "@exocortex/shared/command-exec";
import { readExocortexConfig } from "@exocortex/shared/config";
import { dataDir } from "@exocortex/shared/paths";
import type { ClientExecRequestEvent, ClientExecResultCommand, ClientHostInfo, Event } from "@exocortex/shared/protocol";
import { log } from "./log";
import type { ConnectedClient } from "./server";
import { timerDelayMs } from "./tools/util";

/** How long past its own timeout a command may go unanswered before it is given up on. */
const RESPONSE_GRACE_MS = 30_000;

/** How a machine is reached: its daemon's /proxy link, or a TUI over /ssh. */
export type ClientHostVia = "daemon" | "tui";

export interface AttachClientHostOptions {
  via?: ClientHostVia;
  /** It acknowledges commands and reports them alive while they run. */
  reportsAlive?: boolean;
}

interface AttachedHost {
  client: ConnectedClient;
  info: ClientHostInfo;
  via: ClientHostVia;
  reportsAlive: boolean;
  send(event: Event): void;
  attachedAt: number;
  /** It let a command go unanswered and has not been heard from since. */
  stalled: boolean;
}

/** A command's result, and the machine (and its client ID) it ran on. */
export type ClientExecOutcome = Omit<ClientExecResultCommand, "type" | "execId"> & { host: ClientHostInfo; clientId: string };

interface PendingExec {
  host: AttachedHost;
  clientId: string;
  settle(outcome: ClientExecOutcome | { failure: string }): void;
  alive(): void;
}

const hosts = new Map<ConnectedClient, AttachedHost>();
const pending = new Map<string, PendingExec>();
let livenessTimeouts = { ackMs: EXEC_ACK_TIMEOUT_MS, silenceMs: EXEC_SILENCE_TIMEOUT_MS };

function isHostInfo(value: unknown): value is ClientHostInfo {
  const info = value as ClientHostInfo | null;
  return typeof info === "object" && info !== null
    && typeof info.hostname === "string" && info.hostname.length > 0
    && typeof info.user === "string" && typeof info.platform === "string" && typeof info.home === "string";
}

export function describeClientHost(info: ClientHostInfo): string {
  return `${info.user ? `${info.user}@` : ""}${info.hostname}`;
}

function describeVia(host: AttachedHost, clientId: string): string {
  return `${clientId} (${describeClientHost(host.info)}, over ${host.via === "daemon" ? "its Exocortex daemon's /proxy link" : "its TUI over /ssh"})`;
}

/** Attach the machine a connection announced; it detaches when the connection closes. */
export function attachClientHost(client: ConnectedClient, info: unknown, send: (event: Event) => void, options: AttachClientHostOptions = {}): void {
  if (!isHostInfo(info)) return;
  const known = hosts.has(client);
  hosts.set(client, {
    client,
    info: { hostname: info.hostname, user: info.user, platform: info.platform, home: info.home },
    via: options.via ?? "tui",
    reportsAlive: options.reportsAlive ?? false,
    send,
    attachedAt: Date.now(),
    stalled: false,
  });
  if (!known) client.socket.once("close", () => detachClientHost(client));
  // Give a new machine its ID now, so it keeps the one it was first seen with.
  clientIdFor(machineKey(info), info, true);
}

export function detachClientHost(client: ConnectedClient): void {
  const host = hosts.get(client);
  if (!host) return;
  hosts.delete(client);
  const stops = host.via === "daemon" ? "its daemon stops the command when that happens" : "the TUI stops its commands when that happens";
  for (const exec of [...pending.values()]) {
    if (exec.host === host) {
      exec.settle({ failure: `The connection to ${describeVia(host, exec.clientId)} was lost before the command finished; ${stops}.` });
    }
  }
}

function machineKey(info: ClientHostInfo): string {
  return `${info.user}@${info.hostname}`;
}

// ── Client IDs ─────────────────────────────────────────────────────

/** What a client ID looks like: a configured name must too. */
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Machines whose ID is remembered; past this the least recently seen are forgotten. */
const MAX_REMEMBERED_MACHINES = 200;

interface MachineRecord {
  id: string;
  lastSeen: number;
}

// Machine key (user@hostname) → its ID, from client-hosts.json.
let registry: Map<string, MachineRecord> | null = null;

function registryPath(): string {
  return join(dataDir(), "client-hosts.json");
}

function loadedRegistry(): Map<string, MachineRecord> {
  if (registry) return registry;
  registry = new Map();
  try {
    const file = JSON.parse(readFileSync(registryPath(), "utf8")) as { machines?: Record<string, Partial<MachineRecord>> } | null;
    for (const [key, record] of Object.entries(file?.machines ?? {})) {
      if (typeof record?.id === "string" && CLIENT_ID_PATTERN.test(record.id)) {
        registry.set(key, { id: record.id, lastSeen: typeof record.lastSeen === "number" ? record.lastSeen : 0 });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log("warn", `client-hosts: ignoring unreadable ${registryPath()}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return registry;
}

function saveRegistry(map: Map<string, MachineRecord>): void {
  while (map.size > MAX_REMEMBERED_MACHINES) {
    const stalest = [...map].reduce((a, b) => (b[1].lastSeen < a[1].lastSeen ? b : a));
    map.delete(stalest[0]);
  }
  const path = registryPath();
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: 1, machines: Object.fromEntries(map) }, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (error) {
    log("warn", `client-hosts: could not save ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** user@hostname with the hostname lowercased, for matching what the user typed. */
function normalizedKey(key: string): string {
  const at = key.lastIndexOf("@");
  return at < 0 ? key.toLowerCase() : `${key.slice(0, at)}@${key.slice(at + 1).toLowerCase()}`;
}

/** clientHosts.names from config, by normalized machine key; of two machines given one name, the first keeps it. */
function configuredNames(): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const [key, value] of Object.entries(readExocortexConfig().clientHosts?.names ?? {})) {
    const id = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!CLIENT_ID_PATTERN.test(id) || taken.has(id)) continue;
    names.set(normalizedKey(key), id);
    taken.add(id);
  }
  return names;
}

function slug(text: string, max = 24): string {
  return text.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, max).replace(/-+$/, "");
}

/** The ID a machine gets unless named: its platform for macOS and Windows, else its hostname's first label. */
function baseClientId(info: ClientHostInfo): string {
  if (info.platform === "darwin") return "mac";
  if (info.platform === "win32") return "windows";
  if (info.platform === "android") return "android";
  const label = /^[0-9.:]+$/.test(info.hostname) ? "" : slug(info.hostname.split(".")[0] ?? "");
  if (label && label !== "localhost") return label;
  return slug(info.platform) || "machine";
}

/**
 * A machine's client ID: its name in config clientHosts.names, else the one
 * it was given when first seen (client-hosts.json), else a new one from its
 * platform or hostname, numbered when taken (mac, mac-2).
 */
function clientIdFor(key: string, info: ClientHostInfo, seen = false): string {
  const names = configuredNames();
  const configured = names.get(normalizedKey(key));
  if (configured) return configured;
  const machines = loadedRegistry();
  const taken = new Set(names.values());
  for (const [other, record] of machines) if (other !== key) taken.add(record.id);
  const stored = machines.get(key);
  if (stored && !taken.has(stored.id)) {
    if (seen) {
      stored.lastSeen = Date.now();
      saveRegistry(machines);
    }
    return stored.id;
  }
  const base = baseClientId(info);
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 28)}-${n}`;
  machines.set(key, { id, lastSeen: Date.now() });
  saveRegistry(machines);
  log("info", `client-hosts: ${key} is client ${id}${stored ? ` (was ${stored.id})` : ""}`);
  return id;
}

/** Every ID a machine has or had: configured names and remembered IDs. */
function knownClientIds(): Set<string> {
  return new Set([...configuredNames().values(), ...[...loadedRegistry().values()].map(record => record.id)]);
}

// ── Connected machines ─────────────────────────────────────────────

interface Machine {
  id: string;
  key: string;
  info: ClientHostInfo;
  /** Its live connections, in attach order. */
  connections: AttachedHost[];
}

/** The machines attached now, by ID. */
function connectedMachines(): Machine[] {
  const byKey = new Map<string, AttachedHost[]>();
  for (const host of hosts.values()) {
    if (host.client.socket.destroyed) continue;
    const key = machineKey(host.info);
    byKey.set(key, [...byKey.get(key) ?? [], host]);
  }
  return [...byKey].map(([key, connections]) => {
    const info = connections.at(-1)!.info;
    return { id: clientIdFor(key, info), key, info, connections };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

/** On one machine: a responsive connection first, then its daemon's link (it outlives TUIs), then the newest. */
function bestConnection(connections: AttachedHost[]): AttachedHost {
  const rank = (host: AttachedHost) => [host.stalled ? 1 : 0, host.via === "daemon" ? 0 : 1, -host.attachedAt];
  // Newest first, so a tie (attached in the same millisecond) goes to the newer.
  return [...connections].reverse().sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  })[0];
}

function platformName(platform: string): string {
  return platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
}

/** "mac (yeyito@Aurelios-MacBook-Pro.local, macOS, home /Users/yeyito)" */
function describeMachine(machine: Pick<Machine, "id" | "info">): string {
  return `${machine.id} (${describeClientHost(machine.info)}, ${platformName(machine.info.platform)}, home ${machine.info.home})`;
}

function listMachines(machines: readonly Machine[]): string {
  return machines.map(describeMachine).join("; ");
}

/** A connected machine, as tests and diagnostics see it. */
export interface ConnectedClientHost {
  id: string;
  info: ClientHostInfo;
  /** How a command would reach it now. */
  via: ClientHostVia;
}

/** The user's machines attached now, by client ID. */
export function connectedClientHosts(): ConnectedClientHost[] {
  return connectedMachines().map(machine => ({ id: machine.id, info: machine.info, via: bestConnection(machine.connections).via }));
}

// ── Choosing the machine ───────────────────────────────────────────

/** Which machine a client_bash call is for. */
export interface ClientHostTarget {
  /** The client ID (or user@hostname) the call named. */
  host?: string;
  /**
   * The machine the conversation was last told is the only one connected
   * (ClientHostNotice.defaultHost), or null. A call naming no host runs only
   * there.
   */
  announced?: string | null;
}

const HOW_TO_CONNECT = "client_bash works while its Exocortex daemon is linked to this one (/proxy) or its TUI is connected with /ssh.";

type HostChoice = { host: AttachedHost; id: string } | { failure: string };

/**
 * The connection to run a call on, or why there is none. Only the machine the
 * call names; with none named, the one machine connected, and only when it is
 * the one the conversation was told about. Never another machine instead.
 */
function chooseHost(target: ClientHostTarget): HostChoice {
  const machines = connectedMachines();
  const requested = target.host?.trim();
  if (requested) {
    const wanted = requested.toLowerCase();
    const match = machines.find(machine => machine.id === wanted)
      ?? machines.find(machine => normalizedKey(machine.key) === normalizedKey(requested));
    if (match) return { host: bestConnection(match.connections), id: match.id };
    const away = knownClientIds().has(wanted) ? `The user's machine ${wanted} is not connected right now.` : `No machine of the user's is called "${requested}".`;
    if (machines.length === 0) return { failure: `${away} None is connected. ${HOW_TO_CONNECT}` };
    return { failure: `${away} Connected: ${listMachines(machines)}. Nothing was run; pass one of those IDs as host only if the command is meant for that machine.` };
  }
  if (machines.length === 0) return { failure: `The user's machine is not connected. ${HOW_TO_CONNECT}` };
  if (machines.length > 1) {
    return { failure: `Several of the user's machines are connected: ${listMachines(machines)}. Nothing was run; pass host with the ID of the machine the command is for.` };
  }
  const [only] = machines;
  if (target.announced !== only.id) {
    return { failure: `Nothing was run: host is needed, as this conversation was not told ${only.id} is the only machine connected. Connected now: ${listMachines(machines)}. Pass host="${only.id}" only if the command is meant for that machine.` };
  }
  return { host: bestConnection(only.connections), id: only.id };
}

function heardFrom(client: ConnectedClient): AttachedHost | null {
  const host = hosts.get(client) ?? null;
  if (host) host.stalled = false;
  return host;
}

/** Record a connection's answer to one of its requests. Answers from elsewhere are ignored. */
export function settleClientExec(
  client: ConnectedClient,
  result: Omit<ClientExecResultCommand, "type"> & { type: "client_exec_result" | "provider_proxy_client_exec_result" },
): void {
  const exec = pending.get(result.execId);
  if (!exec || exec.host.client !== client) return;
  heardFrom(client);
  exec.settle({
    host: exec.host.info,
    clientId: exec.clientId,
    output: typeof result.output === "string" ? result.output : "",
    byteTruncated: result.byteTruncated === true,
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    signal: typeof result.signal === "string" ? result.signal : null,
    timedOut: result.timedOut === true,
    ...(typeof result.error === "string" && result.error ? { error: result.error } : {}),
  });
}

/** A connection says these commands are running (client_exec_alive, provider_proxy_client_exec_alive). */
export function clientExecAlive(client: ConnectedClient, execIds: unknown): void {
  if (!heardFrom(client) || !Array.isArray(execIds)) return;
  for (const execId of execIds) {
    const exec = pending.get(String(execId));
    if (exec && exec.host.client === client) exec.alive();
  }
}

function sendRequest(host: AttachedHost, request: ClientExecRequestEvent): void {
  if (host.via === "daemon") {
    const { type: _type, ...rest } = request;
    host.send({ type: "provider_proxy_client_exec", ...rest });
  } else {
    host.send(request);
  }
}

function sendCancel(host: AttachedHost, execId: string): void {
  host.send(host.via === "daemon" ? { type: "provider_proxy_client_exec_cancel", execId } : { type: "client_exec_cancel", execId });
}

/**
 * Run a command on the machine a call is for (chooseHost). Resolves with the
 * command's outcome, or a failure saying why it did not run to completion.
 */
export function runOnClientHost(
  target: ClientHostTarget,
  request: Omit<ClientExecRequestEvent, "type" | "execId">,
  signal?: AbortSignal,
): Promise<ClientExecOutcome | { failure: string }> {
  const choice = chooseHost(target);
  if ("failure" in choice) return Promise.resolve(choice);
  const { host, id: clientId } = choice;
  if (signal?.aborted) return Promise.resolve({ failure: "Interrupted before the command was sent." });

  const execId = randomUUID();
  return new Promise(resolve => {
    const deadline = setTimeout(() => {
      sendCancel(host, execId);
      finish({ failure: `${describeVia(host, clientId)} did not answer within ${Math.round((request.timeoutMs + RESPONSE_GRACE_MS) / 1000)}s.` });
    }, timerDelayMs(request.timeoutMs + RESPONSE_GRACE_MS));
    deadline.unref?.();
    const liveness = host.reportsAlive ? new ExecLiveness((phase, afterMs) => {
      host.stalled = true;
      sendCancel(host, execId);
      finish({ failure: execStallMessage(describeVia(host, clientId), phase, afterMs) });
    }, livenessTimeouts.ackMs, livenessTimeouts.silenceMs) : null;
    const onAbort = () => {
      sendCancel(host, execId);
      finish({ failure: "Interrupted; the command was stopped." });
    };
    function finish(outcome: ClientExecOutcome | { failure: string }): void {
      if (!pending.has(execId)) return;
      pending.delete(execId);
      clearTimeout(deadline);
      liveness?.stop();
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    }
    pending.set(execId, { host, clientId, settle: finish, alive: () => liveness?.heard() });
    signal?.addEventListener("abort", onAbort, { once: true });
    sendRequest(host, { type: "client_exec_request", execId, ...request });
  });
}

// ── Where the user writes from ─────────────────────────────────────

/** Conversations whose latest writer's machine is remembered; past this the least recent are forgotten. */
const MAX_REMEMBERED_WRITERS = 5_000;

// Conversation id → machine key of the connection that last sent it a message, least recent first.
const wroteFrom = new Map<string, string>();

/**
 * A connection sent a conversation a message (or queued one). When it is one
 * of the user's machines (a TUI over /ssh), the conversation is told the user
 * writes from there. Other connections (apps, the CLI) change nothing.
 */
export function noteUserWroteFrom(client: ConnectedClient, convId: string): void {
  const host = hosts.get(client);
  if (!host) return;
  wroteFrom.delete(convId);
  wroteFrom.set(convId, machineKey(host.info));
  while (wroteFrom.size > MAX_REMEMBERED_WRITERS) wroteFrom.delete(wroteFrom.keys().next().value!);
}

/** The machine (user@hostname) the user last wrote to a conversation from, while this daemon has run. */
export function userWroteFrom(convId: string): string | null {
  return wroteFrom.get(convId) ?? null;
}

// ── What the model is told ─────────────────────────────────────────

/** Where the user last wrote from, for a notice: a machine key, and whether it was to the conversation's parent. */
export interface ClientOrigin {
  key: string;
  viaParent: boolean;
}

export interface ClientHostNotice {
  text: string;
  /** The only machine connected: a call may leave host out while it stays so (ClientHostTarget.announced). */
  defaultHost?: string;
  /** The machine key the user last wrote from, kept with the notice so a restart does not forget it. */
  origin?: string;
}

/** Told to a conversation when none of the user's machines is connected any more. */
export const CLIENT_HOST_DETACHED_NOTICE = "None of the user's machines is connected any more; client_bash is unavailable until one's Exocortex daemon relinks (/proxy) or its TUI reconnects with /ssh.";

/**
 * What to tell a conversation about the machines client_bash reaches, or null
 * when none is connected: each by client ID, whether host may be left out,
 * and which of them the user last wrote from.
 */
export function clientHostNotice(origin: ClientOrigin | null = null): ClientHostNotice | null {
  const machines = connectedMachines();
  if (machines.length === 0) return null;
  const elsewhere = `every other tool still runs on ${hostname()}.`;
  const lines = machines.length === 1
    ? [`The user's machine ${describeMachine(machines[0])} is connected. client_bash runs commands there; host may be left out while it is the only one. ${elsewhere[0].toUpperCase()}${elsewhere.slice(1)}`]
    : [`The user's machines connected now: ${listMachines(machines)}. client_bash needs host set to the ID of the machine a command is for; ${elsewhere}`];
  const from = origin ? machines.find(machine => machine.key === origin.key) : undefined;
  if (from) lines.push(`The user last wrote ${origin!.viaParent ? "to the conversation that started this task " : "here "}from ${from.id}.`);
  return {
    text: lines.join(" "),
    ...(machines.length === 1 ? { defaultHost: machines[0].id } : {}),
    ...(origin ? { origin: origin.key } : {}),
  };
}

export function setClientExecLivenessForTest(timeouts: { ackMs: number; silenceMs: number } | null): void {
  livenessTimeouts = timeouts ?? { ackMs: EXEC_ACK_TIMEOUT_MS, silenceMs: EXEC_SILENCE_TIMEOUT_MS };
}

/** Forget what a restart forgets: connections, where the user wrote from, and client IDs in memory (not client-hosts.json). */
export function restartClientHostsForTest(): void {
  hosts.clear();
  pending.clear();
  wroteFrom.clear();
  registry = null;
}

export function resetClientHostsForTest(): void {
  hosts.clear();
  pending.clear();
  wroteFrom.clear();
  registry = new Map();
  rmSync(registryPath(), { force: true });
  setClientExecLivenessForTest(null);
}
