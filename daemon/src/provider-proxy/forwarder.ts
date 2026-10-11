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
  PROVIDER_PROXY_MAX_REQUEST_BYTES,
  isProxyableProvider,
  matchProviderProxyRoute,
  providerProxyRequestHeaders,
  type ProxyableProviderId,
} from "@exocortex/shared/provider-proxy";
import { isAbortLikeError } from "../abort";
import { log } from "../log";
import type { ProviderProxyLink, ProviderProxyWebSocketOpenResult } from "./link";

/** How long a request waits for a link that is (re)connecting. */
const LINK_READY_TIMEOUT_MS = 20_000;

export interface ProviderProxyForwarderOptions {
  /** Where the port and secret persist; omit to use fresh ones. */
  stateFile?: string;
  /** The link a provider is proxied through, or null when it is not proxied. */
  linkFor(provider: ProxyableProviderId): ProviderProxyLink | null;
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

    const link = this.options.linkFor(provider);
    if (!link) return jsonError(provider, 503, `Exocortex /proxy: ${provider} is no longer proxied; retry to use it directly.`);
    try {
      await link.waitReady(LINK_READY_TIMEOUT_MS, request.signal);
    } catch (error) {
      return jsonError(provider, 503, `Exocortex /proxy: ${error instanceof Error ? error.message : String(error)}`);
    }

    const headers = providerProxyRequestHeaders(request.headers.entries());
    if (!websocket) {
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > PROVIDER_PROXY_MAX_REQUEST_BYTES) {
        return jsonError(provider, 413, `Exocortex /proxy: request body exceeds ${PROVIDER_PROXY_MAX_REQUEST_BYTES} bytes.`);
      }
      try {
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer());
        const response = await link.openHttp({ provider, method: request.method, target, headers, body }, request.signal);
        return new Response(response.body, { status: response.status, headers: response.headers });
      } catch (error) {
        if (request.signal.aborted || isAbortLikeError(error)) return new Response(null, { status: 499 });
        return jsonError(provider, 502, `Exocortex /proxy: ${error instanceof Error ? error.message : String(error)}`);
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
