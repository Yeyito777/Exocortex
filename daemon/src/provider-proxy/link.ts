/**
 * One SSH link to a remote daemon, shared by every provider proxied to that
 * alias (docs/provider-proxy.md).
 *
 * The link runs `ssh <alias> exocortexd proxy` (the /ssh transport) and speaks
 * the provider-proxy messages over it: a hello that checks the remote supports
 * /proxy, then any number of multiplexed upstream streams, status queries and
 * remote_bash commands. A lost link fails everything in flight at once, like a
 * dropped network connection, and reconnects with backoff.
 *
 * The other way round, the hello names this machine (clientHost), and the
 * remote runs its conversations' client_bash here over the same link
 * (provider_proxy_client_exec): the user's machine stays reachable while its
 * daemon is linked, with or without a TUI. A lost link stops those commands.
 */

import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { appendSshStderr, spawnSshProxy, sshStderrSuffix, type SpawnSshProcess, type SshProcess } from "@exocortex/shared/ssh-transport";
import {
  PROVIDER_PROXY_MAX_REQUEST_BYTES,
  PROVIDER_PROXY_PROTOCOL_VERSION,
  type ProviderProxyDataEvent,
  type ProviderProxyEndEvent,
  type ProviderProxyExecResultEvent,
  type ProviderProxyLinkCommand,
  type ProviderProxyLinkState,
  type ProviderProxyRemoteAccounts,
  type ProviderProxyRemoteStatus,
  type ProviderProxyResponseEvent,
  type ProxyableProviderId,
} from "@exocortex/shared/provider-proxy";
import type { ClientHostInfo } from "@exocortex/shared/protocol";
import { ClientExecutor, ExecLiveness, execStallMessage, localHostInfo } from "@exocortex/shared/command-exec";
import { createAbortError } from "../abort";
import { log } from "../log";

const HELLO_TIMEOUT_MS = 30_000;
const RECONNECT_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
/** An outdated remote is retried rarely: it needs an update first. */
const OUTDATED_RETRY_MS = 5 * 60_000;
/** The upstream must start answering within this long. */
const RESPONSE_HEAD_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** How long past its own timeout a remote_bash command may go unanswered. */
const EXEC_RESPONSE_GRACE_MS = 30_000;
/** Body bytes buffered per HTTP stream before the link stops reading from SSH. */
const STREAM_HIGH_WATER_BYTES = 4 * 1024 * 1024;

/**
 * The link cannot carry a request right now (down, connecting, or closed).
 * `transient` failures (no network, DNS, a dropped or refused connection, the
 * remote daemon briefly away) are worth waiting out; the others (SSH auth or
 * host key, an outdated or refusing remote, a closed link) are not.
 */
export class ProviderProxyUnavailableError extends Error {
  constructor(message: string, readonly transient = true) {
    super(message);
    this.name = "ProviderProxyUnavailableError";
  }
}

export function isTransientProviderProxyError(error: unknown): boolean {
  return error instanceof ProviderProxyUnavailableError && error.transient;
}

/** SSH failures that retrying will not fix: authentication, host keys, configuration, no exocortexd. */
const PERMANENT_SSH_FAILURE = /Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Too many authentication failures|No more authentication methods|Bad configuration option|Bad owner or permissions|command not found|exit 127\b/i;

/** Whether an SSH-level failure of the link (its message, with ssh's stderr) may clear up by itself. */
export function isTransientSshFailure(message: string): boolean {
  return !PERMANENT_SSH_FAILURE.test(message);
}

export interface ProviderProxyHttpRequest {
  provider: ProxyableProviderId;
  method: string;
  target: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface ProviderProxyHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
}

export interface ProviderProxyWebSocketHandlers {
  onMessage(text: string): void;
  onClose(info: { code?: number; reason?: string; error?: string }): void;
}

export type ProviderProxyWebSocketOpenResult =
  | { status: 101; headers: Record<string, string>; send(text: string): void; close(): void }
  | { status: number; headers: Record<string, string>; body: string };

export type ProviderProxyExecOutcome = Omit<ProviderProxyExecResultEvent, "type" | "execId"> & { host: ClientHostInfo };

interface StreamHandler {
  onResponse(event: ProviderProxyResponseEvent): void;
  onData(event: ProviderProxyDataEvent): void;
  onEnd(event: ProviderProxyEndEvent): void;
  onLinkLost(message: string): void;
}

type RequestHandler = (event: { type: string; message?: string } & Record<string, unknown>) => void;

export interface ProviderProxyLinkOptions {
  /** Providers to ask the remote about in the hello. */
  providers: () => ProxyableProviderId[];
  onChange?: () => void;
  /** `remoteAccounts` changed. */
  onAccounts?: () => void;
  spawnProcess?: SpawnSshProcess;
  helloTimeoutMs?: number;
  reconnectDelaysMs?: readonly number[];
  /** This machine as offered to the remote for client_bash; null offers none. Default: localHostInfo(). */
  clientHost?: ClientHostInfo | null;
  /** remote_bash acknowledgement and silence limits (tests). */
  execLiveness?: { ackMs: number; silenceMs: number };
}

function isRemoteAccounts(value: unknown): value is ProviderProxyRemoteAccounts {
  return typeof value === "object" && value !== null && Array.isArray((value as ProviderProxyRemoteAccounts).accounts)
    && typeof (value as ProviderProxyRemoteAccounts).routing === "object" && (value as ProviderProxyRemoteAccounts).routing !== null;
}

export function describeRemoteHost(host: ClientHostInfo | null, alias: string): string {
  return host ? `${host.user ? `${host.user}@` : ""}${host.hostname}` : alias;
}

export class ProviderProxyLink {
  state: ProviderProxyLinkState = "disconnected";
  /** Why the link is down. */
  message: string | undefined;
  host: ClientHostInfo | null = null;
  remote: Partial<Record<ProxyableProviderId, ProviderProxyRemoteStatus>> = {};
  /** What the remote can do beyond protocol v1 (PROVIDER_PROXY_FEATURES), from its last hello. */
  features: string[] = [];
  /**
   * The remote's Claude account pool, kept current while watched; the last one
   * received stays while the link is down. Null until received, or when the
   * remote does not share one (it predates provider_proxy_accounts).
   */
  remoteAccounts: ProviderProxyRemoteAccounts | null = null;

  private process: SshProcess | null = null;
  private generation = 0;
  private stdoutBuffer = "";
  private decoder = new StringDecoder("utf8");
  private stderr = "";
  private closed = false;
  private outdated = false;
  private failedAttempts = 0;
  /** Whether the last failure may clear up by itself (see ProviderProxyUnavailableError). */
  private failureTransient = true;
  /** The connection (generation) watching the remote's accounts, if any. */
  private accountsWatchGeneration: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private attemptWaiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  private readonly requests = new Map<string, RequestHandler>();
  /** remote_bash commands in flight that the remote reports alive (`exec-alive`). */
  private readonly execAlive = new Map<string, () => void>();
  /** The remote's client_bash commands running on this machine. */
  private readonly clientExecutor = new ClientExecutor(undefined, {
    onAlive: execIds => this.trySend({ type: "provider_proxy_client_exec_alive", execIds }),
  });
  private readonly streams = new Map<string, StreamHandler>();
  private readonly blockedStreams = new Set<string>();
  private readonly spawnProcess: SpawnSshProcess;
  private readonly helloTimeoutMs: number;
  private readonly reconnectDelaysMs: readonly number[];

  constructor(readonly alias: string, private readonly options: ProviderProxyLinkOptions) {
    this.spawnProcess = options.spawnProcess ?? spawnSshProxy;
    this.helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  }

  get isClosed(): boolean { return this.closed; }
  get activeStreams(): number { return this.streams.size; }
  /** Whether the link is down for a reason that may clear up by itself. */
  get downTransient(): boolean { return !this.closed && this.failureTransient; }

  /** Connect now unless already connected or connecting. */
  start(): void {
    if (this.closed || this.state !== "disconnected") return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  /**
   * Resolve once the link is up. A link waiting to reconnect tries again now;
   * a failed attempt rejects with its reason instead of waiting for the next.
   */
  waitReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    if (this.closed) return Promise.reject(new ProviderProxyUnavailableError(`The /proxy link to ${this.alias} is closed.`, false));
    if (signal?.aborted) return Promise.reject(createAbortError());
    const ready = new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => { cleanup(); resolve(); },
        reject: (error: Error) => { cleanup(); reject(error); },
      };
      const timer = setTimeout(() => waiter.reject(new ProviderProxyUnavailableError(
        `Timed out after ${Math.round(timeoutMs / 1000)}s connecting to ${this.alias} for /proxy.`,
      )), timeoutMs);
      const onAbort = () => waiter.reject(createAbortError());
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.attemptWaiters.delete(waiter);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.attemptWaiters.add(waiter);
    });
    // Wait first: an attempt can fail before start() returns.
    this.start();
    return ready;
  }

  /** Stop for good: fail everything in flight and never reconnect. */
  close(reason = "The /proxy link was closed."): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardown(this.generation, reason, { reconnect: false, transient: false });
    for (const waiter of [...this.attemptWaiters]) waiter.reject(new ProviderProxyUnavailableError(reason, false));
  }

  // ── Requests ────────────────────────────────────────────────────

  openHttp(request: ProviderProxyHttpRequest, signal?: AbortSignal): Promise<ProviderProxyHttpResponse> {
    if (!this.isConnected()) return Promise.reject(this.unavailable());
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (request.body && request.body.byteLength > PROVIDER_PROXY_MAX_REQUEST_BYTES) {
      return Promise.reject(new Error(`Request body is ${request.body.byteLength} bytes; /proxy carries at most ${PROVIDER_PROXY_MAX_REQUEST_BYTES}.`));
    }
    const streamId = randomUUID();
    return new Promise((resolve, reject) => {
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let finished = false;
      const headTimer = setTimeout(() => fail(new Error(`${this.alias} did not answer the proxied request within ${RESPONSE_HEAD_TIMEOUT_MS / 1000}s.`), true), RESPONSE_HEAD_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(headTimer);
        signal?.removeEventListener("abort", onAbort);
        this.streams.delete(streamId);
        this.unblock(streamId);
      };
      const fail = (error: Error, cancelRemote: boolean) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (cancelRemote) this.trySend({ type: "provider_proxy_cancel", streamId });
        if (controller) {
          try { controller.error(error); } catch { /* already closed */ }
        } else {
          reject(error);
        }
      };
      const onAbort = () => fail(createAbortError(), true);
      this.streams.set(streamId, {
        onResponse: (event) => {
          if (controller || finished) return;
          clearTimeout(headTimer);
          const body = new ReadableStream<Uint8Array>({
            start: (c) => { controller = c; },
            pull: () => { this.unblock(streamId); },
            cancel: () => {
              if (finished) return;
              finished = true;
              cleanup();
              this.trySend({ type: "provider_proxy_cancel", streamId });
            },
          }, new ByteLengthQueuingStrategy({ highWaterMark: STREAM_HIGH_WATER_BYTES }));
          resolve({ status: event.status, headers: event.headers ?? {}, body });
        },
        onData: (event) => {
          if (!controller || finished || typeof event.data !== "string") return;
          controller.enqueue(new Uint8Array(Buffer.from(event.data, "base64")));
          if ((controller.desiredSize ?? 1) <= 0) this.block(streamId);
        },
        onEnd: (event) => {
          if (finished) return;
          if (!controller) {
            fail(new Error(event.error ?? `${this.alias} ended the proxied request without a response.`), false);
            return;
          }
          if (event.error) {
            fail(new Error(event.error), false);
            return;
          }
          finished = true;
          cleanup();
          try { controller.close(); } catch { /* already closed */ }
        },
        onLinkLost: (message) => fail(new ProviderProxyUnavailableError(message, this.downTransient), false),
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.send({
        type: "provider_proxy_open",
        streamId,
        provider: request.provider,
        kind: "http",
        method: request.method,
        target: request.target,
        headers: request.headers,
        ...(request.body && request.body.byteLength > 0 ? { body: Buffer.from(request.body).toString("base64") } : {}),
      });
    });
  }

  openWebSocket(
    request: Omit<ProviderProxyHttpRequest, "method" | "body">,
    handlers: ProviderProxyWebSocketHandlers,
    signal?: AbortSignal,
  ): Promise<ProviderProxyWebSocketOpenResult> {
    if (!this.isConnected()) return Promise.reject(this.unavailable());
    if (signal?.aborted) return Promise.reject(createAbortError());
    const streamId = randomUUID();
    return new Promise((resolve, reject) => {
      let opened = false;
      let headed: ProviderProxyResponseEvent | null = null;
      let finished = false;
      const body: Buffer[] = [];
      const headTimer = setTimeout(() => fail(new Error(`${this.alias} did not answer the proxied websocket within ${RESPONSE_HEAD_TIMEOUT_MS / 1000}s.`)), RESPONSE_HEAD_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(headTimer);
        signal?.removeEventListener("abort", onAbort);
        this.streams.delete(streamId);
      };
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        this.trySend({ type: "provider_proxy_cancel", streamId });
        reject(error);
      };
      const onAbort = () => fail(createAbortError());
      this.streams.set(streamId, {
        onResponse: (event) => {
          if (headed || finished) return;
          headed = event;
          clearTimeout(headTimer);
          if (event.status !== 101) return;
          opened = true;
          // Once open, the socket's owner decides when it ends, not the open call's signal.
          signal?.removeEventListener("abort", onAbort);
          resolve({
            status: 101,
            headers: event.headers ?? {},
            send: (text) => {
              if (finished) return;
              if (Buffer.byteLength(text) > PROVIDER_PROXY_MAX_REQUEST_BYTES) {
                throw new Error(`Websocket message exceeds the /proxy limit of ${PROVIDER_PROXY_MAX_REQUEST_BYTES} bytes.`);
              }
              this.send({ type: "provider_proxy_ws_send", streamId, text });
            },
            close: () => {
              if (finished) return;
              finished = true;
              cleanup();
              this.trySend({ type: "provider_proxy_cancel", streamId });
            },
          });
        },
        onData: (event) => {
          if (finished) return;
          if (opened) {
            if (typeof event.text === "string") handlers.onMessage(event.text);
          } else if (typeof event.data === "string") {
            body.push(Buffer.from(event.data, "base64"));
          }
        },
        onEnd: (event) => {
          if (finished) return;
          if (opened) {
            finished = true;
            cleanup();
            handlers.onClose({ code: event.closeCode, reason: event.closeReason, error: event.error });
            return;
          }
          if (headed) {
            finished = true;
            cleanup();
            resolve({ status: headed.status, headers: headed.headers ?? {}, body: Buffer.concat(body).toString("utf8") });
            return;
          }
          fail(new Error(event.error ?? `${this.alias} ended the proxied websocket without a response.`));
        },
        onLinkLost: (message) => {
          if (finished) return;
          if (opened) {
            finished = true;
            cleanup();
            handlers.onClose({ error: message });
          } else {
            fail(new ProviderProxyUnavailableError(message, this.downTransient));
          }
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.send({
        type: "provider_proxy_open",
        streamId,
        provider: request.provider,
        kind: "websocket",
        method: "GET",
        target: request.target,
        headers: request.headers,
      });
    });
  }

  /** The remote's login and usage for `provider` (and refresh the cached copy). */
  async status(provider: ProxyableProviderId, refreshUsage = false): Promise<ProviderProxyRemoteStatus> {
    const event = await this.request({ type: "provider_proxy_status", reqId: randomUUID(), provider, refreshUsage }, "provider_proxy_status_result");
    const status = event.status as ProviderProxyRemoteStatus;
    this.remote[provider] = status;
    return status;
  }

  async consumeReset(provider: ProxyableProviderId): Promise<{ outcome: string; windowsReset: number; remainingResets?: number }> {
    const event = await this.request({ type: "provider_proxy_consume_reset", reqId: randomUUID(), provider }, "provider_proxy_consume_reset_result");
    if (typeof event.error === "string") throw new Error(event.error);
    return event.result as { outcome: string; windowsReset: number; remainingResets?: number };
  }

  /**
   * Receive the remote's Claude pool now and whenever it changes, for this
   * connection (a reconnect watches again). `watch = false` stops. A remote
   * without provider_proxy_accounts leaves `remoteAccounts` null.
   */
  watchAccounts(watch = true): void {
    if (!this.isConnected()) return;
    const generation = this.generation;
    if (watch === (this.accountsWatchGeneration === generation)) return;
    this.accountsWatchGeneration = watch ? generation : null;
    if (!watch) {
      this.trySend({ type: "provider_proxy_accounts", reqId: randomUUID(), provider: "anthropic", watch: false });
      return;
    }
    this.request({ type: "provider_proxy_accounts", reqId: randomUUID(), provider: "anthropic", watch: true }, "provider_proxy_accounts_result")
      .then((event) => {
        if (generation !== this.generation || this.accountsWatchGeneration !== generation) return;
        this.setRemoteAccounts(event.accounts);
        // Have the remote check sign-ins and usage it has not looked at lately; the changes arrive as updates.
        if (this.remoteAccounts) void this.status("anthropic", true).catch(() => {});
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        if (this.accountsWatchGeneration === generation) this.accountsWatchGeneration = null;
        const message = error instanceof Error ? error.message : String(error);
        if (/^Unknown command: provider_proxy_accounts/.test(message)) {
          log("info", `provider-proxy: ${this.alias} does not share its Claude accounts (older Exocortex); showing its main account only`);
          this.setRemoteAccounts(null);
        } else {
          log("warn", `provider-proxy: watching ${this.alias}'s Claude accounts failed: ${message}`);
        }
      });
  }

  private setRemoteAccounts(accounts: unknown): void {
    const next = isRemoteAccounts(accounts) ? accounts : null;
    if (next === null && this.remoteAccounts === null) return;
    this.remoteAccounts = next;
    this.options.onAccounts?.();
  }

  /** remote_bash: run a command on the remote machine. Never rejects. */
  exec(request: { command: string; cwd?: string; timeoutMs: number }, signal?: AbortSignal): Promise<ProviderProxyExecOutcome | { failure: string }> {
    if (this.state !== "connected" || !this.host) {
      return Promise.resolve({ failure: this.downMessage() });
    }
    if (signal?.aborted) return Promise.resolve({ failure: "Interrupted before the command was sent." });
    const host = this.host;
    const execId = randomUUID();
    const reportsAlive = this.features.includes("exec-alive");
    return new Promise(resolve => {
      let finished = false;
      const finish = (outcome: ProviderProxyExecOutcome | { failure: string }) => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        liveness?.stop();
        signal?.removeEventListener("abort", onAbort);
        this.requests.delete(execId);
        this.execAlive.delete(execId);
        resolve(outcome);
      };
      // A remote that acknowledges commands fails a frozen or vanished link fast.
      const liveness = reportsAlive ? new ExecLiveness((phase, afterMs) => {
        this.trySend({ type: "provider_proxy_exec_cancel", execId });
        finish({ failure: execStallMessage(`${describeRemoteHost(host, this.alias)} (/proxy link to ${this.alias})`, phase, afterMs) });
      }, this.options.execLiveness?.ackMs, this.options.execLiveness?.silenceMs) : null;
      if (liveness) this.execAlive.set(execId, () => liveness.heard());
      const deadline = setTimeout(() => {
        this.trySend({ type: "provider_proxy_exec_cancel", execId });
        finish({ failure: `${describeRemoteHost(host, this.alias)} did not answer within ${Math.round((request.timeoutMs + EXEC_RESPONSE_GRACE_MS) / 1000)}s.` });
      }, request.timeoutMs + EXEC_RESPONSE_GRACE_MS);
      deadline.unref?.();
      const onAbort = () => {
        this.trySend({ type: "provider_proxy_exec_cancel", execId });
        finish({ failure: "Interrupted; the command was stopped." });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.requests.set(execId, (event) => {
        if (event.type === "provider_proxy_exec_result") {
          const result = event as unknown as ProviderProxyExecResultEvent;
          finish({
            host,
            output: typeof result.output === "string" ? result.output : "",
            byteTruncated: result.byteTruncated === true,
            exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
            signal: typeof result.signal === "string" ? result.signal : null,
            timedOut: result.timedOut === true,
            ...(typeof result.error === "string" && result.error ? { error: result.error } : {}),
          });
        } else {
          finish({ failure: event.message ?? "The remote could not run the command." });
        }
      });
      this.send({ type: "provider_proxy_exec", execId, command: request.command, ...(request.cwd ? { cwd: request.cwd } : {}), timeoutMs: request.timeoutMs });
    });
  }

  /** Why requests cannot go through right now. */
  downMessage(): string {
    if (this.state === "connected") return "";
    if (this.state === "connecting") return `Still connecting to ${this.alias} for /proxy.`;
    return this.message ?? `The /proxy link to ${this.alias} is down.`;
  }

  private unavailable(): ProviderProxyUnavailableError {
    return new ProviderProxyUnavailableError(this.downMessage(), this.state === "connecting" || this.downTransient);
  }

  // ── Connection ──────────────────────────────────────────────────

  private connect(): void {
    const generation = ++this.generation;
    this.state = "connecting";
    this.message = undefined;
    this.stdoutBuffer = "";
    this.decoder = new StringDecoder("utf8");
    this.stderr = "";
    this.options.onChange?.();

    let process: SshProcess;
    try {
      process = this.spawnProcess(this.alias);
    } catch (error) {
      this.teardown(generation, `Could not start ssh for ${this.alias}: ${error instanceof Error ? error.message : String(error)}`, { transient: false });
      return;
    }
    this.process = process;
    process.stdout.on("data", (chunk: Buffer | string) => this.onStdout(generation, chunk));
    process.stderr.on("data", (chunk: Buffer | string) => { this.stderr = appendSshStderr(this.stderr, chunk); });
    process.once("error", (error: Error) => {
      const message = `ssh to ${this.alias} failed: ${error.message}${sshStderrSuffix(this.stderr)}`;
      // ENOENT: no ssh binary at all.
      this.teardown(generation, message, { transient: (error as NodeJS.ErrnoException).code !== "ENOENT" && isTransientSshFailure(message) });
    });
    process.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const result = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
      const wasConnected = this.state === "connected" && this.generation === generation;
      const message = wasConnected
        ? `The SSH connection to ${this.alias} was lost (${result})${sshStderrSuffix(this.stderr)}.`
        : `Could not reach the Exocortex daemon on ${this.alias} over SSH (${result})${sshStderrSuffix(this.stderr)}.`;
      this.teardown(generation, message, { transient: isTransientSshFailure(message) });
    });
    process.stdin.on("error", () => { /* the close handler reports it */ });

    const reqId = randomUUID();
    this.helloTimer = setTimeout(() => this.teardown(generation, `Timed out after ${Math.round(this.helloTimeoutMs / 1000)}s waiting for the Exocortex daemon on ${this.alias}${sshStderrSuffix(this.stderr)}.`), this.helloTimeoutMs);
    this.requests.set(reqId, (event) => {
      if (generation !== this.generation) return;
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = null;
      if (event.type === "error") {
        const message = String(event.message ?? "");
        if (/^Unknown command: provider_proxy/.test(message)) {
          this.outdated = true;
          this.teardown(generation, `The Exocortex daemon on ${this.alias} does not support /proxy; update Exocortex there (git pull, then exocortexd restart).`, { transient: false });
        } else {
          this.teardown(generation, `The Exocortex daemon on ${this.alias} refused /proxy: ${message}`, { transient: false });
        }
        return;
      }
      const version = typeof event.version === "number" ? event.version : 0;
      if (version !== PROVIDER_PROXY_PROTOCOL_VERSION) {
        this.outdated = version < PROVIDER_PROXY_PROTOCOL_VERSION;
        this.teardown(generation, version < PROVIDER_PROXY_PROTOCOL_VERSION
          ? `The Exocortex daemon on ${this.alias} speaks an older /proxy protocol (v${version}); update Exocortex there.`
          : `The Exocortex daemon on ${this.alias} speaks a newer /proxy protocol (v${version}); update Exocortex here.`, { transient: false });
        return;
      }
      this.requests.delete(reqId);
      this.outdated = false;
      this.failedAttempts = 0;
      this.failureTransient = true;
      this.host = (event.host as ClientHostInfo | undefined) ?? null;
      this.remote = (event.providers as ProviderProxyLink["remote"] | undefined) ?? {};
      this.features = Array.isArray(event.features) ? event.features.filter((feature): feature is string => typeof feature === "string") : [];
      this.state = "connected";
      this.message = undefined;
      log("info", `provider-proxy: connected to ${this.alias} (${describeRemoteHost(this.host, this.alias)})`);
      for (const waiter of [...this.attemptWaiters]) waiter.resolve();
      this.options.onChange?.();
      if (this.options.providers().includes("anthropic")) this.watchAccounts();
    });
    const clientHost = this.options.clientHost === undefined ? localHostInfo() : this.options.clientHost;
    this.send({
      type: "provider_proxy_hello",
      reqId,
      version: PROVIDER_PROXY_PROTOCOL_VERSION,
      providers: this.options.providers(),
      ...(clientHost ? { clientHost } : {}),
    });
  }

  private teardown(generation: number, message: string, options: { reconnect?: boolean; transient?: boolean } = {}): void {
    if (generation !== this.generation) return;
    // Later events from the dead process are ignored.
    this.generation++;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    const process = this.process;
    this.process = null;
    if (process) {
      try { process.stdin.end(); } catch { /* already closed */ }
      try { process.kill(); } catch { /* already gone */ }
    }
    const wasConnected = this.state === "connected";
    this.state = "disconnected";
    this.message = message;
    this.failureTransient = options.transient ?? true;
    this.blockedStreams.clear();
    for (const stream of [...this.streams.values()]) stream.onLinkLost(message);
    this.streams.clear();
    for (const handler of [...this.requests.values()]) handler({ type: "error", message });
    this.requests.clear();
    this.execAlive.clear();
    // Like a TUI that disconnects: the remote has already failed these calls.
    this.clientExecutor.cancelAll();
    for (const waiter of [...this.attemptWaiters]) waiter.reject(new ProviderProxyUnavailableError(message, this.failureTransient));
    log(wasConnected ? "warn" : "info", `provider-proxy: ${message}`);
    if (!this.closed && options.reconnect !== false) this.scheduleReconnect();
    this.options.onChange?.();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.outdated
      ? OUTDATED_RETRY_MS
      : this.reconnectDelaysMs[Math.min(this.failedAttempts, this.reconnectDelaysMs.length - 1)];
    this.failedAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed && this.state === "disconnected") this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private onStdout(generation: number, chunk: Buffer | string): void {
    if (generation !== this.generation) return;
    this.stdoutBuffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let event: { type?: unknown } & Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        log("warn", `provider-proxy: ignoring non-protocol output from ${this.alias}: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(event);
      if (generation !== this.generation) return;
    }
  }

  private dispatch(event: { type?: unknown } & Record<string, unknown>): void {
    switch (event.type) {
      case "provider_proxy_response":
        this.streams.get(String(event.streamId))?.onResponse(event as unknown as ProviderProxyResponseEvent);
        return;
      case "provider_proxy_data":
        this.streams.get(String(event.streamId))?.onData(event as unknown as ProviderProxyDataEvent);
        return;
      case "provider_proxy_end":
        this.streams.get(String(event.streamId))?.onEnd(event as unknown as ProviderProxyEndEvent);
        return;
      case "provider_proxy_exec_result":
        this.requests.get(String(event.execId))?.(event as never);
        return;
      case "provider_proxy_exec_alive":
        if (Array.isArray(event.execIds)) for (const execId of event.execIds) this.execAlive.get(String(execId))?.();
        return;
      case "provider_proxy_client_exec": {
        const execId = typeof event.execId === "string" ? event.execId : "";
        if (!execId) return;
        this.clientExecutor.run({
          execId,
          command: String(event.command ?? ""),
          cwd: typeof event.cwd === "string" ? event.cwd : undefined,
          timeoutMs: Math.max(1, Number(event.timeoutMs) || 0),
        }, outcome => this.trySend({ type: "provider_proxy_client_exec_result", execId, ...outcome }));
        return;
      }
      case "provider_proxy_client_exec_cancel":
        this.clientExecutor.cancel(String(event.execId));
        return;
      case "provider_proxy_accounts_update":
        if (this.accountsWatchGeneration === this.generation) this.setRemoteAccounts(event.accounts);
        return;
      case "provider_proxy_hello_result":
      case "provider_proxy_status_result":
      case "provider_proxy_consume_reset_result":
      case "provider_proxy_accounts_result":
      case "error": {
        const reqId = typeof event.reqId === "string" ? event.reqId : null;
        const handler = reqId ? this.requests.get(reqId) : undefined;
        if (handler) handler(event as never);
        else if (event.type === "error") log("warn", `provider-proxy: ${this.alias}: ${String(event.message)}`);
        return;
      }
      default:
        return;
    }
  }

  private request(command: ProviderProxyLinkCommand & { reqId: string }, resultType: string): Promise<Record<string, unknown>> {
    if (!this.isConnected()) return Promise.reject(this.unavailable());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(command.reqId);
        reject(new Error(`${this.alias} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`));
      }, REQUEST_TIMEOUT_MS);
      this.requests.set(command.reqId, (event) => {
        clearTimeout(timer);
        this.requests.delete(command.reqId);
        if (event.type === resultType) resolve(event);
        else reject(new Error(event.message ?? `${this.alias} refused the request.`));
      });
      this.send(command);
    });
  }

  private isConnected(): boolean {
    return this.state === "connected" && this.process !== null;
  }

  private send(command: ProviderProxyLinkCommand): void {
    const process = this.process;
    if (!process) throw this.unavailable();
    process.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private trySend(command: ProviderProxyLinkCommand): void {
    try { this.send(command); } catch { /* the link is gone; so is the stream */ }
  }

  private block(streamId: string): void {
    if (this.blockedStreams.has(streamId)) return;
    this.blockedStreams.add(streamId);
    this.process?.stdout.pause();
  }

  private unblock(streamId: string): void {
    if (!this.blockedStreams.delete(streamId)) return;
    if (this.blockedStreams.size === 0) this.process?.stdout.resume();
  }
}
