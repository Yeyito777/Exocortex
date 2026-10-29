/**
 * /proxy: borrow another machine's provider login over SSH.
 *
 * A daemon with `/proxy <provider> <ssh-alias>` keeps doing everything
 * locally (conversations, tools, files) but sends that provider's model API
 * traffic over one SSH connection per alias to the remote machine's daemon
 * (`ssh <alias> exocortexd proxy`, the same bridge /ssh uses). The remote
 * daemon attaches its own credentials and makes the upstream request, so
 * credentials never leave it. See docs/provider-proxy.md.
 *
 * This module is the wire contract both daemons share: the link messages, the
 * upstream allowlist and the header policy.
 */

import type { ClaudeAccountsInfo, ClientHostInfo, ProviderAuthInfo } from "./protocol";
import type { ProviderId, UsageData } from "./messages";

/** Bumped when the link protocol changes incompatibly. */
export const PROVIDER_PROXY_PROTOCOL_VERSION = 1;

export const PROXYABLE_PROVIDERS = ["openai", "anthropic"] as const;
export type ProxyableProviderId = typeof PROXYABLE_PROVIDERS[number];

export function isProxyableProvider(value: unknown): value is ProxyableProviderId {
  return typeof value === "string" && (PROXYABLE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * What a remote can do beyond protocol v1, listed in its hello. `claude-pool`:
 * it shares its Claude account pool (provider_proxy_accounts) and routes
 * proxied Claude requests across it by PROVIDER_PROXY_CONVERSATION_HEADER.
 * `exec-alive`: it acknowledges remote_bash commands and reports them alive
 * while they run (provider_proxy_exec_alive). `link-ping`: it answers
 * provider_proxy_ping, so the linking daemon can tell a stuck connection.
 */
export const PROVIDER_PROXY_FEATURES = ["claude-pool", "exec-alive", "link-ping"] as const;
/**
 * Added to the hello by `exocortexd proxy --link-only` (a key limited to the
 * model link): remote_bash and client_bash are not available over this link.
 */
export const PROVIDER_PROXY_LINK_ONLY_FEATURE = "link-only";
export type ProviderProxyFeature = typeof PROVIDER_PROXY_FEATURES[number] | typeof PROVIDER_PROXY_LINK_ONLY_FEATURE;

/**
 * Request header naming the proxied conversation (`<client host>/<conversation
 * id>`), so a remote with several Claude accounts keeps it on one while its
 * prompt cache is warm. The remote removes it; it never reaches the upstream.
 */
export const PROVIDER_PROXY_CONVERSATION_HEADER = "x-exocortex-proxy-conversation";

/**
 * Response header a `claude-pool` remote adds when it moved the conversation
 * to another Claude account: `{ from, to, detail }` as URI-encoded JSON. The
 * local forwarder takes it off (Claude Code never sees it) so the move is
 * announced in the conversation, as for the remote's own conversations.
 */
export const PROVIDER_PROXY_ACCOUNT_MOVE_HEADER = "x-exocortex-claude-account-move";

/**
 * Response header a remote adds when it billed the request to one of its
 * Claude API-credit keys (every subscription account at a limit): the key's
 * URI-encoded label. The local forwarder takes it off, so the turn shows it
 * ran on API credits, as the remote's own turns do.
 */
export const PROVIDER_PROXY_API_CREDITS_HEADER = "x-exocortex-claude-api-credits";

/**
 * Request header (`1`) of a conversation whose turns may not run on API
 * credits (an app's `route.credits: "never"`, docs/app-api.md): the remote
 * never bills its requests to a key. Taken off before the upstream.
 */
export const PROVIDER_PROXY_NO_API_CREDITS_HEADER = "x-exocortex-claude-no-api-credits";

export interface ProviderProxyAccountMove {
  from: string;
  to: string;
  detail: string;
}

/** Largest request body (or websocket message) a link carries; larger requests fail locally. */
export const PROVIDER_PROXY_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

export type ProviderProxyStreamKind = "http" | "websocket";

interface ProviderProxyRoute {
  kind: ProviderProxyStreamKind;
  method: "GET" | "POST";
  path: string;
}

/**
 * The only upstream requests a remote daemon makes for a link: exact paths on
 * the provider's own API origin. Anything else is refused on both ends.
 */
export const PROVIDER_PROXY_ROUTES: Record<ProxyableProviderId, readonly ProviderProxyRoute[]> = {
  anthropic: [
    { kind: "http", method: "POST", path: "/v1/messages" },
    { kind: "http", method: "POST", path: "/v1/messages/count_tokens" },
  ],
  openai: [
    { kind: "http", method: "POST", path: "/backend-api/codex/responses" },
    { kind: "websocket", method: "GET", path: "/backend-api/codex/responses" },
    { kind: "http", method: "GET", path: "/backend-api/codex/models" },
    { kind: "http", method: "POST", path: "/backend-api/transcribe" },
  ],
};

/** Production upstream origins. */
export const PROVIDER_PROXY_ORIGINS: Record<ProxyableProviderId, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://chatgpt.com",
};

/**
 * The allowlisted route a request targets, or an error. `target` is the path
 * and query relative to the provider origin, e.g. `/v1/messages?beta=true`.
 */
export function matchProviderProxyRoute(
  provider: ProxyableProviderId,
  kind: ProviderProxyStreamKind,
  method: string,
  target: string,
): { path: string; search: string } | { error: string } {
  if (typeof target !== "string" || !target.startsWith("/") || target.startsWith("//")) {
    return { error: "invalid request target" };
  }
  const queryIndex = target.indexOf("?");
  const path = queryIndex === -1 ? target : target.slice(0, queryIndex);
  const search = queryIndex === -1 ? "" : target.slice(queryIndex);
  // Exact, already-normalized paths only: no dot segments, escapes or fragments.
  if (/[%\\#]|\/\.\.?(\/|$)/.test(path) || /[#\s]/.test(search)) return { error: "invalid request target" };
  const route = PROVIDER_PROXY_ROUTES[provider].find(candidate =>
    candidate.kind === kind && candidate.method === method.toUpperCase() && candidate.path === path);
  if (!route) return { error: `${method.toUpperCase()} ${path} is not an allowed ${provider} ${kind} request` };
  return { path, search };
}

/** Request headers a link never carries: credentials, cookies and transport framing. */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization", "x-api-key", "cookie", "proxy-authorization", "chatgpt-account-id",
  "host", "content-length", "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
  "accept-encoding", "origin", "referer", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-accept", "sec-websocket-protocol",
]);

/** Response headers a remote never returns: cookies, auth echoes and transport framing. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "set-cookie", "set-cookie2", "www-authenticate", "proxy-authenticate", "authorization",
  "content-length", "content-encoding", "connection", "keep-alive", "transfer-encoding", "trailer", "upgrade",
  "sec-websocket-accept", "sec-websocket-extensions", "alt-svc", "strict-transport-security",
]);

function filterHeaders(headers: Iterable<[string, string]>, dropped: Set<string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (dropped.has(name) || name.startsWith("proxy-") || typeof value !== "string") continue;
    if (/[\r\n]/.test(value)) continue;
    result[name] = result[name] === undefined ? value : `${result[name]}, ${value}`;
  }
  return result;
}

export function providerProxyRequestHeaders(headers: Iterable<[string, string]>): Record<string, string> {
  return filterHeaders(headers, DROPPED_REQUEST_HEADERS);
}

export function providerProxyResponseHeaders(headers: Iterable<[string, string]>): Record<string, string> {
  return filterHeaders(headers, DROPPED_RESPONSE_HEADERS);
}

// ── Link messages (local daemon → remote daemon, over `exocortexd proxy`) ──

/**
 * First message on a link. It marks the connection as a provider link: the
 * remote daemon stops sending it broadcasts and answers with what it can serve.
 * Daemons without /proxy answer `Unknown command: provider_proxy_hello`.
 */
export interface ProviderProxyHelloCommand {
  type: "provider_proxy_hello";
  reqId: string;
  version: number;
  providers: ProxyableProviderId[];
  /**
   * The linking daemon's own machine. The remote then runs its conversations'
   * client_bash there, over this link (provider_proxy_client_exec), even
   * while no TUI from that machine is connected. Absent from older daemons.
   */
  clientHost?: ClientHostInfo;
}

/** Open one upstream request. HTTP bodies arrive whole (base64), capped at PROVIDER_PROXY_MAX_REQUEST_BYTES. */
export interface ProviderProxyOpenCommand {
  type: "provider_proxy_open";
  streamId: string;
  provider: ProxyableProviderId;
  kind: ProviderProxyStreamKind;
  method: string;
  /** Path and query relative to the provider origin. */
  target: string;
  /** Already filtered with providerProxyRequestHeaders; the remote filters again. */
  headers: Record<string, string>;
  body?: string;
}

/** A text message for an open websocket stream. */
export interface ProviderProxyWsSendCommand {
  type: "provider_proxy_ws_send";
  streamId: string;
  text: string;
}

/** Stop a stream: abort its upstream request or close its websocket. */
export interface ProviderProxyCancelCommand {
  type: "provider_proxy_cancel";
  streamId: string;
}

/** The remote's login and usage for a provider; `refreshUsage` asks it to fetch fresh usage first. */
export interface ProviderProxyStatusCommand {
  type: "provider_proxy_status";
  reqId: string;
  provider: ProxyableProviderId;
  refreshUsage?: boolean;
}

/** Spend one of the remote account's usage resets (OpenAI /usage reset). */
export interface ProviderProxyConsumeResetCommand {
  type: "provider_proxy_consume_reset";
  reqId: string;
  provider: ProxyableProviderId;
}

/**
 * The remote's Claude account pool, for the bars and the Accounts screen.
 * Answered with provider_proxy_accounts_result; `watch: true` also asks for a
 * provider_proxy_accounts_update whenever it changes, until `watch: false` or
 * the link closes. Daemons without it answer `Unknown command`.
 */
export interface ProviderProxyAccountsCommand {
  type: "provider_proxy_accounts";
  reqId: string;
  provider: "anthropic";
  watch?: boolean;
}

/** remote_bash: run a command on the remote machine as the remote daemon's user. */
export interface ProviderProxyExecCommand {
  type: "provider_proxy_exec";
  execId: string;
  command: string;
  cwd?: string;
  timeoutMs: number;
}

export interface ProviderProxyExecCancelCommand {
  type: "provider_proxy_exec_cancel";
  execId: string;
}

/** With `link-ping`: answered at once with provider_proxy_pong; the link sends one every few seconds. */
export interface ProviderProxyPingCommand {
  type: "provider_proxy_ping";
  reqId: string;
}

/** The outcome of a provider_proxy_client_exec, run on the linking daemon's machine. */
export interface ProviderProxyClientExecResultCommand {
  type: "provider_proxy_client_exec_result";
  execId: string;
  output: string;
  byteTruncated: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  error?: string;
}

/** provider_proxy_client_exec commands running here: at once for a new one, then every EXEC_ALIVE_INTERVAL_MS. */
export interface ProviderProxyClientExecAliveCommand {
  type: "provider_proxy_client_exec_alive";
  execIds: string[];
}

export type ProviderProxyLinkCommand =
  | ProviderProxyHelloCommand
  | ProviderProxyOpenCommand
  | ProviderProxyWsSendCommand
  | ProviderProxyCancelCommand
  | ProviderProxyStatusCommand
  | ProviderProxyConsumeResetCommand
  | ProviderProxyAccountsCommand
  | ProviderProxyExecCommand
  | ProviderProxyExecCancelCommand
  | ProviderProxyPingCommand
  | ProviderProxyClientExecResultCommand
  | ProviderProxyClientExecAliveCommand;

/** What a remote daemon can serve for one provider. Never contains credentials. */
export interface ProviderProxyRemoteStatus {
  loggedIn: boolean;
  /** Why the remote cannot serve the provider, e.g. it is not logged in. */
  error?: string;
  /** Account metadata for display (email, plan); no tokens. */
  authInfo: ProviderAuthInfo | null;
  /** Non-secret hash identifying the remote account, for replay scoping. */
  accountScope: string | null;
  usage: UsageData | null;
}

export interface ProviderProxyHelloResultEvent {
  type: "provider_proxy_hello_result";
  reqId: string;
  version: number;
  host: ClientHostInfo;
  providers: Partial<Record<ProxyableProviderId, ProviderProxyRemoteStatus>>;
  /** Absent from remotes that predate it. */
  features?: string[];
}

export interface ProviderProxyStatusResultEvent {
  type: "provider_proxy_status_result";
  reqId: string;
  provider: ProxyableProviderId;
  status: ProviderProxyRemoteStatus;
}

export interface ProviderProxyConsumeResetResultEvent {
  type: "provider_proxy_consume_reset_result";
  reqId: string;
  result?: { outcome: string; windowsReset: number; remainingResets?: number };
  error?: string;
}

/**
 * The remote's Claude accounts as its own Accounts screen sees them (its
 * conversation rows are the remote's conversations).
 * Null when the remote has no pool to share (it proxies Claude itself).
 */
export type ProviderProxyRemoteAccounts = Omit<ClaudeAccountsInfo, "currentConversation">;

export interface ProviderProxyAccountsResultEvent {
  type: "provider_proxy_accounts_result";
  reqId: string;
  provider: "anthropic";
  accounts: ProviderProxyRemoteAccounts | null;
}

/** The watched pool changed. */
export interface ProviderProxyAccountsUpdateEvent {
  type: "provider_proxy_accounts_update";
  provider: "anthropic";
  accounts: ProviderProxyRemoteAccounts | null;
}

/** The upstream answered: HTTP status and headers (101 opens a websocket stream). */
export interface ProviderProxyResponseEvent {
  type: "provider_proxy_response";
  streamId: string;
  status: number;
  headers: Record<string, string>;
}

/** Body bytes (base64) of an HTTP stream, or one text message of a websocket stream. */
export interface ProviderProxyDataEvent {
  type: "provider_proxy_data";
  streamId: string;
  data?: string;
  text?: string;
}

/** The stream ended: completely, or with `error`. A websocket's close code comes with it. */
export interface ProviderProxyEndEvent {
  type: "provider_proxy_end";
  streamId: string;
  error?: string;
  closeCode?: number;
  closeReason?: string;
}

export interface ProviderProxyExecResultEvent {
  type: "provider_proxy_exec_result";
  execId: string;
  output: string;
  byteTruncated: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  error?: string;
}

/** With `exec-alive`: remote_bash commands running on the remote (acknowledgement, then every EXEC_ALIVE_INTERVAL_MS). */
export interface ProviderProxyExecAliveEvent {
  type: "provider_proxy_exec_alive";
  execIds: string[];
}

export interface ProviderProxyPongEvent {
  type: "provider_proxy_pong";
  reqId: string;
}

/**
 * client_bash: run a command on the linking daemon's machine (it sent
 * clientHost in its hello). Answered with provider_proxy_client_exec_result.
 */
export interface ProviderProxyClientExecEvent {
  type: "provider_proxy_client_exec";
  execId: string;
  command: string;
  cwd?: string;
  timeoutMs: number;
}

export interface ProviderProxyClientExecCancelEvent {
  type: "provider_proxy_client_exec_cancel";
  execId: string;
}

export type ProviderProxyLinkEvent =
  | ProviderProxyHelloResultEvent
  | ProviderProxyStatusResultEvent
  | ProviderProxyConsumeResetResultEvent
  | ProviderProxyAccountsResultEvent
  | ProviderProxyAccountsUpdateEvent
  | ProviderProxyResponseEvent
  | ProviderProxyDataEvent
  | ProviderProxyEndEvent
  | ProviderProxyExecResultEvent
  | ProviderProxyExecAliveEvent
  | ProviderProxyPongEvent
  | ProviderProxyClientExecEvent
  | ProviderProxyClientExecCancelEvent;

export const PROVIDER_PROXY_LINK_EVENT_TYPES: ReadonlySet<string> = new Set<ProviderProxyLinkEvent["type"]>([
  "provider_proxy_hello_result",
  "provider_proxy_status_result",
  "provider_proxy_consume_reset_result",
  "provider_proxy_accounts_result",
  "provider_proxy_accounts_update",
  "provider_proxy_response",
  "provider_proxy_data",
  "provider_proxy_end",
  "provider_proxy_exec_result",
  "provider_proxy_exec_alive",
  "provider_proxy_pong",
  "provider_proxy_client_exec",
  "provider_proxy_client_exec_cancel",
]);

// ── Client-facing (TUI ↔ its daemon) ──────────────────────────────────

/** `/proxy`: list (`status`), enable (`set`) or disable (`off`) a provider's proxy. */
export interface ProviderProxyCommand {
  type: "provider_proxy";
  reqId?: string;
  action: "status" | "set" | "off";
  provider?: ProviderId;
  alias?: string;
}

export type ProviderProxyLinkState = "connecting" | "connected" | "disconnected";

export interface ProviderProxyInfo {
  provider: ProxyableProviderId;
  alias: string;
  state: ProviderProxyLinkState;
  /** Why the link is down, or why the remote cannot serve this provider. */
  message?: string;
  /** `user@hostname` of the remote machine once connected. */
  remoteHost?: string;
  remoteLoggedIn?: boolean;
  remoteAccount?: string | null;
}

/** The daemon's proxies, sent on change, in answer to `provider_proxy`, and at bootstrap. */
export interface ProviderProxiesEvent {
  type: "provider_proxies";
  reqId?: string;
  proxies: ProviderProxyInfo[];
  /** Result text for the command this answers. */
  message?: string;
  error?: boolean;
}
