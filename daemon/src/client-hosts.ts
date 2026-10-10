/**
 * The user's own machines, reached through the TUIs connected over /ssh.
 *
 * Such a TUI announces its machine in client_capabilities. client_bash sends
 * a command to one of those connections and waits for its client_exec_result.
 * A machine stays attached exactly as long as its connection, and a lost
 * connection fails the commands still waiting on it.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { ClientExecRequestEvent, ClientExecResultCommand, ClientHostInfo, Event } from "@exocortex/shared/protocol";
import type { Conversation, StoredMessage } from "./messages";
import type { ConnectedClient } from "./server";
import { isScopedSubagent } from "./subagent-policy";

/** Kind of the model-visible notice saying which machine client_bash reaches. */
export const CLIENT_HOST_NOTICE_KIND = "client_host";

/** How long past its own timeout a command may go unanswered before it is given up on. */
const RESPONSE_GRACE_MS = 30_000;

interface AttachedHost {
  client: ConnectedClient;
  info: ClientHostInfo;
  send(event: Event): void;
  attachedAt: number;
}

export type ClientExecOutcome = Omit<ClientExecResultCommand, "type" | "execId"> & { host: ClientHostInfo };

interface PendingExec {
  host: AttachedHost;
  settle(outcome: ClientExecOutcome | { failure: string }): void;
}

const hosts = new Map<ConnectedClient, AttachedHost>();
const pending = new Map<string, PendingExec>();

function isHostInfo(value: unknown): value is ClientHostInfo {
  const info = value as ClientHostInfo | null;
  return typeof info === "object" && info !== null
    && typeof info.hostname === "string" && info.hostname.length > 0
    && typeof info.user === "string" && typeof info.platform === "string" && typeof info.home === "string";
}

export function describeClientHost(info: ClientHostInfo): string {
  return `${info.user ? `${info.user}@` : ""}${info.hostname}`;
}

/** Attach the machine a connection announced; it detaches when the connection closes. */
export function attachClientHost(client: ConnectedClient, info: unknown, send: (event: Event) => void): void {
  if (!isHostInfo(info)) return;
  const known = hosts.has(client);
  hosts.set(client, {
    client,
    info: { hostname: info.hostname, user: info.user, platform: info.platform, home: info.home },
    send,
    attachedAt: Date.now(),
  });
  if (!known) client.socket.once("close", () => detachClientHost(client));
}

export function detachClientHost(client: ConnectedClient): void {
  const host = hosts.get(client);
  if (!host) return;
  hosts.delete(client);
  for (const exec of [...pending.values()]) {
    if (exec.host === host) {
      exec.settle({ failure: `The connection to ${describeClientHost(host.info)} was lost before the command finished; the TUI stops its commands when that happens.` });
    }
  }
}

/** The machine to run a conversation's client_bash on: one viewing it, else the latest to attach. */
function selectHost(convId?: string): AttachedHost | null {
  let best: AttachedHost | null = null;
  for (const host of hosts.values()) {
    if (host.client.socket.destroyed) continue;
    const viewing = convId !== undefined && host.client.subscriptions.has(convId);
    const bestViewing = best !== null && convId !== undefined && best.client.subscriptions.has(convId);
    if (!best || (viewing && !bestViewing) || (viewing === bestViewing && host.attachedAt >= best.attachedAt)) best = host;
  }
  return best;
}

export function attachedClientHost(convId?: string): ClientHostInfo | null {
  return selectHost(convId)?.info ?? null;
}

/** Record a connection's answer to one of its requests. Answers from elsewhere are ignored. */
export function settleClientExec(client: ConnectedClient, result: ClientExecResultCommand): void {
  const exec = pending.get(result.execId);
  if (!exec || exec.host.client !== client) return;
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
    return Promise.resolve({ failure: "No SSH client is connected. client_bash works only while the user's TUI is connected to this daemon with /ssh." });
  }
  if (signal?.aborted) return Promise.resolve({ failure: "Interrupted before the command was sent." });

  const execId = randomUUID();
  return new Promise(resolve => {
    const deadline = setTimeout(() => {
      host.send({ type: "client_exec_cancel", execId });
      finish({ failure: `${describeClientHost(host.info)} did not answer within ${Math.round((request.timeoutMs + RESPONSE_GRACE_MS) / 1000)}s.` });
    }, request.timeoutMs + RESPONSE_GRACE_MS);
    deadline.unref?.();
    const onAbort = () => {
      host.send({ type: "client_exec_cancel", execId });
      finish({ failure: "Interrupted; the command was stopped." });
    };
    function finish(outcome: ClientExecOutcome | { failure: string }): void {
      if (!pending.has(execId)) return;
      pending.delete(execId);
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    }
    pending.set(execId, { host, settle: finish });
    signal?.addEventListener("abort", onAbort, { once: true });
    host.send({ type: "client_exec_request", execId, ...request });
  });
}

function platformName(platform: string): string {
  return platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
}

function noticeText(info: ClientHostInfo | null): string {
  if (!info) {
    return "The user's SSH client machine is no longer connected; client_bash is unavailable until they reconnect with /ssh.";
  }
  return `The user is connected over /ssh from ${describeClientHost(info)} (${platformName(info.platform)}, home ${info.home}). `
    + `client_bash runs commands on that machine; every other tool still runs on ${hostname()}.`;
}

/**
 * The notice to add before a conversation's next message when the machine
 * client_bash reaches has changed since the conversation was last told, else
 * null. Subagents never get client_bash, so they are never told.
 */
export function clientHostNotice(conv: Pick<Conversation, "id" | "messages" | "subagentPolicy">): string | null {
  if (isScopedSubagent(conv)) return null;
  const current = noticeText(attachedClientHost(conv.id));
  let previous: StoredMessage | undefined;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    if (conv.messages[i].metadata?.kind === CLIENT_HOST_NOTICE_KIND) {
      previous = conv.messages[i];
      break;
    }
  }
  if (!previous) return attachedClientHost(conv.id) ? current : null;
  return previous.content === current ? null : current;
}

export function resetClientHostsForTest(): void {
  hosts.clear();
  pending.clear();
}
