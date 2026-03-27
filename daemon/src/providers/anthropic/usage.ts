/**
 * Usage data fetching, parsing, and caching for Anthropic-backed conversations.
 */

import { join } from "path";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { log } from "../../log";
import { loadAuth } from "../../store";
import { runtimeDir } from "@exocortex/shared/paths";
import { ANTHROPIC_BASE_URL } from "./constants";
import type { UsageData, UsageWindow } from "../../messages";

const USAGE_FILE = join(runtimeDir(), "usage-anthropic.json");

function loadFromDisk(): UsageData | null {
  try {
    if (!existsSync(USAGE_FILE)) return null;
    return JSON.parse(readFileSync(USAGE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveToDisk(usage: UsageData): void {
  try {
    writeFileSync(USAGE_FILE, JSON.stringify(usage));
  } catch {
    // best-effort
  }
}

let lastUsage: UsageData | null = loadFromDisk();

export function getLastUsage(): UsageData | null {
  return lastUsage;
}

export function clearUsage(): void {
  lastUsage = null;
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = null;
  }
  try {
    if (existsSync(USAGE_FILE)) unlinkSync(USAGE_FILE);
  } catch {
    // best-effort
  }
}

function commitUsage(usage: UsageData, onUpdate: (u: UsageData) => void): void {
  lastUsage = usage;
  saveToDisk(usage);
  onUpdate(usage);
  scheduleResetRefresh(usage, onUpdate);
}

let resetTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleResetRefresh(usage: UsageData, onUpdate: (u: UsageData) => void): void {
  if (resetTimer) clearTimeout(resetTimer);

  const now = Date.now();
  const candidates = [usage.fiveHour?.resetsAt, usage.sevenDay?.resetsAt]
    .filter((t): t is number => t != null && t > now);

  if (candidates.length === 0) return;

  const earliest = Math.min(...candidates);
  const delay = earliest - now + 5_000;

  log("info", `usage: scheduling re-poll in ${Math.round(delay / 1000)}s (at reset boundary)`);
  resetTimer = setTimeout(() => {
    resetTimer = null;
    refreshUsage(onUpdate);
  }, delay);
}

export function refreshUsage(onUpdate: (usage: UsageData) => void): void {
  const auth = loadAuth();
  if (!auth?.tokens?.accessToken) {
    log("warn", "usage: no access token, skipping refresh");
    return;
  }

  fetchUsage(auth.tokens.accessToken).then((usage) => {
    if (usage) {
      commitUsage(usage, onUpdate);
    } else {
      log("warn", "usage: fetch returned null");
    }
  });
}

async function fetchUsage(accessToken: string): Promise<UsageData | null> {
  try {
    const res = await fetch(`${ANTHROPIC_BASE_URL}/api/oauth/usage`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        "User-Agent": "exocortex/0.1.0",
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

export function handleUsageHeaders(headers: Headers, onUpdate: (usage: UsageData) => void): void {
  const usage = parseHeaders(headers);
  if (usage) {
    commitUsage(usage, onUpdate);
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

function parseUsageResponse(data: unknown): UsageData {
  const obj = data as Record<string, unknown> | null | undefined;
  return {
    fiveHour: parseWindow(obj?.five_hour, lastUsage?.fiveHour),
    sevenDay: parseWindow(obj?.seven_day, lastUsage?.sevenDay),
  };
}

function parseWindow(w: unknown, prev?: UsageWindow | null): UsageWindow | null {
  if (!w || typeof w !== "object") return null;
  const obj = w as Record<string, unknown>;
  if (typeof obj.utilization !== "number") return null;
  return {
    utilization: obj.utilization,
    resetsAt: parseResetValue(obj.resets_at) ?? prev?.resetsAt ?? null,
  };
}

function parseResetValue(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === "number") {
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
