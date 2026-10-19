/**
 * The local end of /proxy: a loopback HTTP/websocket endpoint that proxied
 * providers are pointed at (docs/provider-proxy.md).
 *
 * Claude Code is a separate process, so it reaches the link through this
 * endpoint (ANTHROPIC_BASE_URL); the in-process OpenAI client uses it too, so
 * both providers take the same path. It listens on 127.0.0.1 only, requires a
 * per-daemon secret as the bearer token on every request, forwards only
 * allowlisted provider requests, and never forwards the secret: the remote
 * replaces it with its own credentials.
 *
 * The port and secret persist in the runtime directory, so Claude Code
 * processes that outlive a daemon restart (see providers/anthropic/relay.ts)
 * keep working with the next daemon.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import {
  PROVIDER_PROXY_ACCOUNT_MOVE_HEADER,
  PROVIDER_PROXY_CONVERSATION_HEADER,
  PROVIDER_PROXY_MAX_REQUEST_BYTES,
  type ProviderProxyAccountMove,
  isProxyableProvider,
  matchProviderProxyRoute,
  providerProxyRequestHeaders,
  type ProxyableProviderId,
} from "@exocortex/shared/provider-proxy";
import { createAbortError, isAbortLikeError } from "../abort";
import { log } from "../log";
import { isTransientProviderProxyError, type ProviderProxyLink, type ProviderProxyWebSocketOpenResult } from "./link";
import { PROVIDER_PROXY_LINK_DOWN_PREFIX } from "./route";

/** How long one connection attempt may take while a request waits for the link. */
const LINK_READY_TIMEOUT_MS = 20_000;
/**
 * How long a request is held, across reconnect attempts, while the link is
 * down for a transient reason (a Wi-Fi blip, DNS, the remote daemon
 * restarting). Well inside Claude Code's first-byte window, so a short outage
 * is only latency. Past it the request fails without inviting the client to
 * retry, and the turn waits for the link visibly (proxy-link-wait.ts).
 */
const LINK_HOLD_MS = 45_000;
/** Pauses between connection attempts while a request is held. */
const LINK_HOLD_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000];

export interface ProviderProxyForwarderOptions {
  /** Where the port and secret persist; omit to use fresh ones. */
  stateFile?: string;
  /** The link a provider is proxied through, or null when it is not proxied. */
  linkFor(provider: ProxyableProviderId): ProviderProxyLink | null;
  /** The remote moved a named conversation (PROVIDER_PROXY_CONVERSATION_HEADER) to another Claude account. */
  onAccountMove?(conversation: string, move: ProviderProxyAccountMove): void;
  /** Overrides LINK_HOLD_MS (tests). */
  linkHoldMs?: number;
  /** Overrides LINK_HOLD_RETRY_DELAYS_MS (tests). */
  linkHoldRetryDelaysMs?: readonly number[];
}

interface SocketState {
  open: Extract<ProviderProxyWebSocketOpenResult, { status: 101 }> | null;
  socket: ServerWebSocket<SocketState> | null;
  queued: string[];
  closed: { code?: number; reason?: string; error?: string } | null;
}

function jsonError(provider: string, status: number, message: string): Response {
  const body = provider === "anthropic"
    ? { type: "error", error: { type: status === 401 ? "authentication_error" : status === 403 ? "permission_error" : "api_error", message } }
    : { error: { type: "proxy_error", message } };
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * The link could not carry the request. `x-should-retry: false` stops Claude
 * Code's own retries: a transient failure has already been waited out here,
 * and the turn takes over from there; the others will not clear up.
 */
function linkError(provider: string, error: unknown): Response {
  if (isAbortLikeError(error)) return new Response(null, { status: 499 });
  const message = error instanceof Error ? error.message : String(error);
  const response = jsonError(provider, 503, isTransientProviderProxyError(error)
    ? `${PROVIDER_PROXY_LINK_DOWN_PREFIX}${message}`
    : `Exocortex /proxy: ${message}`);
  response.headers.set("x-should-retry", "false");
  return response;
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A close code a server may send: the upstream's, or a generic one. */
function sendableCloseCode(code: number | undefined, failed: boolean): number {
  if (code !== undefined && ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999))) return code;
  return failed ? 1011 : 1000;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(headers: Headers): string {
  const authorization = headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1] : headers.get("x-api-key") ?? "";
}

interface PersistedState {
  port: number;
  token: string;
}

function loadState(file: string | undefined): PersistedState | null {
  if (!file || !existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<PersistedState>;
    if (typeof parsed.port === "number" && typeof parsed.token === "string" && parsed.token.length >= 32) {
      return { port: parsed.port, token: parsed.token };
    }
  } catch {
    // Start fresh.
  }
  return null;
}

function saveState(file: string | undefined, state: PersistedState): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (error) {
    log("warn", `provider-proxy: could not save forwarder state: ${error instanceof Error ? error.message : error}`);
  }
}

export class ProviderProxyForwarder {
  private server: Server<SocketState> | null = null;
  private token = "";

  constructor(private readonly options: ProviderProxyForwarderOptions) {}

  get running(): boolean { return this.server !== null; }
  get port(): number { return this.server?.port ?? 0; }
  get secret(): string { return this.token; }

  baseUrl(provider: ProxyableProviderId): string {
    return `http://127.0.0.1:${this.port}/${provider}`;
  }

  start(): void {
    if (this.server) return;
    const saved = loadState(this.options.stateFile);
    this.token = saved?.token ?? randomBytes(32).toString("base64url");
    const serve = (port: number) => Bun.serve<SocketState>({
      hostname: "127.0.0.1",
      port,
      // A long Claude Code/Codex stream can be quiet for minutes between events.
      idleTimeout: 0,
      maxRequestBodySize: PROVIDER_PROXY_MAX_REQUEST_BYTES,
      fetch: (request, server) => this.handle(request, server),
      websocket: {
        maxPayloadLength: PROVIDER_PROXY_MAX_REQUEST_BYTES,
        idleTimeout: 0,
        open: (socket) => {
          const state = socket.data;
          state.socket = socket;
          for (const text of state.queued.splice(0)) socket.send(text);
          if (state.closed) socket.close(sendableCloseCode(state.closed.code, Boolean(state.closed.error)), state.closed.reason ?? state.closed.error?.slice(0, 120));
        },
        message: (socket, message) => {
          try {
            socket.data.open?.send(typeof message === "string" ? message : Buffer.from(message).toString("utf8"));
          } catch (error) {
            socket.close(1011, (error instanceof Error ? error.message : String(error)).slice(0, 120));
          }
        },
        close: (socket) => {
          socket.data.open?.close();
        },
      },
    });
    try {
      this.server = serve(saved?.port ?? 0);
    } catch (error) {
      if (!saved?.port) throw error;
      log("info", `provider-proxy: forwarder port ${saved.port} is taken; using a new one`);
      this.server = serve(0);
    }
    saveState(this.options.stateFile, { port: this.server.port ?? 0, token: this.token });
    log("info", `provider-proxy: forwarder listening on 127.0.0.1:${this.server.port}`);
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  /**
   * Wait for the provider's link until `deadline`, through reconnect attempts
   * while it is down for a transient reason. Throws the last failure otherwise.
   * Resolves with the link to use: if /proxy is switched to another host (or
   * turned off, null) meanwhile, a held request follows the new route instead
   * of failing with the old link's closure.
   */
  private async holdForLink(provider: ProxyableProviderId, link: ProviderProxyLink, deadline: number, signal: AbortSignal): Promise<ProviderProxyLink | null> {
    const delays = this.options.linkHoldRetryDelaysMs ?? LINK_HOLD_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        await link.waitReady(Math.max(1, Math.min(deadline - Date.now(), LINK_READY_TIMEOUT_MS)), signal);
        return link;
      } catch (error) {
        if (signal.aborted) throw error;
        // /proxy switched to another host or off: the held link was retired.
        const current = link.isClosed ? this.options.linkFor(provider) : link;
        if (current !== link) {
          if (!current) return null;
          log("info", `provider-proxy: a held request moves from ${link.alias} to ${current.alias}`);
          link = current;
          continue;
        }
        if (!isTransientProviderProxyError(error)) throw error;
        const delay = delays[Math.min(attempt, delays.length - 1)];
        if (Date.now() + delay >= deadline) throw error;
        if (attempt === 0) log("info", `provider-proxy: holding a request until ${link.alias} is back: ${error instanceof Error ? error.message : error}`);
        await abortableDelay(delay, signal);
      }
    }
  }

  private async handle(request: Request, server: Server<SocketState>): Promise<Response | undefined> {
    const url = new URL(request.url);
    const host = request.headers.get("host") ?? "";
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      return new Response("Forbidden", { status: 403 });
    }
    const slash = url.pathname.indexOf("/", 1);
    const provider = slash === -1 ? url.pathname.slice(1) : url.pathname.slice(1, slash);
    if (!isProxyableProvider(provider)) return new Response("Not found", { status: 404 });
    if (!sameSecret(bearer(request.headers), this.token)) {
      return jsonError(provider, 401, "Exocortex /proxy: missing or wrong forwarder token.");
    }
    const target = `${slash === -1 ? "/" : url.pathname.slice(slash)}${url.search}`;
    const websocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    const matched = matchProviderProxyRoute(provider, websocket ? "websocket" : "http", request.method, target);
    if ("error" in matched) return jsonError(provider, 403, `Exocortex /proxy: ${matched.error}.`);

    const notProxied = () => jsonError(provider, 503, `Exocortex /proxy: ${provider} is no longer proxied; retry to use it directly.`);
    const initialLink = this.options.linkFor(provider);
    if (!initialLink) return notProxied();
    const deadline = Date.now() + (this.options.linkHoldMs ?? LINK_HOLD_MS);
    let link: ProviderProxyLink;
    try {
      const ready = await this.holdForLink(provider, initialLink, deadline, request.signal);
      if (!ready) return notProxied();
      link = ready;
    } catch (error) {
      return linkError(provider, error);
    }

    const headers = providerProxyRequestHeaders(request.headers.entries());
    if (!websocket) {
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > PROVIDER_PROXY_MAX_REQUEST_BYTES) {
        return jsonError(provider, 413, `Exocortex /proxy: request body exceeds ${PROVIDER_PROXY_MAX_REQUEST_BYTES} bytes.`);
      }
      let body: Uint8Array | undefined;
      try {
        body = request.method === "GET" || request.method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer());
      } catch (error) {
        if (request.signal.aborted || isAbortLikeError(error)) return new Response(null, { status: 499 });
        return jsonError(provider, 502, `Exocortex /proxy: ${error instanceof Error ? error.message : String(error)}`);
      }
      while (true) {
        let response: Awaited<ReturnType<ProviderProxyLink["openHttp"]>>;
        try {
          response = await link.openHttp({ provider, method: request.method, target, headers, body }, request.signal);
        } catch (error) {
          if (request.signal.aborted || isAbortLikeError(error)) return new Response(null, { status: 499 });
          if (!isTransientProviderProxyError(error)) return jsonError(provider, 502, `Exocortex /proxy: ${error instanceof Error ? error.message : String(error)}`);
          // The link dropped before the upstream answered: send it again once the link is back.
          try {
            if (Date.now() >= deadline) throw error;
            const ready = await this.holdForLink(provider, link, deadline, request.signal);
            if (!ready) return notProxied();
            link = ready;
          } catch (holdError) {
            return linkError(provider, holdError);
          }
          continue;
        }
        const responseHeaders = { ...response.headers };
        const move = responseHeaders[PROVIDER_PROXY_ACCOUNT_MOVE_HEADER];
        delete responseHeaders[PROVIDER_PROXY_ACCOUNT_MOVE_HEADER];
        const conversation = headers[PROVIDER_PROXY_CONVERSATION_HEADER];
        if (move && conversation) {
          try {
            this.options.onAccountMove?.(conversation, JSON.parse(decodeURIComponent(move)) as ProviderProxyAccountMove);
          } catch {
            // A malformed note changes nothing about the response.
          }
        }
        return new Response(response.body, { status: response.status, headers: responseHeaders });
      }
    }

    const state: SocketState = { open: null, socket: null, queued: [], closed: null };
    let opened: ProviderProxyWebSocketOpenResult;
    try {
      opened = await link.openWebSocket({ provider, target, headers }, {
        onMessage: (text) => {
          if (state.socket) state.socket.send(text);
          else state.queued.push(text);
        },
        onClose: (info) => {
          state.closed = info;
          state.open = null;
          state.socket?.close(sendableCloseCode(info.code, Boolean(info.error)), info.reason ?? info.error?.slice(0, 120));
        },
      }, request.signal);
    } catch (error) {
      if (isTransientProviderProxyError(error)) return linkError(provider, error);
      return jsonError(provider, 502, `Exocortex /proxy: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (opened.status !== 101 || !("send" in opened)) {
      const failed = opened as { status: number; headers: Record<string, string>; body: string };
      return new Response(failed.body, { status: failed.status, headers: failed.headers });
    }
    state.open = opened;
    const responseHeaders = Object.fromEntries(Object.entries(opened.headers)
      .filter(([name]) => !/^(content-type|date|server|sec-websocket-.*)$/i.test(name)));
    if (server.upgrade(request, { headers: responseHeaders, data: state })) return undefined;
    opened.close();
    return new Response("WebSocket upgrade failed", { status: 400 });
  }
}
