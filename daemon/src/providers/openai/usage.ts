import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { runtimeDir } from "@exocortex/shared/paths";
import type { UsageData, UsageResetCredits, UsageWindow } from "../../messages";
import type { UsageResetOutcome } from "../../protocol";
import { getCurrentAccountKey, getVerifiedSession, type VerifiedOpenAISession } from "./auth";
import {
  OPENAI_USAGE_RESET_CONSUME_URL,
  OPENAI_USAGE_RESET_CREDITS_URL,
  OPENAI_USAGE_URL,
} from "./constants";
import { buildCloudflareCookieHeader, storeCloudflareCookiesFromHeaders } from "./cookies";
import { buildOpenAIJsonHeaders, parseOpenAIJson } from "./http";

const USAGE_FILE = join(runtimeDir(), "usage-openai.json");
const DEFAULT_LIMIT_PREFIX = "x-codex";
const LEGACY_ACCOUNT_KEY = "__legacy__";
export const OPENAI_USAGE_ACCOUNT_KEY_HEADER = "x-exocortex-openai-account-key";

const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const SEVEN_DAY_WINDOW_MINUTES = 7 * 24 * 60;
const REMOTE_USAGE_REFRESH_TTL_MS = 60_000;
const REMOTE_USAGE_TIMEOUT_MS = 10_000;

interface UsageStore {
  version: 2;
  byAccount: Record<string, UsageData>;
}

interface OpenAIRemoteUsagePayload {
  rate_limit?: unknown;
  rate_limit_reset_credits?: unknown;
}

interface OpenAIResetCreditDetailsPayload {
  credits?: unknown;
  available_count?: unknown;
}

interface OpenAIConsumeResetPayload {
  code?: unknown;
  windows_reset?: unknown;
}

interface OpenAIRemoteUsageResponses {
  usage: OpenAIRemoteUsagePayload | null;
  details: OpenAIResetCreditDetailsPayload | null;
}

type OpenAIUsageFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const PRIMARY_PERCENT_HEADERS = [
  "primary-used-percent",
  "primary-over-secondary-limit-percent",
] as const;

const SECONDARY_PERCENT_HEADERS = [
  "secondary-used-percent",
  "secondary-over-primary-limit-percent",
] as const;

let usageFetchOverride: OpenAIUsageFetch | null = null;
let usageGeneration = 0;
const remoteRefreshes = new Map<string, Promise<UsageData | null>>();
const lastRemoteRefreshAt = new Map<string, number>();

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

export function getLastUsage(): UsageData | null {
  return usageForCurrentAccount();
}

export function clearUsage(): void {
  usageGeneration += 1;
  usageStore = { version: 2, byAccount: {} };
  remoteRefreshes.clear();
  lastRemoteRefreshAt.clear();
  try {
    if (existsSync(USAGE_FILE)) unlinkSync(USAGE_FILE);
  } catch {
    // best-effort
  }
}

function currentAccountKey(): string {
  return getCurrentAccountKey() ?? LEGACY_ACCOUNT_KEY;
}

function accountKeyForSession(session: VerifiedOpenAISession): string {
  return session.accountKey?.trim() || LEGACY_ACCOUNT_KEY;
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

function saveUsageForAccount(accountKey: string, usage: UsageData): void {
  usageStore.byAccount[accountKey] = usage;
  saveToDisk(usageStore);
}

function commitUsageForAccount(accountKey: string, usage: UsageData, onUpdate: (usage: UsageData) => void): void {
  saveUsageForAccount(accountKey, usage);
  if (isCurrentAccount(accountKey)) onUpdate(usage);
}

/** Emit the per-account cache synchronously. Remote refreshes are orchestrated by daemon/src/usage.ts. */
export function refreshUsage(onUpdate: (usage: UsageData | null) => void): void {
  onUpdate(usageForCurrentAccount());
}

export async function refreshRemoteUsage(): Promise<UsageData | null> {
  const session = await getVerifiedSession();
  const accountKey = accountKeyForSession(session);
  await refreshRemoteUsageForSession(session);
  return isCurrentAccount(accountKey) ? usageForAccount(accountKey) : usageForCurrentAccount();
}

async function refreshRemoteUsageForSession(
  session: VerifiedOpenAISession,
  options: { force?: boolean } = {},
): Promise<UsageData | null> {
  const accountKey = accountKeyForSession(session);
  const now = Date.now();
  const lastRefresh = lastRemoteRefreshAt.get(accountKey) ?? 0;
  if (!options.force && now - lastRefresh < REMOTE_USAGE_REFRESH_TTL_MS) {
    return usageForAccount(accountKey);
  }

  const existing = remoteRefreshes.get(accountKey);
  if (existing && !options.force) return existing;
  if (existing) {
    try {
      await existing;
    } catch {
      // A forced post-consume refresh still gets its own attempt.
    }
  }

  const generation = usageGeneration;
  const refresh = (async () => {
    const responses = await fetchRemoteUsage(session);
    const usage = mergeRemoteUsage(
      usageForAccount(accountKey),
      responses.usage,
      responses.details,
      Date.now(),
    );
    if (generation !== usageGeneration) return usageForAccount(accountKey);
    saveUsageForAccount(accountKey, usage);
    lastRemoteRefreshAt.set(accountKey, Date.now());
    return usage;
  })();
  remoteRefreshes.set(accountKey, refresh);
  void refresh.finally(() => {
    if (remoteRefreshes.get(accountKey) === refresh) remoteRefreshes.delete(accountKey);
  }).catch(() => {});
  return refresh;
}

async function fetchRemoteUsage(
  session: VerifiedOpenAISession,
): Promise<OpenAIRemoteUsageResponses> {
  const [usageResult, detailsResult] = await Promise.allSettled([
    fetchOpenAIJson<OpenAIRemoteUsagePayload>(OPENAI_USAGE_URL, session),
    fetchOpenAIJson<OpenAIResetCreditDetailsPayload>(OPENAI_USAGE_RESET_CREDITS_URL, session),
  ]);

  if (usageResult.status === "rejected" && detailsResult.status === "rejected") {
    throw new Error(
      `OpenAI usage endpoints failed: ${errorMessage(usageResult.reason)}; ${errorMessage(detailsResult.reason)}`,
    );
  }

  return {
    usage: usageResult.status === "fulfilled" ? usageResult.value : null,
    details: detailsResult.status === "fulfilled" ? detailsResult.value : null,
  };
}

async function fetchOpenAIJson<T>(
  url: string,
  session: VerifiedOpenAISession,
  init: RequestInit = {},
): Promise<T> {
  const headers = buildOpenAIJsonHeaders({
    Authorization: `Bearer ${session.accessToken}`,
    ...(session.accountId ? { "ChatGPT-Account-ID": session.accountId } : {}),
    ...headersToRecord(init.headers),
  });
  const cookie = buildCloudflareCookieHeader(url);
  if (cookie) headers.Cookie = cookie;

  const response = await (usageFetchOverride ?? fetch)(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(REMOTE_USAGE_TIMEOUT_MS),
  });
  storeCloudflareCookiesFromHeaders(url, response.headers);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${url} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return parseOpenAIJson<T>(text, `OpenAI usage endpoint ${url}`);
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeRemoteUsage(
  previous: UsageData | null,
  payload: OpenAIRemoteUsagePayload | null,
  details: OpenAIResetCreditDetailsPayload | null,
  now: number,
): UsageData {
  const windows = remoteWindows(payload, previous, now);
  const resetCredits = remoteResetCredits(payload, details, previous?.resetCredits);
  return {
    fiveHour: windows.fiveHour,
    sevenDay: windows.sevenDay,
    ...(resetCredits !== undefined ? { resetCredits } : {}),
  };
}

function remoteWindows(
  payload: OpenAIRemoteUsagePayload | null,
  previous: UsageData | null,
  now: number,
): Pick<UsageData, "fiveHour" | "sevenDay"> {
  const fallback = {
    fiveHour: previous?.fiveHour ?? null,
    sevenDay: previous?.sevenDay ?? null,
  };
  const rateLimit = asRecord(payload?.rate_limit);
  if (!rateLimit) return fallback;

  const primary = parseRemoteWindow(rateLimit.primary_window, now);
  const secondary = parseRemoteWindow(rateLimit.secondary_window, now);
  if (!primary && !secondary) return fallback;

  const hasDurationMetadata = primary?.durationMinutes != null || secondary?.durationMinutes != null;
  if (hasDurationMetadata) {
    const observed = [primary, secondary].filter((window): window is ObservedUsageWindow => window !== null);
    const fiveHour = observed.find((window) => window.durationMinutes === FIVE_HOUR_WINDOW_MINUTES) ?? null;
    const sevenDay = observed.find((window) => window.durationMinutes === SEVEN_DAY_WINDOW_MINUTES) ?? null;
    const positionalFiveHour = fiveHour ?? (primary !== sevenDay ? primary : null);
    const positionalSevenDay = sevenDay ?? (secondary !== fiveHour ? secondary : null);
    const primaryIsSevenDay = primary?.durationMinutes === SEVEN_DAY_WINDOW_MINUTES;
    return {
      fiveHour: positionalFiveHour
        ? toUsageWindow(positionalFiveHour, previous?.fiveHour)
        : primaryIsSevenDay ? null : previous?.fiveHour ?? null,
      sevenDay: positionalSevenDay
        ? toUsageWindow(positionalSevenDay, previous?.sevenDay)
        : previous?.sevenDay ?? null,
    };
  }

  return {
    fiveHour: primary ? toUsageWindow(primary, previous?.fiveHour) : previous?.fiveHour ?? null,
    sevenDay: secondary ? toUsageWindow(secondary, previous?.sevenDay) : previous?.sevenDay ?? null,
  };
}

function remoteResetCredits(
  payload: OpenAIRemoteUsagePayload | null,
  details: OpenAIResetCreditDetailsPayload | null,
  previous: UsageResetCredits | null | undefined,
): UsageResetCredits | null | undefined {
  const detailedCount = parseAvailableCount(details?.available_count);
  if (detailedCount !== null) {
    return {
      availableCount: detailedCount,
      nextExpiresAt: detailedCount > 0 ? nextAvailableExpiry(details?.credits) : null,
    };
  }

  const summary = asRecord(payload?.rate_limit_reset_credits);
  const summaryCount = parseAvailableCount(summary?.available_count);
  if (summaryCount !== null) {
    return {
      availableCount: summaryCount,
      nextExpiresAt: summaryCount > 0 && previous?.availableCount === summaryCount
        ? previous.nextExpiresAt
        : null,
    };
  }

  return previous;
}

function nextAvailableExpiry(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  let earliest: number | null = null;
  for (const candidate of value) {
    const credit = asRecord(candidate);
    if (!credit || credit.status !== "available") continue;
    const expiresAt = parseResetValue(credit.expires_at);
    if (expiresAt === null) continue;
    earliest = earliest === null ? expiresAt : Math.min(earliest, expiresAt);
  }
  return earliest;
}

function parseAvailableCount(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function parseRemoteWindow(value: unknown, now: number): ObservedUsageWindow | null {
  const window = asRecord(value);
  if (!window) return null;
  const utilization = parsePercentValue(window.used_percent);
  if (utilization === null) return null;

  const durationSeconds = parsePositiveNumber(window.limit_window_seconds);
  const durationMinutes = durationSeconds === null || durationSeconds <= 0
    ? null
    : Math.ceil(durationSeconds / 60);
  const resetAt = parseResetValue(window.reset_at);
  const resetAfterSeconds = parsePositiveNumber(window.reset_after_seconds);
  return {
    utilization,
    resetsAt: resetAt ?? (resetAfterSeconds === null ? null : now + resetAfterSeconds * 1000),
    durationMinutes,
  };
}

function parsePositiveNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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

  const primary = parseObservedWindow(
    getFirstPresentHeader(headers, headerCandidates(prefix, PRIMARY_PERCENT_HEADERS)),
    getFirstPresentHeader(headers, headerCandidates(prefix, ["primary-reset-at"])),
    getFirstPresentHeader(headers, headerCandidates(prefix, ["primary-window-minutes"])),
  );
  const secondary = parseObservedWindow(
    getFirstPresentHeader(headers, headerCandidates(prefix, SECONDARY_PERCENT_HEADERS)),
    getFirstPresentHeader(headers, headerCandidates(prefix, ["secondary-reset-at"])),
    getFirstPresentHeader(headers, headerCandidates(prefix, ["secondary-window-minutes"])),
  );

  const hasDurationMetadata = primary?.durationMinutes != null || secondary?.durationMinutes != null;
  if (hasDurationMetadata) {
    const observed = [primary, secondary].filter((window): window is ObservedUsageWindow => window !== null);
    const fiveHour = observed.find((window) => window.durationMinutes === FIVE_HOUR_WINDOW_MINUTES) ?? null;
    const sevenDay = observed.find((window) => window.durationMinutes === SEVEN_DAY_WINDOW_MINUTES) ?? null;

    // Retain positional compatibility for an unexpected or missing duration,
    // while preferring the provider's explicit duration whenever it is known.
    const positionalFiveHour = fiveHour ?? (primary !== sevenDay ? primary : null);
    const positionalSevenDay = sevenDay ?? (secondary !== fiveHour ? secondary : null);
    const primaryIsSevenDay = primary?.durationMinutes === SEVEN_DAY_WINDOW_MINUTES;
    const usage = withPreviousResetCredits({
      fiveHour: positionalFiveHour
        ? toUsageWindow(positionalFiveHour, previous?.fiveHour)
        : primaryIsSevenDay ? null : previous?.fiveHour ?? null,
      sevenDay: positionalSevenDay
        ? toUsageWindow(positionalSevenDay, previous?.sevenDay)
        : previous?.sevenDay ?? null,
    }, previous);
    return usage.fiveHour || usage.sevenDay || usage.resetCredits ? usage : null;
  }

  const fiveHour = primary
    ? toUsageWindow(primary, previous?.fiveHour)
    : previous?.fiveHour ?? null;
  const sevenDay = secondary
    ? toUsageWindow(secondary, previous?.sevenDay)
    : previous?.sevenDay ?? null;

  if (!fiveHour && !sevenDay) return null;
  return withPreviousResetCredits({ fiveHour, sevenDay }, previous);
}

function withPreviousResetCredits(
  usage: Pick<UsageData, "fiveHour" | "sevenDay">,
  previous: UsageData | null,
): UsageData {
  return {
    ...usage,
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
  };
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

interface ObservedUsageWindow extends UsageWindow {
  durationMinutes: number | null;
}

function parseObservedWindow(percentValue: string | null, resetAtValue: string | null, durationValue: string | null): ObservedUsageWindow | null {
  const utilization = parsePercent(percentValue);
  if (utilization === null) return null;
  return {
    utilization,
    resetsAt: parseResetValue(resetAtValue),
    durationMinutes: parseDurationMinutes(durationValue),
  };
}

function toUsageWindow(observed: ObservedUsageWindow | null, previous?: UsageWindow | null): UsageWindow | null {
  if (!observed) return null;
  return {
    utilization: observed.utilization,
    resetsAt: observed.resetsAt ?? previous?.resetsAt ?? null,
  };
}

function parsePercent(value: string | null): number | null {
  if (!value) return null;
  return parsePercentValue(value);
}

function parsePercentValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
}

function parseResetValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(parsed)) return parsed < 1e12 ? parsed * 1000 : parsed;
  const asDate = new Date(String(value));
  return Number.isNaN(asDate.getTime()) ? null : asDate.getTime();
}

function parseDurationMinutes(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function consumeUsageReset(): Promise<{ outcome: UsageResetOutcome; windowsReset: number; remainingResets?: number }> {
  const session = await getVerifiedSession();
  return consumeUsageResetForSession(session, randomUUID());
}

async function consumeUsageResetForSession(
  session: VerifiedOpenAISession,
  redeemRequestId: string,
): Promise<{ outcome: UsageResetOutcome; windowsReset: number; remainingResets?: number }> {
  const response = await fetchOpenAIJson<OpenAIConsumeResetPayload>(OPENAI_USAGE_RESET_CONSUME_URL, session, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redeem_request_id: redeemRequestId }),
  });
  const outcome = parseConsumeOutcome(response.code);
  const windowsReset = parseAvailableCount(response.windows_reset) ?? 0;
  const accountKey = accountKeyForSession(session);

  try {
    await refreshRemoteUsageForSession(session, { force: true });
  } catch {
    applyConsumeFallback(accountKey, outcome, windowsReset);
  }

  const remainingResets = usageForAccount(accountKey)?.resetCredits?.availableCount;
  return {
    outcome,
    windowsReset,
    ...(remainingResets !== undefined ? { remainingResets } : {}),
  };
}

function parseConsumeOutcome(value: unknown): UsageResetOutcome {
  switch (value) {
    case "reset":
    case "nothing_to_reset":
    case "no_credit":
    case "already_redeemed":
      return value;
    default:
      throw new Error(`OpenAI usage reset returned an unknown outcome: ${String(value)}`);
  }
}

function applyConsumeFallback(accountKey: string, outcome: UsageResetOutcome, windowsReset: number): void {
  const previous = usageForAccount(accountKey);
  if (!previous && outcome !== "no_credit") return;
  const next: UsageData = previous ?? { fiveHour: null, sevenDay: null };
  let resetCredits = next.resetCredits;

  if (outcome === "reset" && resetCredits) {
    resetCredits = {
      availableCount: Math.max(0, resetCredits.availableCount - 1),
      nextExpiresAt: null,
    };
  } else if (outcome === "no_credit") {
    resetCredits = { availableCount: 0, nextExpiresAt: null };
  }

  const resetWindow = (window: UsageWindow | null): UsageWindow | null =>
    outcome === "reset" && windowsReset > 0 && window
      ? { utilization: 0, resetsAt: null }
      : window;

  saveUsageForAccount(accountKey, {
    fiveHour: resetWindow(next.fiveHour),
    sevenDay: resetWindow(next.sevenDay),
    ...(resetCredits !== undefined ? { resetCredits } : {}),
  });
}

/** Test seam for the backend HTTP contract; production callers use consumeUsageReset(). */
export async function consumeUsageResetForSessionForTest(
  session: VerifiedOpenAISession,
  redeemRequestId: string,
): Promise<{ outcome: UsageResetOutcome; windowsReset: number; remainingResets?: number }> {
  return consumeUsageResetForSession(session, redeemRequestId);
}

export function setOpenAIUsageFetchForTest(fetchImpl: OpenAIUsageFetch | null): void {
  usageFetchOverride = fetchImpl;
}

export function mergeRemoteUsageForTest(
  previous: UsageData | null,
  payload: OpenAIRemoteUsagePayload | null,
  details: OpenAIResetCreditDetailsPayload | null,
  now: number,
): UsageData {
  return mergeRemoteUsage(previous, payload, details, now);
}
