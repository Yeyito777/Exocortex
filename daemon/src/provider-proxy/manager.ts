/**
 * /proxy on the local side: which providers go through which SSH alias, the
 * links and the loopback forwarder (docs/provider-proxy.md).
 *
 * The setting persists in config.json (`providers.<id>.proxy.ssh`), so a
 * restarted daemon proxies the same providers. A proxied provider never falls
 * back to its direct API: while the link is down its requests fail like any
 * network error, with the reason.
 */

import { hostname } from "node:os";
import { join } from "node:path";
import { readExocortexConfig, updateExocortexConfig, type ExocortexConfig } from "@exocortex/shared/config";
import { runtimeDir } from "@exocortex/shared/paths";
import { validateSshAlias, type SpawnSshProcess } from "@exocortex/shared/ssh-transport";
import {
  PROVIDER_PROXY_LINK_ONLY_FEATURE,
  PROXYABLE_PROVIDERS,
  isProxyableProvider,
  type ProviderProxyInfo,
  type ProviderProxyRemoteAccounts,
  type ProviderProxyRemoteStatus,
  type ProxyableProviderId,
} from "@exocortex/shared/provider-proxy";
import type { ClaudeAccountsRemoteInfo } from "@exocortex/shared/protocol";
import type { UsageData } from "../messages";
import { AuthError } from "../providers/errors";
import { log } from "../log";
import { ProviderProxyForwarder } from "./forwarder";
import { describeRemoteHost, ProviderProxyLink, ProviderProxyUnavailableError } from "./link";
import {
  configureProviderProxyHooks,
  emitProxiedClaudeMove,
  getProxiedUsage,
  proxiedConversationName,
  setProviderProxyRoute,
  setProxiedUsage,
} from "./route";

const PROVIDER_LABELS: Record<ProxyableProviderId, string> = { openai: "OpenAI", anthropic: "Anthropic" };
/** How long `/proxy <provider> <alias>` waits to reach the remote before giving up. */
const SET_TIMEOUT_MS = 30_000;
/** How long a turn waits for a (re)connecting link. */
const READY_TIMEOUT_MS = 20_000;
/** A link no provider uses closes once its streams finish, or after this long. */
const RETIRE_GRACE_MS = 15 * 60_000;

export interface ProviderProxyManagerOptions {
  spawnProcess?: SpawnSshProcess;
  /** Persisted settings; tests substitute an in-memory copy. */
  readConfig?: () => ExocortexConfig;
  updateConfig?: (mutator: (config: ExocortexConfig) => void) => void;
  forwarderStateFile?: string;
  /** Proxies, link state or the remote's account changed. */
  onChange?: () => void;
  /** A provider switched between direct and proxied (or to another alias). */
  onRouteChange?: (provider: ProxyableProviderId) => void;
  /** The proxied Claude pool (`remoteAccounts`) changed. */
  onAccountsChange?: () => void;
  reconnectDelaysMs?: readonly number[];
  helloTimeoutMs?: number;
}

let activeManager: ProviderProxyManager | null = null;

/** The daemon's manager, for remote_bash and turn notices; null in processes without one. */
export function activeProviderProxyManager(): ProviderProxyManager | null {
  return activeManager;
}

export function setActiveProviderProxyManager(manager: ProviderProxyManager | null): void {
  activeManager = manager;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Proxies saved in config: `providers.<id>.proxy = { ssh: "<alias>" }`. */
export function configuredProviderProxies(config: ExocortexConfig): Map<ProxyableProviderId, string> {
  const result = new Map<ProxyableProviderId, string>();
  const providers = isObject(config.providers) ? config.providers : {};
  for (const provider of PROXYABLE_PROVIDERS) {
    const block = providers[provider];
    const proxy = isObject(block) ? block.proxy : undefined;
    const alias = isObject(proxy) ? proxy.ssh : undefined;
    if (typeof alias === "string" && validateSshAlias(alias) === null) result.set(provider, alias);
  }
  return result;
}

function saveProviderProxy(config: ExocortexConfig, provider: ProxyableProviderId, alias: string | null): void {
  const providers: Record<string, unknown> = isObject(config.providers) ? config.providers : {};
  const block: Record<string, unknown> = isObject(providers[provider]) ? { ...(providers[provider] as Record<string, unknown>) } : {};
  if (alias) block.proxy = { ssh: alias };
  else delete block.proxy;
  if (Object.keys(block).length > 0) providers[provider] = block;
  else delete providers[provider];
  if (Object.keys(providers).length > 0) config.providers = providers as ExocortexConfig["providers"];
  else delete config.providers;
}

export class ProviderProxyManager {
  private readonly proxies = new Map<ProxyableProviderId, string>();
  private readonly links = new Map<string, ProviderProxyLink>();
  private readonly retiring = new Map<string, ReturnType<typeof setInterval>>();
  private readonly forwarder: ProviderProxyForwarder;
  private readonly readConfig: () => ExocortexConfig;
  private readonly updateConfig: (mutator: (config: ExocortexConfig) => void) => void;
  private started = false;
  private listeners: Pick<ProviderProxyManagerOptions, "onChange" | "onRouteChange" | "onAccountsChange">;

  constructor(private readonly options: ProviderProxyManagerOptions = {}) {
    this.listeners = { onChange: options.onChange, onRouteChange: options.onRouteChange, onAccountsChange: options.onAccountsChange };
    this.readConfig = options.readConfig ?? readExocortexConfig;
    this.updateConfig = options.updateConfig ?? ((mutator) => { updateExocortexConfig(mutator); });
    this.forwarder = new ProviderProxyForwarder({
      stateFile: options.forwarderStateFile ?? join(runtimeDir(), "provider-proxy.json"),
      linkFor: (provider) => {
        const alias = this.proxies.get(provider);
        return alias ? this.links.get(alias) ?? null : null;
      },
      onAccountMove: (conversation, move) => {
        const prefix = proxiedConversationName("");
        if (conversation.startsWith(prefix)) emitProxiedClaudeMove(conversation.slice(prefix.length), move);
      },
    });
  }

  setListeners(listeners: Pick<ProviderProxyManagerOptions, "onChange" | "onRouteChange" | "onAccountsChange">): void {
    this.listeners = listeners;
  }

  /** Restore the saved proxies and start connecting. */
  start(): void {
    if (this.started) return;
    this.started = true;
    configureProviderProxyHooks({
      ready: (provider, signal) => this.ready(provider, signal),
      connect: async (provider, signal) => { await this.linkFor(provider)?.waitReady(READY_TIMEOUT_MS, signal); },
      remoteStatus: (provider) => this.remoteStatus(provider),
      remoteSupports: (provider, feature) => this.linkFor(provider)?.features.includes(feature) ?? false,
      remoteAccounts: () => this.remoteAccounts(),
      refreshUsage: (provider) => this.refreshUsage(provider),
      consumeReset: (provider) => this.consumeReset(provider),
    });
    for (const [provider, alias] of configuredProviderProxies(this.readConfig())) {
      this.proxies.set(provider, alias);
    }
    if (this.proxies.size === 0) return;
    this.forwarder.start();
    for (const [provider, alias] of this.proxies) {
      this.ensureLink(alias).start();
      this.applyRoute(provider);
      log("info", `provider-proxy: ${provider} goes through ${alias}`);
    }
  }

  stop(): void {
    configureProviderProxyHooks(null);
    for (const provider of this.proxies.keys()) setProviderProxyRoute(provider, null);
    for (const timer of this.retiring.values()) clearInterval(timer);
    this.retiring.clear();
    for (const link of this.links.values()) link.close("The daemon is shutting down.");
    this.links.clear();
    this.forwarder.stop();
    this.started = false;
  }

  /**
   * What to tell a conversation on `provider` about remote_bash, or null when
   * the provider is not proxied. While its /proxy machine is the only one
   * remote_bash reaches, a call may leave host out (defaultHost).
   */
  remoteHostNotice(provider: string | undefined): { text: string; defaultHost?: string } | null {
    const alias = this.aliasFor(provider);
    if (!alias || !isProxyableProvider(provider)) return null;
    const runsOn = `This conversation's ${PROVIDER_LABELS[provider]} model runs through /proxy on ${alias}, using that machine's login. `;
    if (this.linkFor(provider)?.features.includes(PROVIDER_PROXY_LINK_ONLY_FEATURE)) {
      return { text: `${runsOn}The link carries only model requests (remote_bash is not available); every tool runs on ${hostname()}.` };
    }
    const machines = this.remoteExecAliases();
    if (machines.length > 1) {
      return { text: `${runsOn}remote_bash runs commands on the /proxy machine its host names: ${machines.join(", ")}; every other tool still runs on ${hostname()}.` };
    }
    return {
      text: `${runsOn}remote_bash runs commands on ${alias} via /proxy; host may be left out while it is the only /proxy machine. Every other tool still runs on ${hostname()}.`,
      defaultHost: alias,
    };
  }

  /** The /proxy machines remote_bash reaches, by alias: those whose link carries more than model requests. */
  remoteExecAliases(): string[] {
    const aliases = new Set<string>();
    for (const alias of this.proxies.values()) {
      if (!this.links.get(alias)?.features.includes(PROVIDER_PROXY_LINK_ONLY_FEATURE)) aliases.add(alias);
    }
    return [...aliases].sort();
  }

  /** The link to a /proxy machine, whatever its state. */
  linkForAlias(alias: string): ProviderProxyLink | null {
    return this.links.get(alias) ?? null;
  }

  aliasFor(provider: string | undefined): string | null {
    return isProxyableProvider(provider) ? this.proxies.get(provider) ?? null : null;
  }

  /** The link a proxied provider uses, whatever its state. */
  linkFor(provider: string | undefined): ProviderProxyLink | null {
    const alias = this.aliasFor(provider);
    return alias ? this.links.get(alias) ?? null : null;
  }

  list(): ProviderProxyInfo[] {
    return [...this.proxies].map(([provider, alias]) => {
      const link = this.links.get(alias);
      const remote = link?.remote[provider];
      const connected = link?.state === "connected";
      const message = !link ? undefined
        : !connected ? link.message
        : remote && !remote.loggedIn ? remote.error ?? `${alias} is not logged in to ${PROVIDER_LABELS[provider]}.`
        : undefined;
      return {
        provider,
        alias,
        state: link?.state ?? "disconnected",
        ...(message ? { message } : {}),
        ...(connected && link?.host ? { remoteHost: describeRemoteHost(link.host, alias) } : {}),
        ...(connected && remote ? { remoteLoggedIn: remote.loggedIn, remoteAccount: remote.authInfo?.email ?? null } : {}),
      };
    });
  }

  /** `/proxy <provider> <alias>`: verify the remote can serve the provider, then route it there. */
  async set(provider: string, alias: string): Promise<string> {
    if (!isProxyableProvider(provider)) {
      throw new Error(`Only ${PROXYABLE_PROVIDERS.join(" and ")} can go through /proxy.`);
    }
    const aliasError = validateSshAlias(alias);
    if (aliasError) throw new Error(aliasError);
    const label = PROVIDER_LABELS[provider];
    const previous = this.proxies.get(provider);

    const existed = this.links.has(alias);
    const link = this.ensureLink(alias, provider);
    const forget = () => {
      if (!existed && !this.isAliasUsed(alias)) {
        link.close();
        this.links.delete(alias);
        this.notify();
      }
    };
    let status: ProviderProxyRemoteStatus;
    try {
      await link.waitReady(SET_TIMEOUT_MS);
      status = await link.status(provider);
    } catch (error) {
      forget();
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (!status.loggedIn) {
      forget();
      throw new Error(`${alias} cannot serve ${label}: ${status.error ?? "it is not logged in."}`);
    }

    this.forwarder.start();
    this.updateConfig((config) => saveProviderProxy(config, provider, alias));
    this.proxies.set(provider, alias);
    this.applyRoute(provider);
    setProxiedUsage(provider, status.usage);
    if (provider === "anthropic") link.watchAccounts();
    if (previous && previous !== alias) {
      if (provider === "anthropic") this.links.get(previous)?.watchAccounts(false);
      this.retireIfUnused(previous);
    }
    this.listeners.onRouteChange?.(provider);
    this.notify();
    const account = status.authInfo?.email ? `, account ${status.authInfo.email}` : "";
    log("info", `provider-proxy: ${provider} now goes through ${alias}`);
    return `${label} now goes through ${alias} (${describeRemoteHost(link.host, alias)}${account}). `
      + "Conversations, tools and files stay on this machine; only model requests use the remote login. "
      + `Saved for future daemon starts; /proxy ${provider} off to stop.`;
  }

  /** `/proxy <provider> off`. */
  off(provider: string): string {
    if (!isProxyableProvider(provider)) throw new Error(`Only ${PROXYABLE_PROVIDERS.join(" and ")} can go through /proxy.`);
    const label = PROVIDER_LABELS[provider];
    const alias = this.proxies.get(provider);
    // Clear a saved setting even when it was not running (e.g. an invalid alias).
    this.updateConfig((config) => saveProviderProxy(config, provider, null));
    if (!alias) return `${label} is not proxied.`;
    this.proxies.delete(provider);
    setProviderProxyRoute(provider, null);
    setProxiedUsage(provider, null);
    if (provider === "anthropic") this.links.get(alias)?.watchAccounts(false);
    this.retireIfUnused(alias);
    this.listeners.onRouteChange?.(provider);
    this.notify();
    log("info", `provider-proxy: ${provider} no longer goes through ${alias}`);
    return `${label} no longer goes through ${alias}; it uses this machine's own login again.`;
  }

  async ready(provider: ProxyableProviderId, signal?: AbortSignal): Promise<ProviderProxyRemoteStatus> {
    const alias = this.proxies.get(provider);
    const link = alias ? this.links.get(alias) : undefined;
    if (!alias || !link) throw new ProviderProxyUnavailableError(`${PROVIDER_LABELS[provider]} is not proxied.`);
    await link.waitReady(READY_TIMEOUT_MS, signal);
    let status = link.remote[provider];
    // A remote that was not logged in may have been since: ask again rather than trusting the hello.
    if (!status || !status.loggedIn) status = await link.status(provider);
    if (!status.loggedIn) {
      throw new AuthError(`${alias} cannot serve ${PROVIDER_LABELS[provider]} through /proxy: ${status.error ?? "it is not logged in."}`);
    }
    return status;
  }

  remoteStatus(provider: ProxyableProviderId): ProviderProxyRemoteStatus | null {
    return this.linkFor(provider)?.remote[provider] ?? null;
  }

  /**
   * The remote's Claude pool while Claude goes through /proxy and the remote
   * shares it (the last one received while the link is down), with the link's state.
   */
  remoteAccounts(): { pool: ProviderProxyRemoteAccounts; remote: ClaudeAccountsRemoteInfo } | null {
    const pool = this.linkFor("anthropic")?.remoteAccounts;
    const info = pool ? this.list().find(proxy => proxy.provider === "anthropic") : undefined;
    if (!pool || !info) return null;
    return {
      pool,
      remote: {
        alias: info.alias,
        host: info.remoteHost ?? null,
        state: info.state,
        ...(info.message ? { message: info.message } : {}),
      },
    };
  }

  async refreshUsage(provider: ProxyableProviderId): Promise<UsageData | null> {
    const link = this.linkFor(provider);
    if (!link || link.state !== "connected") return getProxiedUsage(provider);
    const status = await link.status(provider, true);
    if (this.linkFor(provider) === link && status.usage) setProxiedUsage(provider, status.usage);
    return getProxiedUsage(provider);
  }

  async consumeReset(provider: ProxyableProviderId): Promise<{ outcome: string; windowsReset: number; remainingResets?: number }> {
    const link = this.linkFor(provider);
    if (!link) throw new Error(`${PROVIDER_LABELS[provider]} is not proxied.`);
    await link.waitReady(READY_TIMEOUT_MS);
    return link.consumeReset(provider);
  }

  private applyRoute(provider: ProxyableProviderId): void {
    const alias = this.proxies.get(provider);
    if (!alias) return;
    setProviderProxyRoute(provider, { provider, alias, baseUrl: this.forwarder.baseUrl(provider), token: this.forwarder.secret });
  }

  private ensureLink(alias: string, pending?: ProxyableProviderId): ProviderProxyLink {
    const retiring = this.retiring.get(alias);
    if (retiring) {
      clearInterval(retiring);
      this.retiring.delete(alias);
    }
    let link = this.links.get(alias);
    if (link) return link;
    link = new ProviderProxyLink(alias, {
      providers: () => {
        const providers = [...this.proxies].filter(([, value]) => value === alias).map(([provider]) => provider);
        return pending && !providers.includes(pending) ? [...providers, pending] : providers;
      },
      onAccounts: () => {
        if (this.proxies.get("anthropic") === alias) this.listeners.onAccountsChange?.();
      },
      onChange: () => {
        // A (re)connected link brings the remote's current usage for its providers.
        if (link?.state === "connected") {
          for (const [provider, value] of this.proxies) {
            const usage = value === alias ? link.remote[provider]?.usage : undefined;
            if (usage) setProxiedUsage(provider, usage);
          }
        }
        this.notify();
      },
      ...(this.options.spawnProcess ? { spawnProcess: this.options.spawnProcess } : {}),
      ...(this.options.reconnectDelaysMs ? { reconnectDelaysMs: this.options.reconnectDelaysMs } : {}),
      ...(this.options.helloTimeoutMs ? { helloTimeoutMs: this.options.helloTimeoutMs } : {}),
    });
    this.links.set(alias, link);
    return link;
  }

  private isAliasUsed(alias: string): boolean {
    return [...this.proxies.values()].includes(alias);
  }

  /** Close a link no provider uses once its in-flight streams end, so toggling does not cut a running turn. */
  private retireIfUnused(alias: string): void {
    const link = this.links.get(alias);
    if (!link || this.isAliasUsed(alias) || this.retiring.has(alias)) return;
    const startedAt = Date.now();
    const closeWhenIdle = () => {
      if (this.isAliasUsed(alias)) {
        clearInterval(timer);
        this.retiring.delete(alias);
        return;
      }
      if (link.activeStreams > 0 && Date.now() - startedAt < RETIRE_GRACE_MS) return;
      clearInterval(timer);
      this.retiring.delete(alias);
      link.close();
      if (this.links.get(alias) === link) this.links.delete(alias);
      this.notify();
    };
    const timer = setInterval(closeWhenIdle, 1_000);
    timer.unref?.();
    this.retiring.set(alias, timer);
    closeWhenIdle();
  }

  private notify(): void {
    this.listeners.onChange?.();
  }
}
