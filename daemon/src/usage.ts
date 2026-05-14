import type { ProviderId, UsageData } from "./messages";
import { getProviderAdapter } from "./providers/catalog";

export function getLastUsage(provider: ProviderId): UsageData | null {
  return getProviderAdapter(provider).usage.getLastUsage();
}

export function refreshUsage(provider: ProviderId, onUpdate: (usage: UsageData | null) => void): void {
  getProviderAdapter(provider).usage.refreshUsage(onUpdate);
}

export function handleUsageHeaders(provider: ProviderId, headers: Headers, onUpdate: (usage: UsageData) => void): void {
  getProviderAdapter(provider).usage.handleUsageHeaders(headers, onUpdate);
}

export function clearUsage(provider: ProviderId): void {
  getProviderAdapter(provider).usage.clearUsage();
}
