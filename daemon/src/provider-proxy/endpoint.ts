/**
 * The remote end of a /proxy link: one per `exocortexd proxy` connection that
 * said provider_proxy_hello (docs/provider-proxy.md).
 *
 * It makes only allowlisted upstream requests, replaces whatever credentials
 * the link sent with this daemon's own, and streams the answer back. Writing
 * waits while the connection is backed up, and a closed connection aborts
 * everything it started.
 */

import { hostname, homedir, userInfo } from "node:os";
import { ClientExecutor } from "@exocortex/shared/command-exec";
import {
  PROVIDER_PROXY_ACCOUNT_MOVE_HEADER,
  PROVIDER_PROXY_CONVERSATION_HEADER,
  PROVIDER_PROXY_FEATURES,
  PROVIDER_PROXY_MAX_REQUEST_BYTES,
  PROVIDER_PROXY_PROTOCOL_VERSION,
  isProxyableProvider,
  matchProviderProxyRoute,
  providerProxyRequestHeaders,
  providerProxyResponseHeaders,
  type ProviderProxyHelloCommand,
  type ProviderProxyLinkCommand,
  type ProviderProxyLinkEvent,
  type ProviderProxyOpenCommand,
  type ProviderProxyRemoteStatus,
  type ProxyableProviderId,
} from "@exocortex/shared/provider-proxy";
import type { ErrorEvent } from "@exocortex/shared/protocol";
import { connectOpenAIWebSocket, OpenAIWebSocketHttpError, type OpenAIWebSocketConnectResult } from "../providers/openai/websocket";
import { log } from "../log";
import { localUpstreamAuth, UpstreamAuthError, type UpstreamAuth } from "./upstream-auth";
import type { RemoteAccountsSource } from "./remote-accounts";
import { proxiedConversationKey, type ProxiedClaudeLease, type ProxiedClaudeRouter } from "./claude-routing";

/** A proxied websocket may sit idle this long between messages. */
const WEBSOCKET_IDLE_MS = 2 * 60 * 60_000;
const HELLO_STATUS_TIMEOUT_MS = 20_000;
const MAX_EXEC_TIMEOUT_MS = 24 * 60 * 60_000;
/** Pool changes come in bursts (a turn's start, its usage, its end); one update per burst. */
const ACCOUNTS_PUSH_DELAY_MS = 250;

export interface ProviderProxyEndpointTransport {
  send(event: ProviderProxyLinkEvent | ErrorEvent): void;
  /** True while the connection's write buffer is over its high-water mark. */
  needsDrain(): boolean;
  /** Resolves once the buffer drains or the connection closes. */
  waitDrain(): Promise<void>;
}

export interface ProviderProxyEndpointDeps {
  auth?: UpstreamAuth;
  fetch?: typeof fetch;
  connectWebSocket?: (url: string, headers: Record<string, string>, signal?: AbortSignal) => Promise<OpenAIWebSocketConnectResult>;
  /** The Claude pool shared with provider_proxy_accounts; without it the command reports none. */
  accounts?: RemoteAccountsSource;
  /** Picks the Claude account for each proxied request; without it every request uses `main`. */
  claudeRouter?: ProxiedClaudeRouter;
}

interface OpenStream {
  abort: AbortController;
  sendText?: (text: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A provider-shaped JSON error body, so clients show the message as they would the API's own. */
function errorBody(provider: ProxyableProviderId, status: number, message: string): string {
  return provider === "anthropic"
    ? JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message } })
    : JSON.stringify({ error: { type: status === 401 ? "authentication_error" : "proxy_error", message } });
}

export class ProviderProxyEndpoint {
  private readonly streams = new Map<string, OpenStream>();
  private readonly executor = new ClientExecutor();
  private closed = false;
  private readonly auth: UpstreamAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly connectWebSocket: NonNullable<ProviderProxyEndpointDeps["connectWebSocket"]>;
  private readonly accounts: RemoteAccountsSource | null;
  private readonly claudeRouter: ProxiedClaudeRouter | null;
  private accountsWatch: { unsubscribe: () => void; timer: ReturnType<typeof setTimeout> | null; last: string } | null = null;

  constructor(private readonly transport: ProviderProxyEndpointTransport, deps: ProviderProxyEndpointDeps = {}) {
    this.auth = deps.auth ?? localUpstreamAuth;
    this.fetchImpl = deps.fetch ?? fetch;
    this.connectWebSocket = deps.connectWebSocket ?? connectOpenAIWebSocket;
    this.accounts = deps.accounts ?? null;
    this.claudeRouter = deps.claudeRouter ?? null;
  }

  /** The connection closed: stop every upstream request and command it started. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams.values()) stream.abort.abort();
    this.streams.clear();
    this.executor.cancelAll();
    this.unwatchAccounts();
  }

  handle(command: ProviderProxyLinkCommand): void {
    if (this.closed) return;
    switch (command.type) {
      case "provider_proxy_hello":
        void this.hello(command);
        return;
      case "provider_proxy_open":
        if (this.streams.has(command.streamId)) return;
        if (command.kind === "websocket") void this.openWebSocket(command);
        else void this.openHttp(command);
        return;
      case "provider_proxy_ws_send":
        this.streams.get(command.streamId)?.sendText?.(typeof command.text === "string" ? command.text : "");
        return;
      case "provider_proxy_cancel":
        this.streams.get(command.streamId)?.abort.abort();
        return;
      case "provider_proxy_status":
        void this.status(command.reqId, command.provider, command.refreshUsage === true);
        return;
      case "provider_proxy_consume_reset":
        void this.consumeReset(command.reqId, command.provider);
        return;
      case "provider_proxy_accounts":
        this.handleAccounts(command.reqId, command.provider, command.watch);
        return;
      case "provider_proxy_exec": {
        const execId = command.execId;
        const timeoutMs = Math.min(MAX_EXEC_TIMEOUT_MS, Math.max(1, Number(command.timeoutMs) || 0));
        this.executor.run({ execId, command: String(command.command ?? ""), cwd: command.cwd, timeoutMs }, outcome => {
          if (!this.closed) this.transport.send({ type: "provider_proxy_exec_result", execId, ...outcome });
        });
        return;
      }
      case "provider_proxy_exec_cancel":
        this.executor.cancel(command.execId);
        return;
    }
  }

  private async hello(command: ProviderProxyHelloCommand): Promise<void> {
    const requested = Array.isArray(command.providers) ? command.providers.filter(isProxyableProvider) : [];
    const entries = await Promise.all(requested.map(async provider => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const status = await Promise.race([
        this.auth.status(provider),
        new Promise<ProviderProxyRemoteStatus>(resolve => {
          timer = setTimeout(() => resolve({ loggedIn: false, error: "Checking the login timed out.", authInfo: null, accountScope: null, usage: null }), HELLO_STATUS_TIMEOUT_MS);
        }),
      ]).catch((error: unknown): ProviderProxyRemoteStatus => ({ loggedIn: false, error: errorMessage(error), authInfo: null, accountScope: null, usage: null }));
      clearTimeout(timer);
      return [provider, status] as const;
    }));
    if (this.closed) return;
    let user = "";
    try { user = userInfo().username; } catch { /* unknown */ }
    this.transport.send({
      type: "provider_proxy_hello_result",
      reqId: command.reqId,
      version: PROVIDER_PROXY_PROTOCOL_VERSION,
      host: { hostname: hostname(), user, platform: process.platform, home: homedir() },
      providers: Object.fromEntries(entries),
      features: [...PROVIDER_PROXY_FEATURES],
    });
  }

  private async status(reqId: string, provider: unknown, refreshUsage: boolean): Promise<void> {
    if (!isProxyableProvider(provider)) {
      this.transport.send({ type: "error", reqId, message: `Unknown /proxy provider: ${String(provider)}` });
      return;
    }
    try {
      const status = await this.auth.status(provider, { refreshUsage });
      if (!this.closed) this.transport.send({ type: "provider_proxy_status_result", reqId, provider, status });
    } catch (error) {
      if (!this.closed) this.transport.send({ type: "error", reqId, message: errorMessage(error) });
    }
  }

  private async consumeReset(reqId: string, provider: unknown): Promise<void> {
    if (!isProxyableProvider(provider)) {
      this.transport.send({ type: "provider_proxy_consume_reset_result", reqId, error: `Unknown /proxy provider: ${String(provider)}` });
      return;
    }
    try {
      const result = await this.auth.consumeReset(provider);
      if (!this.closed) this.transport.send({ type: "provider_proxy_consume_reset_result", reqId, result });
    } catch (error) {
      if (!this.closed) this.transport.send({ type: "provider_proxy_consume_reset_result", reqId, error: errorMessage(error) });
    }
  }

  private accountsSnapshot() {
    try {
      return this.accounts?.snapshot() ?? null;
    } catch (error) {
      log("warn", `provider-proxy endpoint: reading the Claude accounts failed: ${errorMessage(error)}`);
      return null;
    }
  }

  private handleAccounts(reqId: string, provider: unknown, watch: unknown): void {
    if (provider !== "anthropic") {
      this.transport.send({ type: "error", reqId, message: `No account pool to share for ${String(provider)}.` });
      return;
    }
    const accounts = this.accountsSnapshot();
    this.transport.send({ type: "provider_proxy_accounts_result", reqId, provider, accounts });
    if (watch === false) {
      this.unwatchAccounts();
    } else if (watch === true && this.accounts && !this.accountsWatch) {
      const watching = { unsubscribe: () => {}, timer: null as ReturnType<typeof setTimeout> | null, last: JSON.stringify(accounts) };
      const push = () => {
        watching.timer = null;
        if (this.closed || this.accountsWatch !== watching) return;
        const next = this.accountsSnapshot();
        const serialized = JSON.stringify(next);
        if (serialized === watching.last) return;
        watching.last = serialized;
        this.transport.send({ type: "provider_proxy_accounts_update", provider: "anthropic", accounts: next });
      };
      watching.unsubscribe = this.accounts.subscribe(() => {
        if (watching.timer || this.accountsWatch !== watching) return;
        watching.timer = setTimeout(push, ACCOUNTS_PUSH_DELAY_MS);
        (watching.timer as { unref?: () => void }).unref?.();
      });
      this.accountsWatch = watching;
    }
  }

  private unwatchAccounts(): void {
    const watching = this.accountsWatch;
    if (!watching) return;
    this.accountsWatch = null;
    watching.unsubscribe();
    if (watching.timer) clearTimeout(watching.timer);
  }

  /** Validate an open command; on refusal, end the stream with the reason. */
  private admit(command: ProviderProxyOpenCommand): { url: string; provider: ProxyableProviderId } | null {
    const refuse = (message: string) => {
      log("warn", `provider-proxy endpoint: refused ${String(command.provider)} ${String(command.kind)} ${String(command.method)} ${String(command.target).split("?")[0]}: ${message}`);
      this.transport.send({ type: "provider_proxy_end", streamId: command.streamId, error: message });
      return null;
    };
    if (!isProxyableProvider(command.provider)) return refuse(`Unknown /proxy provider: ${String(command.provider)}`);
    const matched = matchProviderProxyRoute(command.provider, command.kind === "websocket" ? "websocket" : "http", String(command.method), String(command.target));
    if ("error" in matched) return refuse(`Refused by ${hostname()}: ${matched.error}.`);
    if (command.body !== undefined && (typeof command.body !== "string" || command.body.length > Math.ceil(PROVIDER_PROXY_MAX_REQUEST_BYTES / 3) * 4 + 4)) {
      return refuse(`Request body exceeds the /proxy limit of ${PROVIDER_PROXY_MAX_REQUEST_BYTES} bytes.`);
    }
    return { provider: command.provider, url: `${this.auth.origin(command.provider)}${matched.path}${matched.search}` };
  }

  private respondError(streamId: string, provider: ProxyableProviderId, status: number, message: string): void {
    this.transport.send({ type: "provider_proxy_response", streamId, status, headers: { "content-type": "application/json" } });
    this.transport.send({ type: "provider_proxy_data", streamId, data: Buffer.from(errorBody(provider, status, message)).toString("base64") });
    this.transport.send({ type: "provider_proxy_end", streamId });
  }

  private async openHttp(command: ProviderProxyOpenCommand): Promise<void> {
    const admitted = this.admit(command);
    if (!admitted) return;
    const { provider, url } = admitted;
    const { streamId } = command;
    const abort = new AbortController();
    this.streams.set(streamId, { abort });
    const clientHeaders = providerProxyRequestHeaders(Object.entries(command.headers ?? {}));
    // Which conversation the request belongs to is for routing here, never for the upstream.
    const conversation = proxiedConversationKey(clientHeaders[PROVIDER_PROXY_CONVERSATION_HEADER]);
    delete clientHeaders[PROVIDER_PROXY_CONVERSATION_HEADER];
    const body = command.body ? Buffer.from(command.body, "base64") : undefined;
    const router = provider === "anthropic" ? this.claudeRouter : null;
    let lease: ProxiedClaudeLease | null = null;
    try {
      let response: Response;
      let authRetried = false;
      let limitRetried = false;
      for (;;) {
        lease ??= router ? await router.lease(conversation, abort.signal) : null;
        let authHeaders: Record<string, string>;
        try {
          authHeaders = await this.auth.headers(provider, url, { afterRejection: authRetried, clientHeaders, ...(lease ? { account: lease.account } : {}) });
        } catch (error) {
          if (!(error instanceof UpstreamAuthError)) throw error;
          if (lease && !limitRetried) {
            // This account cannot sign the request: keep it out of routing and try the pool again once.
            lease.authFailed(error.message);
            const failed = lease.account;
            lease.release();
            lease = await router!.lease(conversation, abort.signal);
            limitRetried = true;
            authRetried = false;
            if (lease.account !== failed) continue;
          }
          if (!this.closed) this.respondError(streamId, provider, 401, `${hostname()}: ${error.message}`);
          return;
        }
        response = await this.fetchImpl(url, {
          method: command.method.toUpperCase(),
          headers: { ...clientHeaders, ...authHeaders },
          ...(body ? { body } : {}),
          signal: abort.signal,
          // Never follow a redirect to a host outside the allowlist.
          redirect: "manual",
        });
        this.auth.observeResponse?.(provider, url, response.headers);
        const refused = lease?.observe(response.status, response.headers) ?? false;
        if (response.status === 401 && !authRetried) {
          authRetried = true;
          await response.body?.cancel().catch(() => {});
          continue;
        }
        if (refused && router && lease && !limitRetried) {
          // At a usage limit: the account is now marked limited, so routing again moves the conversation if another account can take it.
          limitRetried = true;
          const limited = lease.account;
          lease.release();
          lease = await router.lease(conversation, abort.signal);
          if (lease.account !== limited) {
            authRetried = false;
            await response.body?.cancel().catch(() => {});
            continue;
          }
        }
        break;
      }
      if (this.closed) return;
      const responseHeaders = providerProxyResponseHeaders(response.headers.entries());
      if (lease?.moved) {
        // The client announces the move in its conversation, as this daemon does for its own.
        responseHeaders[PROVIDER_PROXY_ACCOUNT_MOVE_HEADER] = encodeURIComponent(JSON.stringify({ from: lease.moved.from, to: lease.account, detail: lease.moved.detail }));
      }
      this.transport.send({ type: "provider_proxy_response", streamId, status: response.status, headers: responseHeaders });
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done || this.closed) break;
            if (value && value.byteLength > 0) {
              this.transport.send({ type: "provider_proxy_data", streamId, data: Buffer.from(value).toString("base64") });
              if (this.transport.needsDrain()) await this.transport.waitDrain();
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      if (!this.closed) this.transport.send({ type: "provider_proxy_end", streamId, ...(abort.signal.aborted ? { error: "Cancelled." } : {}) });
    } catch (error) {
      if (!this.closed) this.transport.send({ type: "provider_proxy_end", streamId, error: abort.signal.aborted ? "Cancelled." : `${hostname()}: ${errorMessage(error)}` });
    } finally {
      lease?.release();
      this.streams.delete(streamId);
    }
  }

  private async openWebSocket(command: ProviderProxyOpenCommand): Promise<void> {
    const admitted = this.admit(command);
    if (!admitted) return;
    const { provider } = admitted;
    const url = admitted.url.replace(/^http/, "ws");
    const { streamId } = command;
    const abort = new AbortController();
    const stream: OpenStream = { abort };
    this.streams.set(streamId, stream);
    const clientHeaders = providerProxyRequestHeaders(Object.entries(command.headers ?? {}));
    try {
      let connection: OpenAIWebSocketConnectResult | null = null;
      for (let attempt = 0; !connection; attempt++) {
        let authHeaders: Record<string, string>;
        try {
          authHeaders = await this.auth.headers(provider, url, { afterRejection: attempt > 0, clientHeaders });
        } catch (error) {
          if (!(error instanceof UpstreamAuthError)) throw error;
          if (!this.closed) this.respondError(streamId, provider, 401, `${hostname()}: ${error.message}`);
          return;
        }
        try {
          connection = await this.connectWebSocket(url, { ...clientHeaders, ...authHeaders }, abort.signal);
        } catch (error) {
          if (!(error instanceof OpenAIWebSocketHttpError)) throw error;
          this.auth.observeResponse?.(provider, url, error.headers);
          if (error.status === 401 && attempt === 0) continue;
          if (this.closed) return;
          this.transport.send({ type: "provider_proxy_response", streamId, status: error.status, headers: providerProxyResponseHeaders(error.headers.entries()) });
          if (error.body) this.transport.send({ type: "provider_proxy_data", streamId, data: Buffer.from(error.body).toString("base64") });
          this.transport.send({ type: "provider_proxy_end", streamId });
          return;
        }
      }
      const socket = connection.socket;
      this.auth.observeResponse?.(provider, url, connection.headers);
      if (this.closed || abort.signal.aborted) {
        socket.close();
        return;
      }
      stream.sendText = (text) => {
        void socket.sendText(text, abort.signal).catch((error: unknown) => {
          if (!abort.signal.aborted) log("warn", `provider-proxy endpoint: websocket send failed: ${errorMessage(error)}`);
          abort.abort();
        });
      };
      abort.signal.addEventListener("abort", () => socket.close(), { once: true });
      this.transport.send({ type: "provider_proxy_response", streamId, status: 101, headers: providerProxyResponseHeaders(connection.headers.entries()) });
      while (!abort.signal.aborted && !this.closed) {
        const message = await socket.nextMessage(WEBSOCKET_IDLE_MS, abort.signal);
        if (message.type === "text") {
          this.transport.send({ type: "provider_proxy_data", streamId, text: message.text });
          if (this.transport.needsDrain()) await this.transport.waitDrain();
        } else if (message.type === "close") {
          if (!this.closed) {
            this.transport.send({
              type: "provider_proxy_end",
              streamId,
              ...(message.code !== undefined ? { closeCode: message.code } : {}),
              ...(message.reason ? { closeReason: message.reason } : {}),
            });
          }
          return;
        }
      }
      if (!this.closed) this.transport.send({ type: "provider_proxy_end", streamId, error: "Cancelled." });
    } catch (error) {
      if (!this.closed) this.transport.send({ type: "provider_proxy_end", streamId, error: abort.signal.aborted ? "Cancelled." : `${hostname()}: ${errorMessage(error)}` });
    } finally {
      abort.abort();
      this.streams.delete(streamId);
    }
  }
}
