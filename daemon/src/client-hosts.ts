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
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { EXEC_ACK_TIMEOUT_MS, EXEC_SILENCE_TIMEOUT_MS, ExecLiveness, execStallMessage } from "@exocortex/shared/command-exec";
import type { ClientExecRequestEvent, ClientExecResultCommand, ClientHostInfo, Event } from "@exocortex/shared/protocol";
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

export type ClientExecOutcome = Omit<ClientExecResultCommand, "type" | "execId"> & { host: ClientHostInfo };

interface PendingExec {
  host: AttachedHost;
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

function describeVia(host: AttachedHost): string {
  return `${describeClientHost(host.info)} (${host.via === "daemon" ? "its Exocortex daemon's /proxy link" : "its TUI over /ssh"})`;
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
}

export function detachClientHost(client: ConnectedClient): void {
  const host = hosts.get(client);
  if (!host) return;
  hosts.delete(client);
  const stops = host.via === "daemon" ? "its daemon stops the command when that happens" : "the TUI stops its commands when that happens";
  for (const exec of [...pending.values()]) {
    if (exec.host === host) {
      exec.settle({ failure: `The connection to ${describeVia(host)} was lost before the command finished; ${stops}.` });
    }
  }
}

function machineKey(info: ClientHostInfo): string {
  return `${info.user}@${info.hostname}`;
}

/**
 * The connection to run a conversation's client_bash on. The machine: one
 * with a TUI viewing the conversation, else the latest to attach. On that
 * machine: a responsive connection first, then its daemon's link (it outlives
 * TUIs), then the newest.
 */
function selectHost(convId?: string): AttachedHost | null {
  const live = [...hosts.values()].filter(host => !host.client.socket.destroyed);
  let target: AttachedHost | null = null;
  for (const host of live) {
    const viewing = convId !== undefined && host.client.subscriptions.has(convId);
    const targetViewing = target !== null && convId !== undefined && target.client.subscriptions.has(convId);
    if (!target || (viewing && !targetViewing) || (viewing === targetViewing && host.attachedAt >= target.attachedAt)) target = host;
  }
  if (!target) return null;
  const key = machineKey(target.info);
  const rank = (host: AttachedHost) => [host.stalled ? 1 : 0, host.via === "daemon" ? 0 : 1, -host.attachedAt];
  // Newest first, so a tie (attached in the same millisecond) goes to the newer.
  return live.filter(host => machineKey(host.info) === key).reverse().sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  })[0] ?? null;
}

export function attachedClientHost(convId?: string): ClientHostInfo | null {
  return selectHost(convId)?.info ?? null;
}

/** How a conversation's client_bash would reach the machine now, or null when none is attached. */
export function attachedClientHostVia(convId?: string): ClientHostVia | null {
  return selectHost(convId)?.via ?? null;
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
 * Run a command on the conversation's client machine. Resolves with the
 * command's outcome, or a failure saying why it did not run to completion.
 */
export function runOnClientHost(
  convId: string | undefined,
  request: Omit<ClientExecRequestEvent, "type" | "execId">,
  signal?: AbortSignal,
): Promise<ClientExecOutcome | { failure: string }> {
  const host = selectHost(convId);
  if (!host) {
    return Promise.resolve({ failure: "The user's machine is not connected. client_bash works while its Exocortex daemon is linked to this one (/proxy) or its TUI is connected with /ssh." });
  }
  if (signal?.aborted) return Promise.resolve({ failure: "Interrupted before the command was sent." });

  const execId = randomUUID();
  return new Promise(resolve => {
    const deadline = setTimeout(() => {
      sendCancel(host, execId);
      finish({ failure: `${describeVia(host)} did not answer within ${Math.round((request.timeoutMs + RESPONSE_GRACE_MS) / 1000)}s.` });
    }, timerDelayMs(request.timeoutMs + RESPONSE_GRACE_MS));
    deadline.unref?.();
    const liveness = host.reportsAlive ? new ExecLiveness((phase, afterMs) => {
      host.stalled = true;
      sendCancel(host, execId);
      finish({ failure: execStallMessage(describeVia(host), phase, afterMs) });
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
    pending.set(execId, { host, settle: finish, alive: () => liveness?.heard() });
    signal?.addEventListener("abort", onAbort, { once: true });
    sendRequest(host, { type: "client_exec_request", execId, ...request });
  });
}

function platformName(platform: string): string {
  return platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
}

/** Told to a conversation when the machine client_bash reached is no longer connected. */
export const CLIENT_HOST_DETACHED_NOTICE = "The user's machine is no longer connected; client_bash is unavailable until its Exocortex daemon relinks (/proxy) or its TUI reconnects with /ssh.";

/** What to tell a conversation about the machine client_bash reaches, or null when none is connected. */
export function clientHostNoticeText(convId?: string): string | null {
  const info = attachedClientHost(convId);
  if (!info) return null;
  return `The user's machine ${describeClientHost(info)} (${platformName(info.platform)}, home ${info.home}) is connected. `
    + `client_bash runs commands on that machine; every other tool still runs on ${hostname()}.`;
}

export function setClientExecLivenessForTest(timeouts: { ackMs: number; silenceMs: number } | null): void {
  livenessTimeouts = timeouts ?? { ackMs: EXEC_ACK_TIMEOUT_MS, silenceMs: EXEC_SILENCE_TIMEOUT_MS };
}

export function resetClientHostsForTest(): void {
  hosts.clear();
  pending.clear();
  setClientExecLivenessForTest(null);
}
