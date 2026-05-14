import { join } from "path";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { runtimeDir } from "@exocortex/shared/paths";
import { log } from "../../log";
import type { UsageData, UsageWindow } from "../../messages";
import { getCurrentAccountKey } from "./auth";

const USAGE_FILE = join(runtimeDir(), "usage-openai.json");
const DEFAULT_LIMIT_PREFIX = "x-codex";
const LEGACY_ACCOUNT_KEY = "__legacy__";
export const OPENAI_USAGE_ACCOUNT_KEY_HEADER = "x-exocortex-openai-account-key";

interface UsageStore {
  version: 2;
  byAccount: Record<string, UsageData>;
}

const PRIMARY_PERCENT_HEADERS = [
  "primary-used-percent",
  "primary-over-secondary-limit-percent",
] as const;

const SECONDARY_PERCENT_HEADERS = [
  "secondary-used-percent",
  "secondary-over-primary-limit-percent",
] as const;

function isUsageData(value: unknown): value is UsageData {
  return typeof value === "object" && value !== null && ("fiveHour" in value || "sevenDay" in value);
}

function loadFromDisk(): UsageStore {
  try {
    if (!existsSync(USAGE_FILE)) return { version: 2, byAccount: {} };
    const parsed = JSON.parse(readFileSync(USAGE_FILE, "utf-8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && "byAccount" in parsed) {
      return parsed as UsageStore;
    }
    if (isUsageData(parsed)) {
      return { version: 2, byAccount: { [LEGACY_ACCOUNT_KEY]: parsed } };
    }
  } catch {
    // fall through
  }
  return { version: 2, byAccount: {} };
}

function saveToDisk(store: UsageStore): void {
  try {
    writeFileSync(USAGE_FILE, JSON.stringify(store));
  } catch {
    // best-effort
  }
}

let usageStore: UsageStore = loadFromDisk();
let resetTimer: ReturnType<typeof setTimeout> | null = null;

export function getLastUsage(): UsageData | null {
  return usageForCurrentAccount();
}

export function clearUsage(): void {
  usageStore = { version: 2, byAccount: {} };
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

function currentAccountKey(): string {
  return getCurrentAccountKey() ?? LEGACY_ACCOUNT_KEY;
}

function accountKeyFromHeaders(headers: Headers): string {
  return headers.get(OPENAI_USAGE_ACCOUNT_KEY_HEADER)?.trim() || currentAccountKey();
}

function usageForCurrentAccount(): UsageData | null {
  return usageForAccount(currentAccountKey());
}

function usageForAccount(accountKey: string): UsageData | null {
  return usageStore.byAccount[accountKey] ?? null;
}

function isCurrentAccount(accountKey: string): boolean {
  return accountKey === currentAccountKey();
}

function clearResetTimer(): void {
  if (!resetTimer) return;
  clearTimeout(resetTimer);
  resetTimer = null;
}

function commitUsageForAccount(accountKey: string, usage: UsageData, onUpdate: (usage: UsageData) => void): void {
  usageStore.byAccount[accountKey] = usage;
  saveToDisk(usageStore);
  if (isCurrentAccount(accountKey)) {
    onUpdate(usage);
    scheduleResetRefresh(accountKey, onUpdate);
  }
}

function scheduleResetRefresh(accountKey: string, onUpdate: (usage: UsageData) => void): void {
  clearResetTimer();

  const now = Date.now();
  const lastUsage = usageForAccount(accountKey);
  const candidates = [lastUsage?.fiveHour?.resetsAt, lastUsage?.sevenDay?.resetsAt]
    .filter((timestamp): timestamp is number => timestamp != null && timestamp > now);

  if (candidates.length === 0) return;

  const earliest = Math.min(...candidates);
  const delay = earliest - now + 5_000;
  resetTimer = setTimeout(() => {
    resetTimer = null;
    if (!lastUsage) return;
    const nextUsage = {
      fiveHour: normalizeExpiredWindow(lastUsage.fiveHour, Date.now()),
      sevenDay: normalizeExpiredWindow(lastUsage.sevenDay, Date.now()),
    };
    if (JSON.stringify(nextUsage) === JSON.stringify(lastUsage)) {
      if (isCurrentAccount(accountKey)) scheduleResetRefresh(accountKey, onUpdate);
      return;
    }
    log("info", "openai usage: reset boundary reached, zeroing expired windows");
    commitUsageForAccount(accountKey, nextUsage, onUpdate);
  }, delay);
}

function normalizeExpiredWindow(window: UsageWindow | null, now: number): UsageWindow | null {
  if (!window) return null;
  if (window.resetsAt != null && window.resetsAt <= now) {
    return {
      utilization: 0,
      resetsAt: null,
    };
  }
  return window;
}

export function refreshUsage(onUpdate: (usage: UsageData | null) => void): void {
  clearResetTimer();
  const accountKey = currentAccountKey();
  const usage = usageForAccount(accountKey);
  onUpdate(usage);
  if (usage) scheduleResetRefresh(accountKey, onUpdate);
}

export function handleUsageHeaders(headers: Headers, onUpdate: (usage: UsageData) => void): void {
  const accountKey = accountKeyFromHeaders(headers);
  const usage = parseHeaders(headers, accountKey);
  if (!usage) return;
  commitUsageForAccount(accountKey, usage, onUpdate);
}

function parseHeaders(headers: Headers, accountKey = currentAccountKey()): UsageData | null {
  const prefix = resolveLimitPrefix(headers);
  const previous = usageForAccount(accountKey);

  const fiveHour = parseWindow(
    getFirstPresentHeader(headers, headerCandidates(prefix, PRIMARY_PERCENT_HEADERS)),
    getFirstPresentHeader(headers, headerCandidates(prefix, ["primary-reset-at"])),
    previous?.fiveHour,
  );
  const sevenDay = parseWindow(
    getFirstPresentHeader(headers, headerCandidates(prefix, SECONDARY_PERCENT_HEADERS)),
    getFirstPresentHeader(headers, headerCandidates(prefix, ["secondary-reset-at"])),
    previous?.sevenDay,
  );

  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

function resolveLimitPrefix(headers: Headers): string {
  const activeLimit = headers.get("x-codex-active-limit")?.trim();
  if (!activeLimit || activeLimit === "codex") return DEFAULT_LIMIT_PREFIX;
  return `x-${activeLimit.toLowerCase().replaceAll("_", "-")}`;
}

function headerCandidates(prefix: string, suffixes: readonly string[]): string[] {
  const names = suffixes.map((suffix) => `${prefix}-${suffix}`);
  if (prefix !== DEFAULT_LIMIT_PREFIX) {
    names.push(...suffixes.map((suffix) => `${DEFAULT_LIMIT_PREFIX}-${suffix}`));
  }
  return names;
}

function getFirstPresentHeader(headers: Headers, names: readonly string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value != null) return value;
  }
  return null;
}

function parseWindow(percentValue: string | null, resetAtValue: string | null, previous?: UsageWindow | null): UsageWindow | null {
  if (!percentValue && !resetAtValue) return previous ?? null;
  const utilization = parsePercent(percentValue);
  if (utilization === null) return previous ?? null;
  return {
    utilization,
    resetsAt: parseResetValue(resetAtValue) ?? previous?.resetsAt ?? null,
  };
}

function parsePercent(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
}

function parseResetValue(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed < 1e12 ? parsed * 1000 : parsed;
  const asDate = new Date(value);
  return Number.isNaN(asDate.getTime()) ? null : asDate.getTime();
}
