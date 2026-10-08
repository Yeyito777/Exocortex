/**
 * Claude subscription usage.
 *
 * Claude Code exposes no HTTP response headers, but it streams
 * `rate_limit_event` messages. The stream processor forwards each one through
 * the normal onHeaders path as a synthetic header so the daemon's usage
 * plumbing (caching, broadcasting to clients) works unchanged.
 */

import type { UsageData, UsageWindow } from "../../messages";

export const CLAUDE_RATE_LIMIT_HEADER = "x-exocortex-claude-rate-limit";

let lastUsage: UsageData | null = null;

interface RateLimitWindow {
  utilization?: number | null;
  resetsAt?: number | null;
}

function toWindow(window: RateLimitWindow | null | undefined): UsageWindow | null {
  if (!window || typeof window.utilization !== "number") return null;
  // Claude Code reports utilization as a 0–1 fraction and resetsAt in epoch seconds.
  const percent = window.utilization <= 1 ? window.utilization * 100 : window.utilization;
  return {
    utilization: Math.round(percent * 10) / 10,
    resetsAt: typeof window.resetsAt === "number" ? window.resetsAt * 1000 : null,
  };
}

/** Parse an SDK `rate_limit_event`'s rate_limit_info into usage windows. */
export function usageFromRateLimitInfo(info: Record<string, unknown>, previous: UsageData | null = null): UsageData | null {
  const windows = (info.unifiedWindows ?? {}) as Record<string, RateLimitWindow | undefined>;
  const fiveHour = toWindow(windows.five_hour);
  const sevenDay = toWindow(windows.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return {
    fiveHour: fiveHour ?? previous?.fiveHour ?? null,
    sevenDay: sevenDay ?? previous?.sevenDay ?? null,
  };
}

export function getLastUsage(): UsageData | null {
  return lastUsage;
}

export function clearUsage(): void {
  lastUsage = null;
}

export function refreshUsage(onUpdate: (usage: UsageData | null) => void): void {
  onUpdate(lastUsage);
}

export function handleUsageHeaders(headers: Headers, onUpdate: (usage: UsageData) => void): void {
  const raw = headers.get(CLAUDE_RATE_LIMIT_HEADER);
  if (!raw) return;
  try {
    const usage = usageFromRateLimitInfo(JSON.parse(raw) as Record<string, unknown>, lastUsage);
    if (!usage) return;
    lastUsage = usage;
    onUpdate(usage);
  } catch {
    // Malformed synthetic header; keep the previous usage snapshot.
  }
}
