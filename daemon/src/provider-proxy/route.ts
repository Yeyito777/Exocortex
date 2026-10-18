/**
 * Where a proxied provider's requests go, for the provider adapters.
 *
 * Kept free of the link and forwarder so providers can consult it without
 * import cycles. The manager (manager.ts) fills it in; a provider with no
 * route here talks to its API directly, exactly as without /proxy.
 */

import { hostname } from "node:os";
import type { ProviderId, UsageData } from "../messages";
import type { ProviderProxyAccountMove, ProviderProxyFeature, ProviderProxyRemoteAccounts, ProviderProxyRemoteStatus, ProxyableProviderId } from "@exocortex/shared/provider-proxy";
import type { ClaudeAccountsRemoteInfo } from "@exocortex/shared/protocol";
import { PROVIDER_PROXY_ORIGINS, isProxyableProvider } from "@exocortex/shared/provider-proxy";

export interface ProviderProxyRoute {
  provider: ProxyableProviderId;
  alias: string;
  /** Loopback forwarder base for this provider, e.g. http://127.0.0.1:41234/anthropic. */
  baseUrl: string;
  /** Per-daemon secret the forwarder requires as the bearer token; the remote replaces it. */
  token: string;
}

/** What the manager offers the providers beyond the route. */
export interface ProviderProxyHooks {
  /** Wait (bounded) until the link is up and the remote can serve `provider`; throws a clear error otherwise. */
  ready(provider: ProxyableProviderId, signal?: AbortSignal): Promise<ProviderProxyRemoteStatus>;
  /** Try the link `provider` goes through now (one bounded attempt); rejects with the failure. */
  connect(provider: ProxyableProviderId, signal?: AbortSignal): Promise<void>;
  /** Whether the remote `provider` goes through lists `feature` in its hello. */
  remoteSupports(provider: ProxyableProviderId, feature: ProviderProxyFeature): boolean;
  /** The remote's last known status for `provider`. */
  remoteStatus(provider: ProxyableProviderId): ProviderProxyRemoteStatus | null;
  /** The remote's Claude pool and the link's state, when Claude is proxied and the remote shares its pool. */
  remoteAccounts(): { pool: ProviderProxyRemoteAccounts; remote: ClaudeAccountsRemoteInfo } | null;
  /** Ask the remote for fresh usage of its account. */
  refreshUsage(provider: ProxyableProviderId): Promise<UsageData | null>;
  /** Spend one of the remote account's usage resets. */
  consumeReset(provider: ProxyableProviderId): Promise<{ outcome: string; windowsReset: number; remainingResets?: number }>;
}

/**
 * Starts the error the forwarder answers when the link stayed down for a
 * transient reason through its hold. Claude Code quotes it in its API error,
 * so the turn can tell it apart and wait for the link (proxy-link-wait.ts).
 */
export const PROVIDER_PROXY_LINK_DOWN_PREFIX = "Exocortex /proxy (link down): ";

/** A provider request failed because the /proxy link was down for a transient reason. */
export function isProviderProxyLinkDownMessage(message: string): boolean {
  return message.includes(PROVIDER_PROXY_LINK_DOWN_PREFIX);
}

const routes = new Map<ProxyableProviderId, ProviderProxyRoute>();
let hooks: ProviderProxyHooks | null = null;
/** The remote account's usage, kept apart from this machine's own (see daemon/src/usage.ts). */
const proxiedUsage = new Map<ProxyableProviderId, UsageData | null>();

export function providerProxyRoute(provider: ProviderId | string | undefined): ProviderProxyRoute | null {
  return isProxyableProvider(provider) ? routes.get(provider) ?? null : null;
}

export function isProviderProxied(provider: ProviderId | string | undefined): boolean {
  return providerProxyRoute(provider) !== null;
}

export function setProviderProxyRoute(provider: ProxyableProviderId, route: ProviderProxyRoute | null): void {
  if (route) routes.set(provider, route);
  else routes.delete(provider);
}

export function configureProviderProxyHooks(next: ProviderProxyHooks | null): void {
  hooks = next;
}

export async function providerProxyReady(provider: ProxyableProviderId, signal?: AbortSignal): Promise<ProviderProxyRemoteStatus> {
  if (!hooks) throw new Error(`${provider} is set to /proxy but the proxy is not running.`);
  return hooks.ready(provider, signal);
}

/** Try the link a proxied provider goes through now; resolves at once when it is no longer proxied. */
export async function providerProxyConnect(provider: ProxyableProviderId, signal?: AbortSignal): Promise<void> {
  if (!routes.has(provider) || !hooks) return;
  await hooks.connect(provider, signal);
}

export function providerProxyRemoteStatus(provider: ProxyableProviderId): ProviderProxyRemoteStatus | null {
  return hooks?.remoteStatus(provider) ?? null;
}

export function providerProxySupports(provider: ProxyableProviderId, feature: ProviderProxyFeature): boolean {
  return routes.has(provider) && (hooks?.remoteSupports(provider, feature) ?? false);
}

/**
 * The name a conversation of this machine goes by on the /proxy remote
 * (PROVIDER_PROXY_CONVERSATION_HEADER): this host, then the conversation id.
 */
export function proxiedConversationName(convId: string): string {
  return `${hostname().replace(/[^A-Za-z0-9._@:-]/g, "-").slice(0, 128) || "client"}/${convId}`;
}

const claudeMoveListeners = new Map<string, Set<(move: ProviderProxyAccountMove) => void>>();

/** While `convId`'s turn runs: the /proxy remote moved it to another Claude account. */
export function onProxiedClaudeMove(convId: string, listener: (move: ProviderProxyAccountMove) => void): () => void {
  let listeners = claudeMoveListeners.get(convId);
  if (!listeners) claudeMoveListeners.set(convId, listeners = new Set());
  listeners.add(listener);
  return () => {
    listeners!.delete(listener);
    if (listeners!.size === 0 && claudeMoveListeners.get(convId) === listeners) claudeMoveListeners.delete(convId);
  };
}

export function emitProxiedClaudeMove(convId: string, move: ProviderProxyAccountMove): void {
  for (const listener of claudeMoveListeners.get(convId) ?? []) listener(move);
}

/** The remote's Claude pool while Claude is proxied, if the remote shares it. */
export function proxiedClaudeAccounts(): { pool: ProviderProxyRemoteAccounts; remote: ClaudeAccountsRemoteInfo } | null {
  return routes.has("anthropic") ? hooks?.remoteAccounts() ?? null : null;
}

export function providerProxyHooks(): ProviderProxyHooks | null {
  return hooks;
}

export function getProxiedUsage(provider: ProxyableProviderId): UsageData | null {
  return proxiedUsage.get(provider) ?? null;
}

export function setProxiedUsage(provider: ProxyableProviderId, usage: UsageData | null): void {
  proxiedUsage.set(provider, usage);
}

/**
 * A provider API URL, rewritten to the forwarder when the provider is proxied.
 * `directOrigin` is the origin the adapter normally uses (it may be overridden
 * for tests); the remote always uses its own allowlisted origin.
 */
export function proxiedProviderUrl(provider: ProxyableProviderId, url: string, directOrigin = PROVIDER_PROXY_ORIGINS[provider]): string {
  const route = routes.get(provider);
  if (!route) return url;
  const origin = directOrigin.replace(/\/+$/, "");
  const websocket = /^wss?:/.test(url);
  const httpUrl = websocket ? url.replace(/^ws/, "http") : url;
  if (!httpUrl.startsWith(origin)) return url;
  const rest = httpUrl.slice(origin.length);
  if (rest !== "" && !rest.startsWith("/") && !rest.startsWith("?")) return url;
  const proxied = `${route.baseUrl}${rest.startsWith("/") ? rest : `/${rest}`}`;
  return websocket ? proxied.replace(/^http/, "ws") : proxied;
}

export function resetProviderProxyRoutesForTest(): void {
  routes.clear();
  proxiedUsage.clear();
  hooks = null;
}
