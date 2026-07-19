import type { ProviderId, UsageData } from "./messages";
import { getProviderAdapter } from "./providers/catalog";
import type { UsageResetOutcome } from "./protocol";
import { log } from "./log";

export function getLastUsage(provider: ProviderId): UsageData | null {
  return getProviderAdapter(provider).usage.getLastUsage();
}

export function refreshUsage(provider: ProviderId, onUpdate: (usage: UsageData | null) => void): void {
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
  const consumeReset = getProviderAdapter(provider).usage.consumeReset;
  if (!consumeReset) throw new Error(`Usage resets are not supported for ${provider}.`);
  return consumeReset();
}

export function handleUsageHeaders(provider: ProviderId, headers: Headers, onUpdate: (usage: UsageData) => void): void {
  getProviderAdapter(provider).usage.handleUsageHeaders(headers, onUpdate);
}

export function clearUsage(provider: ProviderId): void {
  getProviderAdapter(provider).usage.clearUsage();
}
