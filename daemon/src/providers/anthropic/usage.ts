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
 *
 * Usage is kept per Claude account (accounts.ts); the display combines the
 * accounts into one bar per window (aggregateUsage, account-pool.ts).
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { loadClaudeSdks } from "./sdk";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { runtimeDir } from "@exocortex/shared/paths";
import type { UsageData, UsageWindow } from "../../messages";
import { emitClaudeAccountsChanged } from "./account-events";
import { MAIN_ACCOUNT_ID } from "./accounts";
import { claudeProcessOptions } from "./cli";

export const CLAUDE_RATE_LIMIT_HEADER = "x-exocortex-claude-rate-limit";
/** The Claude account (accounts.ts) the rate limit event came from; absent means `main`. */
export const CLAUDE_ACCOUNT_HEADER = "x-exocortex-claude-account";

const USAGE_FILE = join(runtimeDir(), "usage-anthropic.json");
const REMOTE_USAGE_TIMEOUT_MS = 30_000;
/** A rejection without a reset time keeps the account out of new turns this long. */
const UNKNOWN_LIMIT_MS = 15 * 60_000;

interface AccountUsageEntry {
  usage: UsageData | null;
  /** When the usage was last reported (ms). */
  updatedAt: number;
  /** Claude Code rejected a request on a usage window (or moved to overage): until when (ms). */
  limitedUntil: number | null;
}

interface UsageFile {
  version: 2;
  accounts: Record<string, { usage: UsageData | null; limitedUntil?: number | null }>;
}

const entries = new Map<string, AccountUsageEntry>(loadFromDisk());
let usageGeneration = 0;
const remoteRefreshes = new Map<string, Promise<UsageData | null>>();

function isUsageData(value: unknown): value is UsageData {
  return typeof value === "object" && value !== null && ("fiveHour" in value || "sevenDay" in value);
}

function loadFromDisk(): Array<[string, AccountUsageEntry]> {
  try {
    if (!existsSync(USAGE_FILE)) return [];
    const parsed = JSON.parse(readFileSync(USAGE_FILE, "utf-8")) as unknown;
    // Before multiple accounts the file held the one account's usage.
    if (isUsageData(parsed)) return [[MAIN_ACCOUNT_ID, { usage: parsed, updatedAt: 0, limitedUntil: null }]];
    const file = parsed as Partial<UsageFile>;
    if (file?.version !== 2 || typeof file.accounts !== "object" || !file.accounts) return [];
    return Object.entries(file.accounts)
      .filter(([, entry]) => entry && (entry.usage === null || isUsageData(entry.usage)))
      .map(([id, entry]) => [id, { usage: entry.usage, updatedAt: 0, limitedUntil: entry.limitedUntil ?? null }]);
  } catch {
    return [];
  }
}

function saveToDisk(): void {
  const file: UsageFile = { version: 2, accounts: {} };
  for (const [id, entry] of entries) file.accounts[id] = { usage: entry.usage, limitedUntil: entry.limitedUntil };
  try {
    writeFileSync(USAGE_FILE, JSON.stringify(file));
  } catch {
    // best-effort
  }
}

function entryFor(account: string): AccountUsageEntry {
  let entry = entries.get(account);
  if (!entry) {
    entry = { usage: null, updatedAt: 0, limitedUntil: null };
    entries.set(account, entry);
  }
  return entry;
}

function commitUsage(account: string, usage: UsageData): void {
  const entry = entryFor(account);
  entry.usage = usage;
  entry.updatedAt = Date.now();
  saveToDisk();
  emitClaudeAccountsChanged();
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

/** One account's last reported usage. */
export function getAccountUsage(account: string): UsageData | null {
  return entries.get(account)?.usage ?? null;
}

/** When one account's usage was last reported (ms), 0 if never in this daemon. */
export function getAccountUsageUpdatedAt(account: string): number {
  return entries.get(account)?.updatedAt ?? 0;
}

/** Until when Claude Code refuses new requests on this account, if it does. */
export function getAccountLimitedUntil(account: string, now = Date.now()): number | null {
  const until = entries.get(account)?.limitedUntil ?? null;
  return until !== null && until > now ? until : null;
}

/** Forget usage; one account's, or every account's. */
export function clearUsage(account?: string): void {
  usageGeneration += 1;
  if (account) entries.delete(account);
  else entries.clear();
  remoteRefreshes.clear();
  try {
    if (entries.size === 0) {
      if (existsSync(USAGE_FILE)) unlinkSync(USAGE_FILE);
    } else {
      saveToDisk();
    }
  } catch {
    // best-effort
  }
}

/** Sum one window across accounts; each account adds 100 points of capacity. */
function aggregateWindow(windows: Array<UsageWindow | null>, now: number): UsageWindow | null {
  const known = windows.filter((window): window is UsageWindow => window !== null);
  if (known.length === 0) return null;
  let utilization = 0;
  const resets: number[] = [];
  for (const window of known) {
    // A window past its reset time starts over.
    if (window.resetsAt !== null && window.resetsAt <= now) continue;
    utilization += window.utilization;
    if (window.resetsAt !== null) resets.push(window.resetsAt);
  }
  resets.sort((a, b) => a - b);
  return {
    utilization: Math.round(utilization * 10) / 10,
    resetsAt: resets[0] ?? null,
    ...(windows.length > 1 ? { resets } : {}),
  };
}

/**
 * Combined usage of the given accounts: one bar per window scaled to
 * `capacity` (100 per account), with every account's reset time.
 * A single account keeps the plain single-account shape.
 */
export function aggregateUsage(usages: Array<UsageData | null>, now = Date.now()): UsageData | null {
  if (usages.length === 0) return null;
  if (usages.length === 1) return usages[0];
  if (usages.every(usage => !usage?.fiveHour && !usage?.sevenDay)) return null;
  const fiveHour = aggregateWindow(usages.map(usage => usage?.fiveHour ?? null), now);
  const sevenDay = aggregateWindow(usages.map(usage => usage?.sevenDay ?? null), now);
  return { fiveHour, sevenDay, capacity: usages.length * 100 };
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
async function fetchPlanRateLimits(account: string): Promise<Record<string, unknown> | null> {
  const { claude: { query } } = await loadClaudeSdks();
  const stop = new AbortController();
  const runtime = query({
    prompt: silentInput(stop.signal),
    options: {
      ...claudeProcessOptions(process.cwd(), account),
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

/** Ask Claude Code for one account's usage; concurrent calls share one process. */
export function refreshAccountUsage(account: string): Promise<UsageData | null> {
  const running = remoteRefreshes.get(account);
  if (running) return running;
  const generation = usageGeneration;
  const refresh = (async () => {
    const usage = usageFromPlanRateLimits(await fetchPlanRateLimits(account), getAccountUsage(account));
    if (generation !== usageGeneration) return getAccountUsage(account);
    if (usage) commitUsage(account, usage);
    return getAccountUsage(account);
  })();
  remoteRefreshes.set(account, refresh);
  void refresh.finally(() => {
    if (remoteRefreshes.get(account) === refresh) remoteRefreshes.delete(account);
  }).catch(() => {});
  return refresh;
}

/**
 * Start a bare Claude Code process that asks for the main account's usage.
 * Claude Code refreshes an expiring OAuth login before it can answer, with its
 * own locking and refresh-token rotation, so /proxy uses this rather than
 * refreshing the token itself (see provider-proxy/upstream-auth.ts).
 */
export async function refreshClaudeCodeLogin(): Promise<void> {
  await refreshAccountUsage(MAIN_ACCOUNT_ID);
}

function epochSecondsToMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value * 1000 : null;
}

/**
 * Record a rate_limit_event's effect on its account: a rejected request (or a
 * turn moved onto extra usage) keeps the account out of new turns until the
 * window resets; an allowed one clears that.
 */
function noteRateLimitStatus(entry: AccountUsageEntry, info: Record<string, unknown>, now: number): void {
  const overage = info.isUsingOverage === true || info.overageInUse === true;
  if (info.status === "rejected" || overage) {
    entry.limitedUntil = epochSecondsToMs(info.resetsAt) ?? now + UNKNOWN_LIMIT_MS;
  } else if (info.status === "allowed" || info.status === "allowed_warning") {
    entry.limitedUntil = null;
  }
}

/**
 * Apply a forwarded rate_limit_event to the account it came from. Returns the
 * account, or null when the header carried nothing usable.
 */
export function applyUsageHeaders(headers: Headers, now = Date.now()): string | null {
  const raw = headers.get(CLAUDE_RATE_LIMIT_HEADER);
  if (!raw) return null;
  const account = headers.get(CLAUDE_ACCOUNT_HEADER) || MAIN_ACCOUNT_ID;
  try {
    const info = JSON.parse(raw) as Record<string, unknown>;
    const entry = entryFor(account);
    const before = entry.limitedUntil;
    noteRateLimitStatus(entry, info, now);
    const usage = usageFromRateLimitInfo(info, entry.usage);
    if (usage) {
      commitUsage(account, usage);
    } else if (before !== entry.limitedUntil) {
      saveToDisk();
      emitClaudeAccountsChanged();
    } else {
      return null;
    }
    return account;
  } catch {
    // Malformed synthetic header; keep the previous usage snapshot.
    return null;
  }
}
