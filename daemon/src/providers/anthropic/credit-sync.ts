/**
 * The real balance of the Claude API credits, read from the Claude Console.
 *
 * The Admin API is not offered to individual organizations, so the balance
 * comes from where the Console's own billing page gets it: a GET of
 * `/api/organizations/<org>/prepaid/credits`, one entry per grant with what
 * is left of it and when it expires. The request is made by the page itself,
 * in a background vimbrowser tab of the browser context signed into that
 * organization's account (`console.browserContext`; unset: the default
 * context). The session cookies never leave the browser: Exocortex only gets
 * the JSON back, and keeps only each grant's amounts, name and expiry.
 *
 * Each organization syncs about every hour, and also when the fallback starts
 * using one of its keys or a key runs out of credits (no more than every few
 * minutes). Between syncs the balance is the last sync's less what Exocortex
 * counted its keys spending since, drawn from the grant that expires soonest.
 *
 * A failed sync (vimbrowser not running, a timeout, a signed-out session)
 * leaves the last figures in place: callers mark them as estimates once they
 * are older than a few hours. It logs one line per streak of failures, and
 * the next try waits for the hourly one. A session that needs signing in
 * again is reported (`signInNeeded`), never signed in here.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { externalToolsDir, runtimeDir } from "@exocortex/shared/paths";
import { log } from "../../log";
import { apiKeyDailySpendUsd } from "../openai/api-key-usage";

export const CONSOLE_ORIGIN = "https://platform.claude.com";
const BILLING_URL = `${CONSOLE_ORIGIN}/settings/billing`;
const ORG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTEXT_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/** How often each organization syncs. */
export const CREDIT_SYNC_INTERVAL_MS = 60 * 60_000;
/** The least time between two syncs an event asks for. */
export const CREDIT_SYNC_MIN_GAP_MS = 5 * 60_000;
/** A balance synced longer ago than this is shown as an estimate. */
export const CREDIT_SYNC_STALE_MS = 3 * 60 * 60_000;
const TICK_MS = 5 * 60_000;
const FIRST_SYNC_DELAY_MS = 20_000;

/** Ledger account of a key (api-credits.ts' API_CREDIT_ACCOUNT_KEY_PREFIX). */
const LEDGER_PREFIX = "anthropic-credits:";

// ── Parsing ─────────────────────────────────────────────────────────

/** One credit grant on the organization, as the Console reports it. */
export interface ConsoleTranche {
  name: string | null;
  programId: string | null;
  remainingUsd: number;
  grantedUsd: number;
  /** When it expires (ms); null: it does not. */
  expiresAt: number | null;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Minor units to dollars: `{ credits | money: { amount_minor, exponent } }`, else the flat `*_minor_units` field in cents. */
function dollars(flat: unknown, nested: unknown): number | null {
  const amounts = record(nested);
  const unit = record(amounts?.credits) ?? record(amounts?.money);
  const minor = finite(unit?.amount_minor);
  if (minor !== null) return minor / 10 ** (finite(unit?.exponent) ?? 2);
  const cents = finite(flat);
  return cents === null ? null : cents / 100;
}

function tranche(value: unknown): ConsoleTranche | null {
  const entry = record(value);
  if (!entry) return null;
  const remainingUsd = dollars(entry.remaining_amount_minor_units, entry.remaining);
  if (remainingUsd === null) return null;
  const expires = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : NaN;
  return {
    name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null,
    programId: typeof entry.program_id === "string" ? entry.program_id : null,
    remainingUsd: Math.max(0, remainingUsd),
    grantedUsd: Math.max(0, dollars(entry.granted_amount_minor_units, entry.granted) ?? remainingUsd),
    expiresAt: Number.isFinite(expires) ? expires : null,
  };
}

/**
 * The grants in a `prepaid/credits` response: `promo_tranches` (plan and
 * promotional credits) and `tranches` (bought ones). A balance with no
 * tranche listed is one grant that does not expire. Null for anything else.
 */
export function parseConsoleCredits(body: unknown): ConsoleTranche[] | null {
  const data = record(body);
  if (!data || (!Array.isArray(data.promo_tranches) && !Array.isArray(data.tranches))) return null;
  const tranches = [...(Array.isArray(data.promo_tranches) ? data.promo_tranches : []), ...(Array.isArray(data.tranches) ? data.tranches : [])]
    .map(tranche)
    .filter((entry): entry is ConsoleTranche => entry !== null);
  if (tranches.length === 0) {
    const balance = finite(data.amount);
    if (balance !== null && balance > 0) tranches.push({ name: null, programId: null, remainingUsd: balance / 100, grantedUsd: balance / 100, expiresAt: null });
  }
  return tranches;
}

// ── State ───────────────────────────────────────────────────────────

/** What the ledger had counted for an organization's keys when it synced: their spend on that local day. */
interface LedgerMark {
  day: string;
  spentUsd: number;
}

interface OrgState {
  syncedAt?: number;
  tranches?: ConsoleTranche[];
  mark?: LedgerMark;
  lastAttemptAt?: number;
  /** Why the current streak of failed syncs fails; unset after a success. */
  failing?: string;
  signInNeeded?: boolean;
}

interface SyncFile {
  orgs: Record<string, OrgState>;
  /** The background Console tab of each browser context ("" = the default one). */
  tabs: Record<string, number>;
}

let stateFileOverride: string | null = null;
let file: SyncFile | null = null;

function stateFile(): string {
  return stateFileOverride ?? join(runtimeDir(), "anthropic-credit-sync.json");
}

function load(): SyncFile {
  if (file) return file;
  file = { orgs: {}, tabs: {} };
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf-8")) as Partial<SyncFile>;
    for (const [org, entry] of Object.entries(record(parsed.orgs) ?? {})) if (ORG_RE.test(org) && record(entry)) file.orgs[org] = entry as OrgState;
    for (const [context, tab] of Object.entries(record(parsed.tabs) ?? {})) if (typeof tab === "number") file.tabs[context] = tab;
  } catch {
    // none yet
  }
  return file;
}

function save(): void {
  try {
    const path = stateFile();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(load()));
    renameSync(tmp, path);
  } catch (error) {
    log("warn", `anthropic: saving the API-credit sync state failed: ${error instanceof Error ? error.message : error}`);
  }
}

function orgState(org: string): OrgState {
  const orgs = load().orgs;
  return orgs[org] ??= {};
}

// ── Organizations ───────────────────────────────────────────────────

/** An API-credit key as far as syncing goes. */
export interface SyncKey {
  id: string;
  account?: string | null;
  console?: { org: string; browserContext: string | null } | null;
}

export interface ConsoleOrg {
  org: string;
  browserContext: string | null;
  /** Keys on it (their spend is drawn from its balance between syncs). */
  keyIds: string[];
  /** For log lines: its accounts, else its keys. */
  label: string;
}

/** The organizations of these keys, each once. */
export function consoleOrgs(keys: readonly SyncKey[]): ConsoleOrg[] {
  const orgs = new Map<string, ConsoleOrg & { names: Set<string> }>();
  for (const key of keys) {
    const console = key.console;
    if (!console || !ORG_RE.test(console.org)) continue;
    let entry = orgs.get(console.org);
    if (!entry) orgs.set(console.org, entry = { org: console.org, browserContext: console.browserContext, keyIds: [], label: "", names: new Set() });
    entry.keyIds.push(key.id);
    entry.names.add(key.account ?? key.id);
  }
  return [...orgs.values()].map(({ names, ...org }) => ({ ...org, label: [...names].join(", ") }));
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The keys' counted spend on `day` and on every day after it. */
function ledgerSpend(keyIds: readonly string[], fromDay: string): { onDay: number; since: number } {
  let onDay = 0;
  let since = 0;
  for (const id of keyIds) {
    for (const [day, usd] of Object.entries(apiKeyDailySpendUsd(LEDGER_PREFIX + id))) {
      if (day < fromDay) continue;
      since += usd;
      if (day === fromDay) onDay += usd;
    }
  }
  return { onDay, since };
}

// ── Balances ────────────────────────────────────────────────────────

export interface SyncedBalance {
  balanceUsd: number;
  grantedUsd: number;
  /** Each grant's expiry (ms), soonest first; grants that do not expire are left out. */
  expiresAt: number[];
  /** Synced too long ago to be more than an estimate. */
  approximate: boolean;
  /** The last sync found the Console session signed out. */
  signInNeeded: boolean;
}

/**
 * The grants left at `now` after `spentUsd` more is drawn from them, the one
 * that expires soonest first. Grants past their expiry are gone.
 */
export function drawDown(tranches: readonly ConsoleTranche[], spentUsd: number, now: number): Omit<SyncedBalance, "approximate" | "signInNeeded"> {
  const live = tranches
    .filter(entry => entry.expiresAt === null || entry.expiresAt > now)
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  let left = Math.max(0, spentUsd);
  let balanceUsd = 0;
  for (const entry of live) {
    const take = Math.min(left, entry.remainingUsd);
    left -= take;
    balanceUsd += entry.remainingUsd - take;
  }
  return {
    balanceUsd,
    grantedUsd: live.reduce((sum, entry) => sum + entry.grantedUsd, 0),
    expiresAt: live.filter(entry => entry.expiresAt !== null).map(entry => entry.expiresAt!),
  };
}

/** The organization's balance from its last sync less what its keys spent since; null before its first sync. */
export function syncedBalance(org: ConsoleOrg, now = Date.now()): SyncedBalance | null {
  const state = load().orgs[org.org];
  if (!state?.tranches || state.syncedAt === undefined) return null;
  const mark = state.mark ?? { day: localDay(state.syncedAt), spentUsd: 0 };
  const spent = ledgerSpend(org.keyIds, mark.day);
  return {
    ...drawDown(state.tranches, spent.since - mark.spentUsd, now),
    approximate: now - state.syncedAt > CREDIT_SYNC_STALE_MS,
    signInNeeded: state.signInNeeded === true,
  };
}

/** The last sync found the organization's Console session signed out. */
export function consoleSignInNeeded(org: string): boolean {
  return load().orgs[org]?.signInNeeded === true;
}

// ── Fetching ────────────────────────────────────────────────────────

/** A GET made in the Console page of a browser context. */
export interface ConsoleResponse {
  status: number;
  /** Where the request ended up (a redirect to a sign-in page is not the Console API). */
  url: string;
  body: string;
}

/** Makes a GET to the Console in a browser context; throws when the browser cannot. Tests substitute it. */
export interface ConsoleFetcher {
  get(browserContext: string | null, path: string): Promise<ConsoleResponse>;
}

class SignedOutError extends Error {}

function vimbrowserBinary(): string | null {
  const configured = process.env.EXOCORTEX_VIMBROWSER_CLI_BIN?.trim();
  if (configured) return configured;
  const bundled = join(externalToolsDir(), "vimbrowser-cli", "bin", "vimbrowser-cli");
  if (existsSync(bundled)) return bundled;
  return Bun.which("vimbrowser-cli");
}

async function vimbrowser(args: string[], stdin?: string, timeoutMs = 15_000): Promise<unknown> {
  const bin = vimbrowserBinary();
  if (!bin) throw new Error("no vimbrowser-cli");
  const proc = Bun.spawn([bin, ...args], {
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`vimbrowser-cli ${args[0]}: ${(stderr || stdout).trim().split("\n").pop()?.slice(0, 160) || `exit ${exitCode}`}`);
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout;
  }
}

interface BrowserTab {
  id: number;
  url: string;
  context: string | null;
  loading: boolean;
}

async function browserTabs(): Promise<BrowserTab[]> {
  const raw = await vimbrowser(["tabs", "--json"]);
  const list = Array.isArray(raw) ? raw : record(raw)?.tabs;
  if (!Array.isArray(list)) throw new Error("vimbrowser-cli tabs: unexpected output");
  return list.map(record).filter((tab): tab is JsonRecord => tab !== null && typeof tab.id === "number").map(tab => ({
    id: tab.id as number,
    url: typeof tab.url === "string" ? tab.url : "",
    context: typeof tab.context === "string" ? tab.context : null,
    loading: tab.loading === true,
  }));
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isSignInUrl(url: string): boolean {
  if (originOf(url) !== CONSOLE_ORIGIN) return true;
  return /^\/(?:login|logout|signup|oauth)\b/.test(new URL(url).pathname);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Wait for the tab to finish loading; returns it. */
async function settledTab(id: number, timeoutMs = 20_000): Promise<BrowserTab> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tab = (await browserTabs()).find(entry => entry.id === id);
    if (!tab) throw new Error("the Console tab closed");
    if (!tab.loading && tab.url) return tab;
    if (Date.now() >= deadline) throw new Error("the Console page did not load");
    await sleep(500);
  }
}

/**
 * The Console tab of a browser context: the one opened for this before,
 * else a new background tab on the billing page. One that wandered off the
 * Console (to a sign-in page) is sent back to it.
 */
async function consoleTab(browserContext: string | null): Promise<number> {
  const slot = browserContext ?? "";
  const remembered = load().tabs[slot];
  const tabs = await browserTabs();
  let tab = tabs.find(entry => entry.id === remembered && entry.context === browserContext);
  if (!tab) {
    const before = new Set(tabs.map(entry => entry.id));
    await vimbrowser(browserContext ? ["open-context", browserContext, BILLING_URL] : ["open", BILLING_URL]);
    const created = (await browserTabs()).filter(entry => !before.has(entry.id) && entry.context === browserContext);
    tab = created.sort((a, b) => b.id - a.id)[0];
    if (!tab) throw new Error("could not open a Console tab");
    load().tabs[slot] = tab.id;
    save();
  } else if (originOf(tab.url) !== CONSOLE_ORIGIN) {
    await vimbrowser(["load", String(tab.id), BILLING_URL]);
  }
  const settled = await settledTab(tab.id);
  if (originOf(settled.url) !== CONSOLE_ORIGIN) throw new SignedOutError(`the Console tab is on ${originOf(settled.url) ?? "another page"}`);
  return settled.id;
}

async function evaluate(tab: number, script: string): Promise<string> {
  const reply = record(await vimbrowser(["js", String(tab), "--timeout", "10"], script));
  if (reply?.ok !== true) throw new Error(`vimbrowser-cli js: ${String(reply?.error ?? "failed").slice(0, 160)}`);
  return typeof reply.result === "string" ? reply.result : "";
}

const FETCH_TIMEOUT_MS = 15_000;

/**
 * GETs through vimbrowser: the page starts a same-origin fetch (with its
 * own cookies) and leaves the reply on `window`, where the next calls
 * collect it (vimbrowser's JS evaluation does not wait for promises).
 */
export const vimbrowserConsoleFetcher: ConsoleFetcher = {
  async get(browserContext, path) {
    if (browserContext !== null && !CONTEXT_RE.test(browserContext)) throw new Error(`bad browser context "${browserContext}"`);
    const tab = await consoleTab(browserContext);
    const id = JSON.stringify(`r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
    const started = await evaluate(tab, `(() => {
  const slots = (window.__exocortexCreditSync ??= {});
  const id = ${id};
  slots[id] = null;
  fetch(${JSON.stringify(path)}, { method: "GET", credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" }, signal: AbortSignal.timeout(${FETCH_TIMEOUT_MS}) })
    .then(async (response) => { slots[id] = { status: response.status, url: response.url, body: (await response.text()).slice(0, 200000) }; })
    .catch((error) => { slots[id] = { error: String((error && error.name) || error) }; });
  return "started";
})()`);
    if (started !== "started") throw new Error("the Console page did not run the request");
    const deadline = Date.now() + FETCH_TIMEOUT_MS + 5_000;
    while (Date.now() < deadline) {
      await sleep(300);
      const text = await evaluate(tab, `(() => {
  const slots = window.__exocortexCreditSync;
  const reply = slots && slots[${id}];
  if (!reply) return "";
  delete slots[${id}];
  return JSON.stringify(reply);
})()`);
      if (!text) continue;
      const reply = record(JSON.parse(text));
      if (!reply || typeof reply.status !== "number") throw new Error(`the request failed (${String(reply?.error ?? "no reply").slice(0, 80)})`);
      return { status: reply.status, url: typeof reply.url === "string" ? reply.url : "", body: typeof reply.body === "string" ? reply.body : "" };
    }
    throw new Error("the request timed out");
  },
};

let fetcher: ConsoleFetcher = vimbrowserConsoleFetcher;

// ── Syncing ─────────────────────────────────────────────────────────

export type SyncOutcome = "synced" | "sign-in" | "failed" | "skipped";

let listener: (() => void) | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Told after each sync that changed what a balance shows. */
export function setCreditSyncListener(next: (() => void) | null): void {
  listener = next;
}

/** Whether `org` may sync now: hourly, and on an event no sooner than a few minutes after the last try (an hour while failing). */
export function creditSyncDue(org: string, event: boolean, now = Date.now()): boolean {
  const state = load().orgs[org];
  if (state?.lastAttemptAt === undefined) return true;
  const since = now - state.lastAttemptAt;
  if (since < 0) return true;
  if (!event || state.failing !== undefined || state.syncedAt === undefined) return since >= CREDIT_SYNC_INTERVAL_MS;
  return since >= CREDIT_SYNC_MIN_GAP_MS;
}

async function syncOrg(org: ConsoleOrg, now: () => number): Promise<SyncOutcome> {
  const state = orgState(org.org);
  state.lastAttemptAt = now();
  let failure: string;
  let signedOut = false;
  try {
    const response = await fetcher.get(org.browserContext, `/api/organizations/${org.org}/prepaid/credits`);
    if (response.status === 401 || response.status === 403 || (response.url && isSignInUrl(response.url))) {
      signedOut = true;
      failure = response.status === 401 || response.status === 403 ? `HTTP ${response.status}` : "redirected to sign in";
    } else if (response.status !== 200) {
      failure = `HTTP ${response.status}`;
    } else {
      let body: unknown = null;
      try {
        body = JSON.parse(response.body);
      } catch {
        // not JSON
      }
      const tranches = parseConsoleCredits(body);
      if (tranches) {
        const at = now();
        const day = localDay(at);
        if (state.failing !== undefined) log("info", `anthropic: reading API credits for ${org.label} from the Claude Console works again`);
        Object.assign(state, { syncedAt: at, tranches, mark: { day, spentUsd: ledgerSpend(org.keyIds, day).onDay } });
        delete state.failing;
        delete state.signInNeeded;
        save();
        return "synced";
      }
      failure = "unexpected reply";
    }
  } catch (error) {
    signedOut = error instanceof SignedOutError;
    failure = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160);
  }
  if (state.failing === undefined) {
    log("warn", `anthropic: reading API credits for ${org.label} from the Claude Console failed (${failure}${signedOut ? "; sign-in needed" : ""}); balances are estimates until it works`);
  }
  state.failing = failure;
  state.signInNeeded = signedOut;
  save();
  return signedOut ? "sign-in" : "failed";
}

/**
 * Sync the keys' organizations that are due (`event`: asked for by an event
 * rather than the clock; `force`: whatever the time), one at a time.
 */
export function syncConsoleCredits(keys: readonly SyncKey[], options: { event?: boolean; force?: boolean; now?: () => number } = {}): Promise<Map<string, SyncOutcome>> {
  const now = options.now ?? Date.now;
  const run = queue.then(async () => {
    const outcomes = new Map<string, SyncOutcome>();
    let changed = false;
    for (const org of consoleOrgs(keys)) {
      if (!options.force && !creditSyncDue(org.org, options.event === true, now())) {
        outcomes.set(org.org, "skipped");
        continue;
      }
      outcomes.set(org.org, await syncOrg(org, now));
      changed = true;
    }
    if (changed) listener?.();
    return outcomes;
  });
  queue = run.catch(() => undefined);
  return run;
}

let timer: ReturnType<typeof setInterval> | null = null;
let firstSync: ReturnType<typeof setTimeout> | null = null;

/** Sync shortly after start, then whenever an organization is an hour past its last try. */
export function startCreditSync(keys: () => readonly SyncKey[]): void {
  stopCreditSync();
  const tick = () => { void syncConsoleCredits(keys()).catch(() => undefined); };
  firstSync = setTimeout(tick, FIRST_SYNC_DELAY_MS);
  timer = setInterval(tick, TICK_MS);
  (firstSync as { unref?: () => void }).unref?.();
  (timer as { unref?: () => void }).unref?.();
}

export function stopCreditSync(): void {
  if (timer) clearInterval(timer);
  if (firstSync) clearTimeout(firstSync);
  timer = firstSync = null;
}

// ── Tests ───────────────────────────────────────────────────────────

export function setCreditSyncForTests(source: ConsoleFetcher | null, stateFilePath: string | null = null): void {
  fetcher = source ?? vimbrowserConsoleFetcher;
  stateFileOverride = stateFilePath;
  file = null;
  listener = null;
  queue = Promise.resolve();
  stopCreditSync();
}
