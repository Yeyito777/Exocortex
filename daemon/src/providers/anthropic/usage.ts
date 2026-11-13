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
 *
 * The two sources disagree by about a point at the same moment (the `/usage`
 * poll reads a little higher than the rate_limit_events), so an account's
 * window never goes back within the same window (mergeUsage); only a reset
 * starts it over.
 *
 * Verified accounts have no 5-hour limit: `/usage` reports `five_hour: null`
 * and their rate_limit_events leave it out. Only `/usage` is a full report, so
 * only it clears the window (noFiveHourLimit); an event may leave a window out
 * for no reason.
 *
 * An account on a long-lived token (account-token.ts) has no `/usage` once its
 * login has ended: the token cannot read it. Its usage then comes from the
 * headers of a 1-token request, the same figures the rate_limit_events carry.
 *
 * Fable models draw on an allowance of their own, a share of the weekly limit
 * (`usage.fable`): `/usage` lists it as a `weekly_scoped` row and the
 * rate_limit_events as the `seven_day_overage_included` window. A refusal
 * scoped to it keeps only Fable turns off the account (isFableScopedLimit);
 * its other models go on, so it never counts as an account at a usage limit.
 */

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { loadClaudeSdks } from "./sdk";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { runtimeDir } from "@exocortex/shared/paths";
import type { FableUsage, UsageData, UsageResetCredits, UsageWindow } from "../../messages";
import { emitClaudeAccountsChanged } from "./account-events";
import { claudeDailyReset } from "../../usage-limit-wait";
import { getClaudeAccount, MAIN_ACCOUNT_ID } from "./accounts";
import { hasClaudeToken, probeClaudeToken, type ClaudeTokenProbe } from "./account-token";
import { claudeProcessOptions } from "./cli";

export const CLAUDE_RATE_LIMIT_HEADER = "x-exocortex-claude-rate-limit";
/** The Claude account (accounts.ts) the rate limit event came from; absent means `main`. */
export const CLAUDE_ACCOUNT_HEADER = "x-exocortex-claude-account";
/** "1" when the request behind the rate limit event ran a Fable model: scopes a refusal that names no window. */
export const CLAUDE_FABLE_TURN_HEADER = "x-exocortex-claude-fable-turn";
/** The Fable allowance's name in Claude Code's limiter: a rate_limit_event's `rateLimitType` and `unifiedWindows` key. */
export const FABLE_RATE_LIMIT_TYPE = "seven_day_overage_included";
/**
 * Under /proxy a Fable refusal that reaches this machine is the remote's to
 * judge (it routes by its accounts' allowance): this daemon holds the
 * fallback model this long, then goes by the remote's shared pool again, or
 * lets a turn find out.
 */
export const PROXIED_FABLE_HOLD_MS = 15 * 60_000;
/** Limits of the whole plan (or another model family): a refusal naming one is never the Fable allowance's. */
const PLAN_LIMIT_TYPES = new Set(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"]);

const USAGE_FILE = join(runtimeDir(), "usage-anthropic.json");
const REMOTE_USAGE_TIMEOUT_MS = 30_000;
/** A rejection without a reset time keeps the account out of new turns this long. */
const UNKNOWN_LIMIT_MS = 15 * 60_000;
/** Two reports of a window whose reset times are this close describe the same window. */
const SAME_WINDOW_MS = 60_000;
/**
 * The most two sources disagree on one window at the same moment, in points.
 * A bigger drop within a window is real (Anthropic reset the usage).
 */
const SOURCE_DISAGREEMENT = 5;

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

/** A token account's usage is asked for with a request at most this often. */
export const TOKEN_USAGE_PROBE_INTERVAL_MS = 5 * 60_000;
/** Its Fable allowance, which takes a request on the Fable model, at most this often. */
export const TOKEN_FABLE_PROBE_INTERVAL_MS = 30 * 60_000;
/** After its login gave no report, the login is not asked again for this long. */
const LOGIN_REPORT_RETRY_MS = 30 * 60_000;

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

/** A result can refuse usage without sending rate_limit_event first. */
export function noteAccountUsageRefusal(account: string, message = "", now = Date.now()): void {
  const entry = entryFor(account);
  if (entry.limitedUntil == null || entry.limitedUntil <= now) {
    const resets = [entry.usage?.fiveHour, entry.usage?.sevenDay]
      .filter(window => window && window.utilization >= 100 && window.resetsAt != null && window.resetsAt > now)
      .map(window => window!.resetsAt!);
    entry.limitedUntil = resets.length ? Math.max(...resets) : claudeDailyReset(message, now) ?? now + 60_000;
    saveToDisk();
    emitClaudeAccountsChanged();
  }
}

function mergeWindow(previous: UsageWindow | null | undefined, next: UsageWindow | null, now: number): UsageWindow | null {
  if (!previous || !next || previous.resetsAt === null || next.resetsAt === null) return next;
  if (previous.resetsAt <= now || Math.abs(next.resetsAt - previous.resetsAt) > SAME_WINDOW_MS) return next;
  // Under 100 after a limit: the account has room again, which routing must see.
  if (previous.utilization >= 100 && next.utilization < 100) return next;
  const drop = previous.utilization - next.utilization;
  return drop > 0 && drop <= SOURCE_DISAGREEMENT ? { ...next, utilization: previous.utilization } : next;
}

/**
 * An account's new usage report over its last one: within the same window the
 * utilization only grows, so a report a point lower is the other source's
 * rounding or lag, not less usage, and keeps the higher figure. A new window
 * (another reset time, or the old one past), a big drop (Anthropic reset the
 * usage) or a drop off a limit takes the report as it is.
 */
export function mergeUsage(previous: UsageData | null, next: UsageData, now = Date.now(), full = false): UsageData {
  if (!previous) return next.fable ? { ...next, fable: mergeFable(undefined, next.fable, now) } : next;
  const fable = mergeFable(previous.fable, next.fable, now);
  // Only a full report (`/usage`) lists the reset grants: an event keeps the last ones.
  const resetCredits = full ? next.resetCredits : next.resetCredits ?? previous.resetCredits;
  const { fable: _reported, resetCredits: _grants, ...rest } = next;
  return {
    ...rest,
    fiveHour: mergeWindow(previous.fiveHour, next.fiveHour, now),
    sevenDay: mergeWindow(previous.sevenDay, next.sevenDay, now),
    ...(fable !== undefined ? { fable } : {}),
    ...(resetCredits ? { resetCredits } : {}),
  };
}

/**
 * The Fable allowance of a new report over the last one: the window merges
 * like any other; a report that says nothing of it (`undefined`) keeps what
 * was known, and so does its refusal (`limitedUntil`) until a report clears
 * it (`null`) or it passes.
 */
function mergeFable(previous: FableUsage | null | undefined, next: FableUsage | null | undefined, now: number): FableUsage | null | undefined {
  if (next === undefined) return previous;
  if (next === null) return null;
  const window = mergeWindow(previous, next, now) ?? next;
  const allowance = next.allowanceOfWeekly ?? previous?.allowanceOfWeekly;
  const limitedUntil = next.limitedUntil !== undefined ? next.limitedUntil : previous?.limitedUntil;
  return {
    utilization: window.utilization,
    resetsAt: window.resetsAt,
    ...(allowance !== undefined ? { allowanceOfWeekly: allowance } : {}),
    ...(limitedUntil != null && limitedUntil > now ? { limitedUntil } : {}),
  };
}

function commitUsage(account: string, usage: UsageData, now = Date.now(), reported = true, full = false): void {
  const entry = entryFor(account);
  entry.usage = mergeUsage(entry.usage, usage, now, full);
  if (reported) entry.updatedAt = now;
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
  const reported = toWindow(windows.five_hour);
  // Only a running window (one with a reset time) brings back a limit `/usage` said is gone.
  const noLimit = previous?.noFiveHourLimit === true && reported?.resetsAt == null;
  const fiveHour = noLimit ? null : reported;
  const sevenDay = toWindow(windows.seven_day);
  const fable = toWindow(windows[FABLE_RATE_LIMIT_TYPE]);
  if (!fiveHour && !sevenDay && !fable) return null;
  return {
    fiveHour: fiveHour ?? previous?.fiveHour ?? null,
    sevenDay: sevenDay ?? previous?.sevenDay ?? null,
    ...(noLimit ? { noFiveHourLimit: true } : {}),
    // An event carries the allowance's window, not its share or a refusal: those stay as known.
    ...(fable ? { fable } : {}),
  };
}

function headerNumber(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * An Anthropic response's `anthropic-ratelimit-unified-*` headers as the
 * rate_limit_event info Claude Code would report for them, or null when the
 * limiter did not run.
 */
export function rateLimitInfoFromHeaders(headers: Headers): Record<string, unknown> | null {
  const status = headers.get("anthropic-ratelimit-unified-status");
  if (!status) return null;
  const windows: Record<string, { utilization?: number; resetsAt?: number; status?: string }> = {};
  // `7d_oi`: the Fable allowance (the weekly window that includes what overage would otherwise pay).
  for (const [name, short] of [["five_hour", "5h"], ["seven_day", "7d"], [FABLE_RATE_LIMIT_TYPE, "7d_oi"]] as const) {
    const utilization = headerNumber(headers.get(`anthropic-ratelimit-unified-${short}-utilization`));
    const resetsAt = headerNumber(headers.get(`anthropic-ratelimit-unified-${short}-reset`));
    const windowStatus = headers.get(`anthropic-ratelimit-unified-${short}-status`);
    if (utilization === undefined && resetsAt === undefined) continue;
    windows[name] = { ...(utilization !== undefined ? { utilization } : {}), ...(resetsAt !== undefined ? { resetsAt } : {}), ...(windowStatus ? { status: windowStatus } : {}) };
  }
  const overage = headers.get("anthropic-ratelimit-unified-overage-status");
  const resetsAt = headerNumber(headers.get("anthropic-ratelimit-unified-reset"));
  // Which limit the verdict is about: a refusal naming the Fable allowance leaves the account's other models usable.
  const claim = headers.get("anthropic-ratelimit-unified-representative-claim");
  return {
    status,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(claim ? { rateLimitType: claim } : {}),
    // Refused by the plan but carried on extra usage: Exocortex keeps work off such an account, as for its own turns.
    ...(status === "rejected" && (overage === "allowed" || overage === "allowed_warning") ? { isUsingOverage: true } : {}),
    unifiedWindows: windows,
  };
}

/**
 * Whether a refused request (or one moved onto extra usage) ran out of the
 * Fable allowance only, which leaves the account's other models usable.
 * Claude Code names the allowance's window when the response did. A refusal
 * that names no window (a `credits_required` body) or only the extra usage
 * is the allowance's when the request ran Fable and neither plan window is
 * full: an account with plan usage left refuses nothing else.
 */
export function isFableScopedLimit(info: Record<string, unknown>, fableTurn: boolean): boolean {
  const type = info.rateLimitType;
  if (type === FABLE_RATE_LIMIT_TYPE) return true;
  if (!fableTurn || (typeof type === "string" && PLAN_LIMIT_TYPES.has(type))) return false;
  const windows = (info.unifiedWindows ?? {}) as Record<string, (RateLimitWindow & { status?: unknown }) | undefined>;
  const full = (window: (RateLimitWindow & { status?: unknown }) | undefined) =>
    window?.status === "rejected" || (toWindow(window)?.utilization ?? 0) >= 100;
  return !full(windows.five_hour) && !full(windows.seven_day);
}

interface PlanRateLimitWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

function toPlanWindow(window: PlanRateLimitWindow | null | undefined): UsageWindow | null {
  if (!window || typeof window.utilization !== "number") return null;
  // The `/usage` control request reports utilization as 0–100 and resets_at as ISO 8601,
  // a fraction of a second off the whole second the rate_limit_events give.
  const resetsAt = window.resets_at ? Date.parse(window.resets_at) : Number.NaN;
  return {
    utilization: Math.round(window.utilization * 10) / 10,
    resetsAt: Number.isFinite(resetsAt) ? Math.round(resetsAt / 1000) * 1000 : null,
  };
}

/** Parse the `rate_limits` of Claude Code's `get_usage` control response into usage windows. */
export function usageFromPlanRateLimits(rateLimits: Record<string, unknown> | null | undefined, previous: UsageData | null = null): UsageData | null {
  if (!rateLimits) return null;
  const fiveHour = toPlanWindow(rateLimits.five_hour as PlanRateLimitWindow | null | undefined);
  const sevenDay = toPlanWindow(rateLimits.seven_day as PlanRateLimitWindow | null | undefined);
  if (!fiveHour && !sevenDay) return null;
  // A report with the weekly window and no 5-hour one: the account has no 5-hour limit.
  const noLimit = rateLimits.five_hour == null ? sevenDay !== null : !fiveHour && previous?.noFiveHourLimit === true;
  const fable = fableFromPlanRateLimits(rateLimits);
  const resetCredits = resetCreditsFromPlanRateLimits(rateLimits);
  return {
    fiveHour: fiveHour ?? (noLimit ? null : previous?.fiveHour ?? null),
    sevenDay: sevenDay ?? previous?.sevenDay ?? null,
    ...(noLimit ? { noFiveHourLimit: true } : {}),
    ...(fable !== undefined ? { fable } : {}),
    ...(resetCredits ? { resetCredits } : {}),
  };
}

/**
 * The account's free limit resets in a `/usage` report: `cedar_ember.grants`,
 * each with the resets it has left and when it ends (the shape claude.ai's
 * usage page reads; Claude Code's report had the key null on Nov 9 2026).
 * How many are left in all, and the nearest end; null when there are none.
 */
export function resetCreditsFromPlanRateLimits(rateLimits: Record<string, unknown>, now = Date.now()): UsageResetCredits | null {
  const grants = (rateLimits.cedar_ember as { grants?: unknown } | null | undefined)?.grants;
  if (!Array.isArray(grants)) return null;
  let count = 0;
  let next: number | null = null;
  for (const grant of grants as Array<Record<string, unknown> | null>) {
    // Only resets of the weekly limit count; Fable-only grants (clears: seven_day_overage_included alone) are left out.
    if (Array.isArray(grant?.clears) && !grant.clears.includes("seven_day")) continue;
    const left = typeof grant?.resets_left === "number" && Number.isFinite(grant.resets_left) ? Math.floor(grant.resets_left) : 0;
    const ends = typeof grant?.ends_at === "string" ? Date.parse(grant.ends_at) : Number.NaN;
    if (left <= 0 || (Number.isFinite(ends) && ends <= now)) continue;
    count += left;
    if (Number.isFinite(ends) && (next === null || ends < next)) next = ends;
  }
  return count > 0 ? { availableCount: count, nextExpiresAt: next } : null;
}

interface PlanLimitRow {
  percent?: unknown;
  resets_at?: unknown;
  scope?: { model?: { display_name?: unknown } | null } | null;
}

function isFableName(name: unknown): boolean {
  return typeof name === "string" && /fable/i.test(name);
}

/**
 * The Fable allowance in a `/usage` report: the row of `limits` scoped to a
 * model named Fable, with its share of the weekly limit from
 * `weekly_scoped_shares` (or, failing that row, the report's `model_scoped`
 * entry). Null: the report lists the plan's rows and none is Fable's (no
 * Fable limit); undefined: it lists no rows at all, which says nothing.
 */
export function fableFromPlanRateLimits(rateLimits: Record<string, unknown>): FableUsage | null | undefined {
  const rows = Array.isArray(rateLimits.limits) ? rateLimits.limits as Array<PlanLimitRow | null> : null;
  const index = rows?.findIndex(row => isFableName(row?.scope?.model?.display_name)) ?? -1;
  const scoped = Array.isArray(rateLimits.model_scoped)
    ? (rateLimits.model_scoped as Array<Record<string, unknown> | null>).find(entry => isFableName(entry?.display_name)) : undefined;
  const row = index >= 0 ? rows![index]! : null;
  const percent = row ? row.percent : scoped?.utilization;
  if (!row && !scoped) return rows ? null : undefined;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  const reset = row ? row.resets_at : scoped?.resets_at;
  const resetsAt = typeof reset === "string" ? Date.parse(reset) : Number.NaN;
  const shares = Array.isArray(rateLimits.weekly_scoped_shares) ? rateLimits.weekly_scoped_shares as Array<Record<string, unknown> | null> : [];
  const allowance = index >= 0 ? shares.find(share => share?.limit_index === index)?.allowance_percent_of_weekly : undefined;
  return {
    utilization: Math.round(percent * 10) / 10,
    resetsAt: Number.isFinite(resetsAt) ? Math.round(resetsAt / 1000) * 1000 : null,
    ...(typeof allowance === "number" && allowance > 0 ? { allowanceOfWeekly: allowance } : {}),
    // Allowance left: a full report ends an earlier refusal, as it frees a limited account.
    ...(percent < 100 ? { limitedUntil: null } : {}),
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
  if (account) tokenUsage.delete(account);
  else tokenUsage.clear();
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
 * `capacity` (100 per account), with every account's reset time. The 5-hour
 * bar leaves out accounts reported to have no 5-hour limit (`fiveHourCapacity`);
 * one with unknown usage still counts.
 * A single account keeps the plain single-account shape.
 */
export function aggregateUsage(usages: Array<UsageData | null>, now = Date.now()): UsageData | null {
  if (usages.length === 0) return null;
  if (usages.length === 1) return usages[0];
  if (usages.every(usage => !usage?.fiveHour && !usage?.sevenDay)) return null;
  const fiveHour = aggregateWindow(usages.map(usage => usage?.fiveHour ?? null), now);
  const sevenDay = aggregateWindow(usages.map(usage => usage?.sevenDay ?? null), now);
  const noLimit = usages.filter(usage => usage?.noFiveHourLimit).length;
  // The Fable allowances together. Like the 5-hour bar, it leaves out accounts reported to have
  // none (`fableCapacity`); one whose report is not in yet still counts.
  const fable = aggregateWindow(usages.map(usage => usage?.fable ?? null), now);
  const noFable = usages.filter(usage => usage?.fable === null).length;
  const resetCredits = aggregateResetCredits(usages, now);
  return {
    fiveHour,
    sevenDay,
    capacity: usages.length * 100,
    ...(noLimit > 0 ? { fiveHourCapacity: (usages.length - noLimit) * 100 } : {}),
    ...(fable ? { fable } : {}),
    ...(fable && noFable > 0 ? { fableCapacity: (usages.length - noFable) * 100 } : {}),
    ...(resetCredits ? { resetCredits } : {}),
  };
}

/** Every account's reset grants together, with the nearest expiry still ahead. */
function aggregateResetCredits(usages: Array<UsageData | null>, now: number): UsageResetCredits | null {
  let count = 0;
  let next: number | null = null;
  for (const usage of usages) {
    const credits = usage?.resetCredits;
    if (!credits || credits.availableCount <= 0 || (credits.nextExpiresAt !== null && credits.nextExpiresAt <= now)) continue;
    count += credits.availableCount;
    if (credits.nextExpiresAt !== null && (next === null || credits.nextExpiresAt < next)) next = credits.nextExpiresAt;
  }
  return count > 0 ? { availableCount: count, nextExpiresAt: next } : null;
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
      // On the account's own login: a long-lived token cannot read the report.
      ...claudeProcessOptions(process.cwd(), account, undefined, null, { token: false }),
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

/** Record one account's `/usage` answer (refreshAccountUsage). */
export function applyPlanRateLimits(account: string, limits: Record<string, unknown> | null, now = Date.now()): void {
  const usage = usageFromPlanRateLimits(limits, getAccountUsage(account));
  // A fresh authoritative report may free an account before the old reset.
  // Include model-specific windows (e.g. seven_day_opus), not just the bars.
  const windows = Object.values(limits ?? {}).filter((value): value is { utilization: number } =>
    typeof value === "object" && value !== null && "utilization" in value
    && typeof value.utilization === "number");
  const entry = entryFor(account);
  const freed = entry.limitedUntil != null && windows.length > 0 && windows.every(window => window.utilization < 100);
  if (freed) entry.limitedUntil = null;
  if (usage) commitUsage(account, usage, now, true, true);
  else if (freed) {
    saveToDisk();
    emitClaudeAccountsChanged();
  }
}

// ── Accounts on a long-lived token ──────────────────────────────────

interface TokenUsageState {
  /** Last request that asked for the plan's usage, and for the Fable allowance. */
  probedAt: number;
  fableProbedAt: number;
  /** When the account's own login last gave no report. */
  loginReportFailedAt: number;
}

const tokenUsage = new Map<string, TokenUsageState>();
let planReport: (account: string) => Promise<Record<string, unknown> | null> = fetchPlanRateLimits;

/** Tests substitute the `/usage` report of an account's own login. */
export function setPlanReportForTests(next: ((account: string) => Promise<Record<string, unknown> | null>) | null): void {
  planReport = next ?? fetchPlanRateLimits;
  tokenUsage.clear();
}

function tokenUsageState(account: string): TokenUsageState {
  let state = tokenUsage.get(account);
  if (!state) {
    state = { probedAt: 0, fableProbedAt: 0, loginReportFailedAt: 0 };
    tokenUsage.set(account, state);
  }
  return state;
}

/**
 * When the login in a configuration directory ends (`refreshTokenExpiresAt`
 * of Claude Code's `.credentials.json`; nothing else of the file is read):
 * a time, "none" when there is no login file, or null when it does not say.
 */
export function claudeLoginEnd(configDir: string): number | "none" | null {
  const file = join(configDir, ".credentials.json");
  try {
    if (!existsSync(file)) return process.platform === "darwin" ? null : "none";
    const end = (JSON.parse(readFileSync(file, "utf-8")) as { claudeAiOauth?: { refreshTokenExpiresAt?: unknown } }).claudeAiOauth?.refreshTokenExpiresAt;
    return typeof end === "number" && Number.isFinite(end) ? end : null;
  } catch {
    return null;
  }
}

/** Whether a token account's own login may still give the `/usage` report. */
function loginReportDue(account: string, now: number): boolean {
  if (now - tokenUsageState(account).loginReportFailedAt < LOGIN_REPORT_RETRY_MS) return false;
  const configDir = getClaudeAccount(account)?.configDir;
  if (!configDir) return false;
  const end = claudeLoginEnd(configDir);
  return end === null || (end !== "none" && end > now);
}

function applyProbeHeaders(account: string, headers: Headers, fable: boolean, now: number): void {
  const info = rateLimitInfoFromHeaders(headers);
  if (!info) return;
  applyUsageHeaders(new Headers({
    [CLAUDE_RATE_LIMIT_HEADER]: JSON.stringify(info),
    ...(account !== MAIN_ACCOUNT_ID ? { [CLAUDE_ACCOUNT_HEADER]: account } : {}),
    ...(fable ? { [CLAUDE_FABLE_TURN_HEADER]: "1" } : {}),
  }), now);
  // The answer is a report of this moment, whatever it changed.
  entryFor(account).updatedAt = now;
}

/**
 * A token account's usage from the headers of a 1-token request: the 5-hour
 * and weekly windows, and every TOKEN_FABLE_PROBE_INTERVAL_MS a second request
 * on the Fable model for its allowance. Skipped (null) within
 * TOKEN_USAGE_PROBE_INTERVAL_MS of the last one unless `force`. The answer
 * also says whether Anthropic still takes the token (auth-cache.ts), which
 * does not wait for the Fable request (`fableInBackground`): a turn may be
 * waiting on it.
 */
export async function probeTokenAccountUsage(account: string, options: { force?: boolean; fableInBackground?: boolean; signal?: AbortSignal; now?: number } = {}): Promise<ClaudeTokenProbe | null> {
  const now = options.now ?? Date.now();
  const state = tokenUsageState(account);
  if (!options.force && now - state.probedAt < TOKEN_USAGE_PROBE_INTERVAL_MS) return null;
  state.probedAt = now;
  const probe = await probeClaudeToken(account, { signal: options.signal, now });
  if (probe.outcome !== "ok") return probe;
  applyProbeHeaders(account, probe.headers, false, now);
  // The Fable allowance shows only on a Fable request; not while the plan itself refuses requests.
  if (probe.status < 400 && now - state.fableProbedAt >= TOKEN_FABLE_PROBE_INTERVAL_MS) {
    state.fableProbedAt = now;
    const fable = probeClaudeToken(account, { fable: true, ...(options.fableInBackground ? {} : { signal: options.signal }), now }).then((answer) => {
      if (answer.outcome === "ok") applyProbeHeaders(account, answer.headers, true, now);
    }).catch(() => {});
    if (!options.fableInBackground) await fable;
  }
  return probe;
}

/** A token account's usage: its own login's report while the login lasts, else the token's headers. */
async function refreshTokenAccountUsage(account: string, generation: number): Promise<void> {
  const now = Date.now();
  if (loginReportDue(account, now)) {
    const limits = await planReport(account).catch(() => null);
    if (generation !== usageGeneration) return;
    if (usageFromPlanRateLimits(limits)) {
      applyPlanRateLimits(account, limits);
      return;
    }
    tokenUsageState(account).loginReportFailedAt = now;
  }
  await probeTokenAccountUsage(account);
}

/** Ask Claude Code for one account's usage; concurrent calls share one process. */
export function refreshAccountUsage(account: string): Promise<UsageData | null> {
  const running = remoteRefreshes.get(account);
  if (running) return running;
  const generation = usageGeneration;
  const refresh = (async () => {
    if (hasClaudeToken(account)) {
      await refreshTokenAccountUsage(account, generation);
      return getAccountUsage(account);
    }
    const limits = await planReport(account);
    if (generation !== usageGeneration) return getAccountUsage(account);
    applyPlanRateLimits(account, limits);
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
function noteRateLimitStatus(entry: AccountUsageEntry, info: Record<string, unknown>, now: number, fableTurn: boolean, fableHoldMs?: number): void {
  const overage = info.isUsingOverage === true || info.overageInUse === true;
  if (info.status === "rejected" || overage) {
    // Out of Fable allowance only: the account's other models go on.
    if (isFableScopedLimit(info, fableTurn)) markFableLimited(entry, epochSecondsToMs(info.resetsAt), now, fableHoldMs);
    else entry.limitedUntil = epochSecondsToMs(info.resetsAt) ?? now + UNKNOWN_LIMIT_MS;
  } else if (info.status === "allowed" || info.status === "allowed_warning") {
    entry.limitedUntil = null;
    // A Fable request went through: the allowance is back.
    if (fableTurn && entry.usage?.fable?.limitedUntil != null) {
      const { limitedUntil: _ended, ...fable } = entry.usage.fable;
      entry.usage = { ...entry.usage, fable };
    }
  }
}

/**
 * Keep Fable turns off the account until its allowance resets: at `resetAt`
 * when the refusal said, else at the allowance's known reset, else after a
 * short hold that lets a later turn find out.
 */
function markFableLimited(entry: AccountUsageEntry, resetAt: number | null, now: number, maxHoldMs?: number): void {
  const usage = entry.usage ?? { fiveHour: null, sevenDay: null };
  const known = usage.fable ?? null;
  const knownReset = known?.resetsAt != null && known.resetsAt > now ? known.resetsAt : null;
  const reset = resetAt !== null && resetAt > now ? resetAt : knownReset;
  const until = Math.min(reset ?? now + UNKNOWN_LIMIT_MS, maxHoldMs !== undefined ? now + maxHoldMs : Infinity);
  entry.usage = {
    ...usage,
    fable: {
      // A refusal with no reading of the allowance: it is used up.
      utilization: known?.utilization ?? 100,
      resetsAt: knownReset ?? reset,
      ...(known?.allowanceOfWeekly !== undefined ? { allowanceOfWeekly: known.allowanceOfWeekly } : {}),
      limitedUntil: until,
    },
  };
}

/**
 * A Fable turn was refused for lack of Fable allowance without a
 * rate_limit_event saying so (a result's error text, Claude Code switching
 * the session off Fable by itself). `maxHoldMs` caps the hold where the
 * refusal is another machine's to judge (/proxy).
 */
export function noteAccountFableRefusal(account: string, resetAt: number | null = null, now = Date.now(), maxHoldMs?: number): void {
  const entry = entryFor(account);
  const held = entry.usage?.fable?.limitedUntil;
  if (held != null && held > now) return;
  markFableLimited(entry, resetAt, now, maxHoldMs);
  saveToDisk();
  emitClaudeAccountsChanged();
}

/**
 * Apply a forwarded rate_limit_event to the account it came from. Returns the
 * account, or null when the header carried nothing usable. `fableHoldMs`
 * caps how long a Fable refusal holds (PROXIED_FABLE_HOLD_MS under /proxy).
 */
export function applyUsageHeaders(headers: Headers, now = Date.now(), fableHoldMs?: number): string | null {
  const raw = headers.get(CLAUDE_RATE_LIMIT_HEADER);
  if (!raw) return null;
  const account = headers.get(CLAUDE_ACCOUNT_HEADER) || MAIN_ACCOUNT_ID;
  try {
    const info = JSON.parse(raw) as Record<string, unknown>;
    const entry = entryFor(account);
    const before = entry.limitedUntil;
    const fableBefore = entry.usage?.fable?.limitedUntil ?? null;
    noteRateLimitStatus(entry, info, now, headers.get(CLAUDE_FABLE_TURN_HEADER) === "1", fableHoldMs);
    const fableChanged = fableBefore !== (entry.usage?.fable?.limitedUntil ?? null);
    const usage = usageFromRateLimitInfo(info, entry.usage);
    if (usage) {
      // An event without the 5-hour window still held is not a fresh report:
      // the limit may be gone, and only the next `/usage` poll can say so.
      const held = usage.fiveHour !== null && usage.fiveHour === entry.usage?.fiveHour;
      commitUsage(account, usage, now, !held);
    } else if (before !== entry.limitedUntil || fableChanged) {
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
