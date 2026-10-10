/**
 * Claude subscription usage.
 *
 * Claude Code exposes no HTTP response headers, but it streams
 * `rate_limit_event` messages. The stream processor forwards each one through
 * the normal onHeaders path as a synthetic header so the daemon's usage
 * plumbing (caching, broadcasting to clients) works unchanged.
 *
 * Before any turn has run, the usage comes from Claude Code itself: a bare
 * process that never prompts the model answers the `/usage` control request.
 * The last snapshot is kept on disk so it shows as soon as a client connects.
 */

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { runtimeDir } from "@exocortex/shared/paths";
import type { UsageData, UsageWindow } from "../../messages";
import { hasConfiguredCredentials } from "./auth";
import { claudeProcessOptions } from "./cli";

export const CLAUDE_RATE_LIMIT_HEADER = "x-exocortex-claude-rate-limit";

const USAGE_FILE = join(runtimeDir(), "usage-anthropic.json");
const REMOTE_USAGE_REFRESH_TTL_MS = 60_000;
const REMOTE_USAGE_TIMEOUT_MS = 30_000;

let lastUsage: UsageData | null = loadFromDisk();
let lastUpdatedAt = 0;
let usageGeneration = 0;
let remoteRefresh: Promise<UsageData | null> | null = null;

function loadFromDisk(): UsageData | null {
  try {
    if (!existsSync(USAGE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(USAGE_FILE, "utf-8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && ("fiveHour" in parsed || "sevenDay" in parsed)) {
      return parsed as UsageData;
    }
  } catch {
    // fall through
  }
  return null;
}

function commitUsage(usage: UsageData): void {
  lastUsage = usage;
  lastUpdatedAt = Date.now();
  try {
    writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch {
    // best-effort
  }
}

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

interface PlanRateLimitWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

function toPlanWindow(window: PlanRateLimitWindow | null | undefined): UsageWindow | null {
  if (!window || typeof window.utilization !== "number") return null;
  // The `/usage` control request reports utilization as 0–100 and resets_at as ISO 8601.
  const resetsAt = window.resets_at ? Date.parse(window.resets_at) : Number.NaN;
  return {
    utilization: Math.round(window.utilization * 10) / 10,
    resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
  };
}

/** Parse the `rate_limits` of Claude Code's `get_usage` control response into usage windows. */
export function usageFromPlanRateLimits(rateLimits: Record<string, unknown> | null | undefined, previous: UsageData | null = null): UsageData | null {
  if (!rateLimits) return null;
  const fiveHour = toPlanWindow(rateLimits.five_hour as PlanRateLimitWindow | null | undefined);
  const sevenDay = toPlanWindow(rateLimits.seven_day as PlanRateLimitWindow | null | undefined);
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
  usageGeneration += 1;
  lastUsage = null;
  lastUpdatedAt = 0;
  remoteRefresh = null;
  try {
    if (existsSync(USAGE_FILE)) unlinkSync(USAGE_FILE);
  } catch {
    // best-effort
  }
}

export function refreshUsage(onUpdate: (usage: UsageData | null) => void): void {
  onUpdate(lastUsage);
}

/** Streaming input that stays silent until `signal` aborts, so Claude Code never prompts the model. */
function silentInput(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  const done = { done: true, value: undefined } as const;
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        if (signal.aborted) resolve(done);
        else signal.addEventListener("abort", () => resolve(done), { once: true });
      }),
    }),
  };
}

/** Ask a bare Claude Code process for the plan's rate limits (the data behind `/usage`). */
async function fetchPlanRateLimits(): Promise<Record<string, unknown> | null> {
  const stop = new AbortController();
  const runtime = query({
    prompt: silentInput(stop.signal),
    options: {
      ...claudeProcessOptions(process.cwd()),
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      runtime.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Claude Code did not report usage in time")), REMOTE_USAGE_TIMEOUT_MS);
      }),
    ]);
    return response.rate_limits_available ? response.rate_limits as Record<string, unknown> | null : null;
  } finally {
    clearTimeout(timer);
    stop.abort();
    try { runtime.close(); } catch { /* best-effort */ }
  }
}

export async function refreshRemoteUsage(): Promise<UsageData | null> {
  // Turns keep the usage current through rate_limit_events; only ask when it is stale.
  if (Date.now() - lastUpdatedAt < REMOTE_USAGE_REFRESH_TTL_MS) return lastUsage;
  if (remoteRefresh) return remoteRefresh;
  if (!hasConfiguredCredentials()) return lastUsage;

  const generation = usageGeneration;
  const refresh = (async () => {
    const usage = usageFromPlanRateLimits(await fetchPlanRateLimits(), lastUsage);
    if (generation !== usageGeneration) return lastUsage;
    if (usage) commitUsage(usage);
    return lastUsage;
  })();
  remoteRefresh = refresh;
  void refresh.finally(() => {
    if (remoteRefresh === refresh) remoteRefresh = null;
  }).catch(() => {});
  return refresh;
}

export function handleUsageHeaders(headers: Headers, onUpdate: (usage: UsageData) => void): void {
  const raw = headers.get(CLAUDE_RATE_LIMIT_HEADER);
  if (!raw) return;
  try {
    const usage = usageFromRateLimitInfo(JSON.parse(raw) as Record<string, unknown>, lastUsage);
    if (!usage) return;
    commitUsage(usage);
    onUpdate(usage);
  } catch {
    // Malformed synthetic header; keep the previous usage snapshot.
  }
}
