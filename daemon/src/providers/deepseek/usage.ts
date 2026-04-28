import type { UsageData } from "../../messages";

export function getLastUsage(): UsageData | null {
  return null;
}

export function clearUsage(): void {
  return;
}

export function refreshUsage(_onUpdate: (usage: UsageData) => void): void {
  return;
}

export function handleUsageHeaders(_headers: Headers, _onUpdate: (usage: UsageData) => void): void {
  return;
}
