import type { ProviderId, UsageData } from "./messages";
import { getProviderAdapter } from "./providers/catalog";
import type { UsageResetOutcome } from "./protocol";
import { log } from "./log";
import { getProxiedUsage, providerProxyHooks, providerProxyRoute, proxiedClaudeAccounts, setProxiedUsage } from "./provider-proxy/route";
import { withProxyDownCredits } from "./providers/anthropic/account-pool";

// A provider that goes through /proxy reports the remote account's usage: the
// remote answers refreshes, and response headers that come back through the
// link update the same proxied copy (see provider-proxy/route.ts). For Claude,
// a remote that shares its account pool shows the pool's combined usage, as
// it does on the remote itself; otherwise its main account's. While Claude's
// turns run on this machine's keys instead (`whenProxyDown`), their credits show.

function proxiedUsage(provider: ProviderId): UsageData | null {
  const route = providerProxyRoute(provider);
  if (!route) return null;
  if (route.provider !== "anthropic") return getProxiedUsage(route.provider);
  return withProxyDownCredits(proxiedClaudeAccounts()?.pool.combined ?? getProxiedUsage(route.provider));
}

export function getLastUsage(provider: ProviderId): UsageData | null {
  if (providerProxyRoute(provider)) return proxiedUsage(provider);
  return getProviderAdapter(provider).usage.getLastUsage();
}

export function refreshUsage(provider: ProviderId, onUpdate: (usage: UsageData | null) => void): void {
  const route = providerProxyRoute(provider);
  if (route) {
    onUpdate(proxiedUsage(provider));
    const hooks = providerProxyHooks();
    if (!hooks) return;
    void hooks.refreshUsage(route.provider)
      .then(() => { if (providerProxyRoute(provider) === route) onUpdate(proxiedUsage(provider)); })
      .catch((err) => {
        log("debug", `${provider} proxied usage refresh failed: ${err instanceof Error ? err.message : err}`);
      });
    return;
  }
  const adapter = getProviderAdapter(provider).usage;
  adapter.refreshUsage(onUpdate);
  if (adapter.refreshRemoteUsage) {
    void adapter.refreshRemoteUsage()
      .then(onUpdate)
      .catch((err) => {
        log("debug", `${provider} remote usage refresh failed: ${err instanceof Error ? err.message : err}`);
      });
  }
}

export async function consumeUsageReset(
  provider: ProviderId,
): Promise<{ outcome: UsageResetOutcome; windowsReset: number; remainingResets?: number }> {
  const route = providerProxyRoute(provider);
  const hooks = providerProxyHooks();
  if (route && hooks) {
    const result = await hooks.consumeReset(route.provider);
    await hooks.refreshUsage(route.provider).catch(() => null);
    return result as { outcome: UsageResetOutcome; windowsReset: number; remainingResets?: number };
  }
  const consumeReset = getProviderAdapter(provider).usage.consumeReset;
  if (!consumeReset) throw new Error(`Usage resets are not supported for ${provider}.`);
  return consumeReset();
}

export function handleUsageHeaders(provider: ProviderId, headers: Headers, onUpdate: (usage: UsageData) => void): void {
  const route = providerProxyRoute(provider);
  if (route) {
    getProviderAdapter(provider).usage.handleUsageHeaders(headers, (usage) => {
      if (providerProxyRoute(provider) !== route) return;
      setProxiedUsage(route.provider, usage);
      onUpdate(proxiedUsage(provider) ?? usage);
    });
    return;
  }
  getProviderAdapter(provider).usage.handleUsageHeaders(headers, onUpdate);
}

export function clearUsage(provider: ProviderId): void {
  const route = providerProxyRoute(provider);
  if (route) setProxiedUsage(route.provider, null);
  getProviderAdapter(provider).usage.clearUsage();
}
