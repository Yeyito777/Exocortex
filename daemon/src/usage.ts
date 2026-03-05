/**
 * Usage data fetching, parsing, and caching for exocortexd.
 *
 * Fetches rate-limit utilization from the Anthropic API,
 * parses usage headers from streaming responses, and caches
 * the latest usage state. Broadcasting is injected via callbacks
 * — this file has no IPC or server knowledge.
 */

import { log } from "./log";
import { loadAuth } from "./store";
import type { UsageData, UsageWindow } from "./messages";

// ── Cached state ───────────────────────────────────────────────────

let lastUsage: UsageData | null = null;

/** Return the last known usage data (may be null before first fetch). */
export function getLastUsage(): UsageData | null {
  return lastUsage;
}

// ── Refresh (full API fetch) ───────────────────────────────────────

const BASE_URL = "https://api.anthropic.com";

/**
 * Fetch latest usage from the Anthropic API and cache it.
 * Calls onUpdate if new data is received.
 */
export function refreshUsage(onUpdate: (usage: UsageData) => void): void {
  const auth = loadAuth();
  if (!auth?.tokens?.accessToken) {
    log("warn", "usage: no access token, skipping refresh");
    return;
  }

  fetchUsage(auth.tokens.accessToken).then((usage) => {
    if (usage) {
      lastUsage = usage;
      onUpdate(usage);
    } else {
      log("warn", "usage: fetch returned null");
    }
  });
}

async function fetchUsage(accessToken: string): Promise<UsageData | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/oauth/usage`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        "User-Agent": "claude-code/2.1.68",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      if (res.status === 429) log("info", "usage: endpoint 429'd, will use streaming headers");
      else log("warn", `usage: API returned ${res.status} ${res.statusText}`);
      return null;
    }
    const data = await res.json();
    log("info", `usage: fetched (5h=${data?.five_hour?.utilization}, 7d=${data?.seven_day?.utilization})`);
    return parseUsageResponse(data);
  } catch (err) {
    log("warn", `usage: fetch failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── Header parsing (mid-stream updates) ─────────────────────────────

/**
 * Parse rate-limit usage from streaming response headers and cache it.
 * Calls onUpdate if usage data was found in the headers.
 */
export function handleUsageHeaders(headers: Headers, onUpdate: (usage: UsageData) => void): void {
  const usage = parseHeaders(headers);
  if (usage) {
    lastUsage = usage;
    onUpdate(usage);
  }
}

function parseHeaders(headers: Headers): UsageData | null {
  const fiveUtil = headers.get("anthropic-ratelimit-unified-5h-utilization");
  const fiveReset = headers.get("anthropic-ratelimit-unified-5h-reset");
  const sevenUtil = headers.get("anthropic-ratelimit-unified-7d-utilization");
  const sevenReset = headers.get("anthropic-ratelimit-unified-7d-reset");

  if (!fiveUtil && !sevenUtil) return null;

  const fiveHourUtil = fiveUtil ? parseFloat(fiveUtil) * 100 : null;
  const sevenDayUtil = sevenUtil ? parseFloat(sevenUtil) * 100 : null;

  return {
    fiveHour: fiveHourUtil !== null
      ? { utilization: Math.max(fiveHourUtil, lastUsage?.fiveHour?.utilization ?? 0), resetsAt: parseResetValue(fiveReset) ?? lastUsage?.fiveHour?.resetsAt ?? null }
      : lastUsage?.fiveHour ?? null,
    sevenDay: sevenDayUtil !== null
      ? { utilization: Math.max(sevenDayUtil, lastUsage?.sevenDay?.utilization ?? 0), resetsAt: parseResetValue(sevenReset) ?? lastUsage?.sevenDay?.resetsAt ?? null }
      : lastUsage?.sevenDay ?? null,
  };
}

// ── Response parsing ────────────────────────────────────────────────

function parseUsageResponse(data: any): UsageData {
  return {
    fiveHour: parseWindow(data?.five_hour),
    sevenDay: parseWindow(data?.seven_day),
  };
}

function parseWindow(w: any): UsageWindow | null {
  if (!w || typeof w.utilization !== "number") return null;
  return {
    utilization: w.utilization,
    resetsAt: parseResetValue(w.resets_at),
  };
}

function parseResetValue(val: any): number | null {
  if (val == null) return null;
  if (typeof val === "number") {
    // Unix timestamps in seconds (< 1e12) vs milliseconds (>= 1e12)
    return val < 1e12 ? val * 1000 : val;
  }
  if (typeof val === "string") {
    const num = Number(val);
    if (!isNaN(num)) return num < 1e12 ? num * 1000 : num;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
}
