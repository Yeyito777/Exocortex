/**
 * Usage data fetching and parsing for exocortexd.
 *
 * Fetches rate-limit utilization from the Anthropic API and
 * parses usage headers from streaming responses. Pure data
 * fetching — no IPC or server knowledge.
 */

import { log } from "./log";
import type { UsageData, UsageWindow } from "./messages";

// ── API fetch ───────────────────────────────────────────────────────

const BASE_URL = "https://api.anthropic.com";

export async function fetchUsage(accessToken: string): Promise<UsageData | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/oauth/usage`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        "User-Agent": "exocortex/0.1.0",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return parseUsageResponse(data);
  } catch (err) {
    log("warn", `usage: fetch failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
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

// ── Header parsing ──────────────────────────────────────────────────

/**
 * Parse rate-limit usage from streaming response headers.
 * Returns updated UsageData, or null if no usage headers present.
 */
export function parseUsageHeaders(headers: Headers, prev: UsageData | null): UsageData | null {
  const fiveUtil = headers.get("anthropic-ratelimit-unified-5h-utilization");
  const fiveReset = headers.get("anthropic-ratelimit-unified-5h-reset");
  const sevenUtil = headers.get("anthropic-ratelimit-unified-7d-utilization");
  const sevenReset = headers.get("anthropic-ratelimit-unified-7d-reset");

  if (!fiveUtil && !sevenUtil) return null;

  const fiveHourUtil = fiveUtil ? parseFloat(fiveUtil) * 100 : null;
  const sevenDayUtil = sevenUtil ? parseFloat(sevenUtil) * 100 : null;

  return {
    fiveHour: fiveHourUtil !== null
      ? { utilization: Math.max(fiveHourUtil, prev?.fiveHour?.utilization ?? 0), resetsAt: parseResetValue(fiveReset) ?? prev?.fiveHour?.resetsAt ?? null }
      : prev?.fiveHour ?? null,
    sevenDay: sevenDayUtil !== null
      ? { utilization: Math.max(sevenDayUtil, prev?.sevenDay?.utilization ?? 0), resetsAt: parseResetValue(sevenReset) ?? prev?.sevenDay?.resetsAt ?? null }
      : prev?.sevenDay ?? null,
  };
}

// ── Shared helpers ──────────────────────────────────────────────────

function parseResetValue(val: any): number | null {
  if (val == null) return null;
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
}
