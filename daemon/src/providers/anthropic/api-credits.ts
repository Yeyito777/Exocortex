/**
 * Claude API credits as a fallback for the Claude subscriptions.
 *
 * Each Claude Max plan comes with Claude API credits that cover the Agent
 * SDK. While every subscription account is at a usage limit (account-pool.ts
 * decides that), turns run through the same Claude Code path on one of the
 * API keys in `providers.anthropic.apiCreditFallback.keys`, in config order,
 * and go back to the subscriptions once one can take work again.
 *
 * The keys live in the owner's `secrets` store, named in config, never
 * written into it. A local turn gives Claude Code an `apiKeyHelper` that
 * reads the key through `secrets run` (audited there), so the key is in no
 * environment an agent shell inherits, and in no log, transcript or message.
 * Only /proxy requests from another machine need the value here, to sign
 * the upstream request (provider-proxy/upstream-auth.ts); it stays in memory.
 *
 * A key out of credits (the API answers that the credit balance is too low)
 * is set aside until its credits are granted again (`renewsOnDay`), and the
 * next key takes over; with none left, turns wait for the subscriptions as
 * before. A key the API rate-limits waits a minute. What each key spends is
 * estimated from the usage of its responses at list prices and counted in
 * the API-key ledger (providers/openai/api-key-usage.ts).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { readExocortexConfig } from "@exocortex/shared/config";
import { externalToolsDir, runtimeDir } from "@exocortex/shared/paths";
import { resolveAnthropicApiPricing } from "@exocortex/shared/token-pricing";
import type { ApiCreditsUsage } from "../../messages";
import type { AccountCredits } from "@exocortex/shared/protocol";
import { log } from "../../log";
import { apiKeyCredit, apiKeyDailySpendUsd, recordApiKeyUsage } from "../openai/api-key-usage";

/** Ledger account of a key: `anthropic-credits:<secret name>`. */
export const API_CREDIT_ACCOUNT_KEY_PREFIX = "anthropic-credits:";

export interface ApiCreditKey {
  /** Its name in the secrets store. */
  id: string;
  label: string;
  renewsOnDay: number | null;
  /** The Claude account whose plan grants its credits (the Accounts screen shows them there). */
  account?: string | null;
  grants?: ApiCreditGrant[];
}

export interface ApiCreditGrant {
  amountUsd: number;
  /** Last day it can be used, YYYY-MM-DD. */
  expires: string;
  since: string | null;
  monthly: boolean;
  label: string | null;
}

const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 24 * 60 * 60_000;
/** How long a key the API rate-limited sits out. */
const THROTTLE_MS = 60_000;
/** How long a key the API rejected (invalid, revoked) sits out. */
const REJECTED_MS = 60 * 60_000;
/** On its renewal day, a key out of credits is tried again this often until they land. */
const RENEWAL_DAY_RETRY_MS = 3 * 60 * 60_000;
const SECRET_NAMES_TTL_MS = 5 * 60_000;
const KEY_VALUE_TTL_MS = 10 * 60_000;
const SECRETS_TIMEOUT_MS = 10_000;
const PURPOSE = "exocortex: Claude turns on API credits";

// ── Config ──────────────────────────────────────────────────────────

export interface ApiCreditConfig {
  enabled: boolean;
  keys: ApiCreditKey[];
}

export function apiCreditConfig(): ApiCreditConfig {
  const raw = readExocortexConfig().providers?.anthropic?.apiCreditFallback;
  if (!raw || typeof raw !== "object") return { enabled: false, keys: [] };
  const keys: ApiCreditKey[] = [];
  for (const entry of Array.isArray(raw.keys) ? raw.keys : []) {
    if (!entry || typeof entry.secret !== "string" || !SECRET_NAME_RE.test(entry.secret)) continue;
    if (keys.some(key => key.id === entry.secret)) continue;
    const grants: ApiCreditGrant[] = [];
    for (const grant of Array.isArray(entry.grants) ? entry.grants : []) {
      if (!grant || typeof grant.amountUsd !== "number" || !Number.isFinite(grant.amountUsd) || grant.amountUsd <= 0) continue;
      if (typeof grant.expires !== "string" || !DAY_RE.test(grant.expires)) continue;
      grants.push({
        amountUsd: grant.amountUsd,
        expires: grant.expires,
        since: typeof grant.since === "string" && DAY_RE.test(grant.since) ? grant.since : null,
        monthly: grant.monthly === true,
        label: typeof grant.label === "string" && grant.label.trim() ? grant.label.trim() : null,
      });
    }
    const day = entry.renewsOnDay;
    const monthly = grants.find(grant => grant.monthly);
    keys.push({
      id: entry.secret,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : entry.secret,
      renewsOnDay: typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 31 ? day
        : monthly ? Number(monthly.expires.slice(8, 10)) : null,
      account: typeof entry.account === "string" && entry.account.trim() ? entry.account.trim() : null,
      grants,
    });
  }
  return { enabled: raw.enabled === true && keys.length > 0, keys };
}

export function apiCreditFallbackEnabled(): boolean {
  return apiCreditConfig().enabled;
}

// ── The secrets store ───────────────────────────────────────────────

/** Where keys come from; tests substitute it. Nothing here logs a value. */
export interface ApiCreditSecrets {
  /** Names in the store (never values). */
  names(): Promise<string[]>;
  /** One key's value, or null when it cannot be read. */
  value(name: string): Promise<string | null>;
  /** A shell command that prints the key, for Claude Code's `apiKeyHelper`; null without a secrets CLI. */
  helperCommand(name: string): string | null;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./=:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function secretsBinary(): string | null {
  const configured = process.env.EXOCORTEX_SECRETS_BIN?.trim();
  if (configured) return configured;
  const bundled = join(externalToolsDir(), "secrets-cli", "bin", "secrets");
  if (existsSync(bundled)) return bundled;
  return Bun.which("secrets");
}

async function runSecrets(args: string[]): Promise<{ stdout: string; exitCode: number } | null> {
  const bin = secretsBinary();
  if (!bin) return null;
  try {
    const proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: SECRETS_TIMEOUT_MS });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, exitCode };
  } catch {
    return null;
  }
}

const cliSecrets: ApiCreditSecrets = {
  async names() {
    const result = await runSecrets(["list"]);
    if (!result || result.exitCode !== 0) throw new Error(secretsBinary() ? "`secrets list` failed" : "no `secrets` CLI found");
    return result.stdout.split("\n").map(line => line.trim()).filter(name => SECRET_NAME_RE.test(name));
  },
  async value(name) {
    if (!SECRET_NAME_RE.test(name)) return null;
    const result = await runSecrets(["run", "--allow", name, "--clean-env", "--purpose", PURPOSE, "--", "printenv", name]);
    const value = result?.exitCode === 0 ? result.stdout.trim() : "";
    return value || null;
  },
  helperCommand(name) {
    const bin = secretsBinary();
    if (!bin || !SECRET_NAME_RE.test(name)) return null;
    return `${shellQuote(bin)} run --allow ${name} --clean-env --purpose ${shellQuote(PURPOSE)} -- printenv ${name}`;
  },
};

let secrets: ApiCreditSecrets = cliSecrets;
let secretNames: { at: number; names: Set<string> } | null = null;
let namesRefresh: Promise<void> | null = null;
const keyValues = new Map<string, { at: number; value: string }>();

/** Names the store had at its last check; null before the first one. */
export function knownApiCreditSecrets(): ReadonlySet<string> | null {
  return secretNames?.names ?? null;
}

/** Check which secrets exist, at most every few minutes (always with `force`). */
export function refreshApiCreditSecrets(options: { force?: boolean; now?: number } = {}): Promise<void> {
  const now = options.now ?? Date.now();
  if (!options.force && secretNames && now - secretNames.at < SECRET_NAMES_TTL_MS) return Promise.resolve();
  namesRefresh ??= secrets.names().then((names) => {
    const next = new Set(names);
    const missing = apiCreditConfig().keys.filter(key => !next.has(key.id)).map(key => key.id);
    const before = secretNames ? apiCreditConfig().keys.filter(key => !secretNames!.names.has(key.id)).map(key => key.id).join(",") : null;
    if (missing.length > 0 && missing.join(",") !== before) log("info", `anthropic: API-credit keys not in the secrets store, skipped: ${missing.join(", ")}`);
    secretNames = { at: Date.now(), names: next };
  }).catch((error: unknown) => {
    log("warn", `anthropic: listing API-credit keys failed: ${error instanceof Error ? error.message : error}`);
    // Keep what was known; try again at the next check.
    if (secretNames) secretNames = { ...secretNames, at: Date.now() };
  }).finally(() => { namesRefresh = null; });
  return namesRefresh;
}

/** The key's value, for a /proxy request. Kept in memory a few minutes; never logged. */
export async function apiCreditKeyValue(key: ApiCreditKey, options: { fresh?: boolean; now?: number } = {}): Promise<string | null> {
  const now = options.now ?? Date.now();
  const cached = options.fresh ? undefined : keyValues.get(key.id);
  if (cached && now - cached.at < KEY_VALUE_TTL_MS) return cached.value;
  const value = await secrets.value(key.id);
  if (value) keyValues.set(key.id, { at: now, value });
  else keyValues.delete(key.id);
  return value;
}

/**
 * Claude Code settings that make it authenticate with the key: an
 * `apiKeyHelper` command, which it prefers to the account's subscription
 * login. Null when there is no secrets CLI to read it with.
 */
export function apiCreditClaudeSettings(key: ApiCreditKey): { apiKeyHelper: string } | null {
  const command = secrets.helperCommand(key.id);
  return command ? { apiKeyHelper: command } : null;
}

// ── Key state ───────────────────────────────────────────────────────

interface KeyState {
  /** Out of credits (or rejected) until this time. */
  spentUntil?: number;
  spentReason?: string;
  /** Rate-limited until this time (memory only). */
  throttledUntil?: number;
}

let stateFileOverride: string | null = null;
let states: Map<string, KeyState> | null = null;

function stateFile(): string {
  return stateFileOverride ?? join(runtimeDir(), "anthropic-api-credits.json");
}

function loadStates(): Map<string, KeyState> {
  if (states) return states;
  states = new Map();
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf-8")) as Record<string, KeyState>;
    for (const [id, entry] of Object.entries(parsed)) {
      if (SECRET_NAME_RE.test(id) && typeof entry?.spentUntil === "number") {
        states.set(id, { spentUntil: entry.spentUntil, ...(typeof entry.spentReason === "string" ? { spentReason: entry.spentReason } : {}) });
      }
    }
  } catch {
    // none yet
  }
  return states;
}

function saveStates(): void {
  const out: Record<string, KeyState> = {};
  for (const [id, entry] of loadStates()) {
    if (entry.spentUntil !== undefined) out[id] = { spentUntil: entry.spentUntil, ...(entry.spentReason ? { spentReason: entry.spentReason } : {}) };
  }
  try {
    const path = stateFile();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, path);
  } catch (error) {
    log("warn", `anthropic: saving API-credit key state failed: ${error instanceof Error ? error.message : error}`);
  }
}

function stateOf(id: string): KeyState {
  const map = loadStates();
  let entry = map.get(id);
  if (!entry) map.set(id, entry = {});
  return entry;
}

/** Midnight (local) of the next day `day` of a month after `now` (the 31st is a short month's last day). */
export function nextRenewal(day: number, now: number): number {
  const date = new Date(now);
  for (let offset = 0; offset < 3; offset++) {
    const year = date.getFullYear();
    const month = date.getMonth() + offset;
    const last = new Date(year, month + 1, 0).getDate();
    const at = new Date(year, month, Math.min(day, last)).getTime();
    if (at > now) return at;
  }
  return now + 31 * DAY;
}

/** Local YYYY-MM-DD the current credit cycle began: the last renewal day, else the 1st of the month. */
export function cycleStartDay(renewsOnDay: number | null, now: number): string {
  const date = new Date(now);
  let year = date.getFullYear();
  let month = date.getMonth();
  let day = 1;
  if (renewsOnDay !== null) {
    const clamp = (y: number, m: number) => Math.min(renewsOnDay, new Date(y, m + 1, 0).getDate());
    if (date.getDate() < clamp(year, month)) {
      month -= 1;
      if (month < 0) { month = 11; year -= 1; }
    }
    day = clamp(year, month);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function isRenewalDay(key: ApiCreditKey, now: number): boolean {
  if (key.renewsOnDay === null) return false;
  const date = new Date(now);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return date.getDate() === Math.min(key.renewsOnDay, last);
}

/** The key ran out of credits: set it aside until they are granted again. */
export function markApiCreditSpent(key: ApiCreditKey, reason: string, now = Date.now()): void {
  const until = key.renewsOnDay === null ? now + DAY
    // Granted some time on its renewal day: until they land, try again every few hours.
    : isRenewalDay(key, now) ? now + RENEWAL_DAY_RETRY_MS
    : nextRenewal(key.renewsOnDay, now);
  setAside(key, until, reason);
  log("warn", `anthropic: API-credit key "${key.label}" is out of credits (${reason}); not used again until ${new Date(until).toISOString()}`);
}

/** The API rejected the key itself (invalid or revoked). */
export function markApiCreditRejected(key: ApiCreditKey, reason: string, now = Date.now()): void {
  setAside(key, now + REJECTED_MS, reason);
  log("warn", `anthropic: API-credit key "${key.label}" was rejected (${reason}); not used for an hour`);
}

function setAside(key: ApiCreditKey, until: number, reason: string): void {
  const entry = stateOf(key.id);
  entry.spentUntil = until;
  entry.spentReason = reason.slice(0, 200);
  keyValues.delete(key.id);
  saveStates();
}

/** The API rate-limited the key: it sits out a minute (Claude Code has already retried with backoff). */
export function markApiCreditThrottled(key: ApiCreditKey, now = Date.now(), forMs = THROTTLE_MS): void {
  stateOf(key.id).throttledUntil = now + forMs;
  log("info", `anthropic: API-credit key "${key.label}" is rate-limited; waiting ${Math.round(forMs / 1000)}s`);
}

export interface ApiCreditKeyStatus {
  key: ApiCreditKey;
  /** In the secrets store (null: not checked yet). */
  present: boolean | null;
  spentUntil: number | null;
  spentReason: string | null;
  throttledUntil: number | null;
}

export function apiCreditKeyStatuses(now = Date.now()): ApiCreditKeyStatus[] {
  const names = knownApiCreditSecrets();
  return apiCreditConfig().keys.map((key) => {
    const entry = loadStates().get(key.id) ?? {};
    return {
      key,
      present: names ? names.has(key.id) : null,
      spentUntil: entry.spentUntil !== undefined && entry.spentUntil > now ? entry.spentUntil : null,
      spentReason: entry.spentUntil !== undefined && entry.spentUntil > now ? entry.spentReason ?? null : null,
      throttledUntil: entry.throttledUntil !== undefined && entry.throttledUntil > now ? entry.throttledUntil : null,
    };
  });
}

/** The first configured key that is in the store, has credits and is not rate-limited; null when none (or the fallback is off). */
export function usableApiCreditKey(now = Date.now()): ApiCreditKey | null {
  if (!apiCreditFallbackEnabled()) return null;
  const usable = apiCreditKeyStatuses(now).find(status => status.present === true && status.spentUntil === null && status.throttledUntil === null);
  return usable?.key ?? null;
}

/** With no usable key: when a rate-limited one can be tried again (spent keys wait for the subscriptions). */
export function apiCreditResetAt(now = Date.now()): number | null {
  const waits = apiCreditKeyStatuses(now)
    .filter(status => status.present === true && status.spentUntil === null && status.throttledUntil !== null)
    .map(status => status.throttledUntil!);
  return waits.length > 0 ? Math.min(...waits) : null;
}

// ── Refusals ────────────────────────────────────────────────────────

/** A Claude Code turn on API credits stopped because the key's credits are used up (or billing refused it). */
export class ApiCreditExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiCreditExhaustedError";
  }
}

const CREDIT_REFUSAL_RE = /credit balance|too low to access|purchase credits|plans? (?:&|and) billing|billing|payment required|insufficient (?:funds|credits?)|\b402\b/i;
const KEY_REJECTED_RE = /invalid x-api-key|invalid api key|invalid_api_key|authentication_error|api key.*(?:revoked|disabled)/i;
const RATE_LIMIT_RE = /rate.limit|\b429\b|too many requests/i;

/** An error text saying the credits ran out or billing refused the request. */
export function isApiCreditRefusalText(text: string): boolean {
  return CREDIT_REFUSAL_RE.test(text);
}

export type ApiCreditRefusal = "spent" | "rejected" | "throttled";

/** What a failed credit turn's error says about its key; null when it is not about the key. */
export function classifyApiCreditError(error: unknown): ApiCreditRefusal | null {
  if (!(error instanceof Error) || error.name === "AbortError") return null;
  if (error instanceof ApiCreditExhaustedError || CREDIT_REFUSAL_RE.test(error.message)) return "spent";
  if (KEY_REJECTED_RE.test(error.message)) return "rejected";
  if (RATE_LIMIT_RE.test(error.message)) return "throttled";
  return null;
}

/** Set the key aside as a failed credit turn's error says; returns what it said. */
export function noteApiCreditFailure(key: ApiCreditKey, error: unknown, now = Date.now()): ApiCreditRefusal | null {
  const refusal = classifyApiCreditError(error);
  const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
  if (refusal === "spent") markApiCreditSpent(key, reason, now);
  else if (refusal === "rejected") markApiCreditRejected(key, reason, now);
  else if (refusal === "throttled") markApiCreditThrottled(key, now);
  return refusal;
}

// ── Spend ───────────────────────────────────────────────────────────

export interface ClaudeRequestUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
}

/** List-price cost of one Claude API request; null for a model without published rates here. */
export function estimateClaudeRequestCostUsd(model: string, usage: ClaudeRequestUsage): number | null {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
  const pricing = resolveAnthropicApiPricing(model, prompt);
  if (!pricing) return null;
  return (usage.inputTokens * pricing.inputUsdPerMillion
    + usage.cacheReadTokens * pricing.cacheReadUsdPerMillion
    + usage.cacheWrite5mTokens * pricing.cacheWrite5mUsdPerMillion
    + usage.cacheWrite1hTokens * pricing.cacheWrite1hUsdPerMillion
    + usage.outputTokens * pricing.outputUsdPerMillion) / 1_000_000;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

interface OpenRequest {
  model: string;
  usage: JsonRecord;
}

/**
 * Counts what a key spends from Claude API stream events (`message_start`,
 * `message_delta`), as Claude Code relays them or as they cross /proxy. One
 * request is counted when its final usage arrives. `slot` separates requests
 * streaming at the same time in one process (a subagent's).
 */
export class ApiCreditUsageMeter {
  private readonly open = new Map<string, OpenRequest>();

  constructor(readonly key: ApiCreditKey) {}

  observe(event: unknown, slot = "main"): void {
    const data = record(event);
    if (!data) return;
    if (data.type === "message_start") {
      this.flush(slot);
      const message = record(data.message);
      const usage = record(message?.usage);
      if (message && usage) this.open.set(slot, { model: typeof message.model === "string" ? message.model : "unknown", usage: { ...usage } });
    } else if (data.type === "message_delta") {
      const open = this.open.get(slot);
      const usage = record(data.usage);
      if (!open || !usage) return;
      // The final usage repeats every count; keep the start's cache split when it does not.
      for (const [name, value] of Object.entries(usage)) if (typeof value === "number") open.usage[name] = value;
      this.flush(slot);
    }
  }

  /** Count requests whose stream ended without a final usage (cut off): their input was still billed. */
  flushAll(): void {
    for (const slot of [...this.open.keys()]) this.flush(slot);
  }

  private flush(slot: string): void {
    const open = this.open.get(slot);
    if (!open) return;
    this.open.delete(slot);
    recordApiCreditRequest(this.key, open.model, usageFromApi(open.usage));
  }
}

/**
 * Feeds a meter from a raw Messages API response body as it streams through
 * /proxy: server-sent events, or one JSON message for a request that did
 * not stream. Bodies that carry no usage (count_tokens) count nothing.
 */
export class ApiCreditStreamTap {
  private readonly decoder = new TextDecoder();
  private readonly sse: boolean;
  private buffer = "";
  private json = "";
  private static readonly MAX_JSON = 4 * 1024 * 1024;

  constructor(private readonly meter: ApiCreditUsageMeter, contentType: string | null) {
    this.sse = (contentType ?? "").includes("text/event-stream");
  }

  push(chunk: Uint8Array): void {
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.sse) {
      if (this.json.length < ApiCreditStreamTap.MAX_JSON) this.json += text;
      return;
    }
    this.buffer += text;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      try {
        this.meter.observe(JSON.parse(line.slice(5).trim()));
      } catch {
        // not JSON: not a usage event
      }
    }
  }

  end(): void {
    if (!this.sse && this.json) {
      try {
        const message = record(JSON.parse(this.json));
        if (message?.type === "message" && record(message.usage)) {
          this.meter.observe({ type: "message_start", message });
          this.meter.observe({ type: "message_delta", usage: message.usage });
        }
      } catch {
        // not a message
      }
      this.json = "";
    }
    this.meter.flushAll();
  }
}

function usageFromApi(usage: JsonRecord): ClaudeRequestUsage {
  const writes = count(usage.cache_creation_input_tokens);
  const split = record(usage.cache_creation);
  const oneHour = Math.min(writes, count(split?.ephemeral_1h_input_tokens));
  return {
    inputTokens: count(usage.input_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWrite5mTokens: writes - oneHour,
    cacheWrite1hTokens: oneHour,
    outputTokens: count(usage.output_tokens),
  };
}

export function recordApiCreditRequest(key: ApiCreditKey, model: string, usage: ClaudeRequestUsage, timestamp = Date.now()): void {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
  if (prompt === 0 && usage.outputTokens === 0) return;
  recordApiKeyUsage(API_CREDIT_ACCOUNT_KEY_PREFIX + key.id, {
    model,
    inputTokens: prompt,
    cachedInputTokens: usage.cacheReadTokens,
    outputTokens: usage.outputTokens,
    timestamp,
    estimatedCostUsd: estimateClaudeRequestCostUsd(model, usage),
  });
}

/** Estimated spend of one key since its current cycle began. */
export function apiCreditCycleSpendUsd(key: ApiCreditKey, now = Date.now()): number {
  return apiKeyCredit(API_CREDIT_ACCOUNT_KEY_PREFIX + key.id, { amountUsd: 1, since: cycleStartDay(key.renewsOnDay, now) }, now).usedUsd;
}

// ── Balances ────────────────────────────────────────────────────────

/** Midnight (local) after day `day` (YYYY-MM-DD) of `monthOffset` months later (the day clamped to short months). */
function endOfDay(day: string, monthOffset = 0): number {
  const [year, month, date] = day.split("-").map(Number);
  const last = new Date(year, month - 1 + monthOffset + 1, 0).getDate();
  return new Date(year, month - 1 + monthOffset, Math.min(date, last) + 1).getTime();
}

function dayStart(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).getTime();
}

interface GrantSpan {
  amountUsd: number;
  start: number;
  end: number;
  remaining: number;
}

/** Each grant's periods from `from` on: one, or a monthly grant's month by month, the current one last. */
function grantSpans(grants: ApiCreditGrant[], from: number, now: number): GrantSpan[] {
  const spans: GrantSpan[] = [];
  for (const grant of grants) {
    const since = grant.since ? dayStart(grant.since) : -Infinity;
    if (!grant.monthly) {
      spans.push({ amountUsd: grant.amountUsd, start: since, end: endOfDay(grant.expires), remaining: grant.amountUsd });
      continue;
    }
    // From the month of the first spend counted (or now) to the one running now.
    const target = Math.max(since, Math.min(from, now));
    let first = 0;
    while (first > -1200 && endOfDay(grant.expires, first - 1) > target) first--;
    for (let k = first; k <= first + 2400; k++) {
      const end = endOfDay(grant.expires, k);
      const start = Math.max(since, endOfDay(grant.expires, k - 1));
      if (start < end) spans.push({ amountUsd: grant.amountUsd, start, end, remaining: grant.amountUsd });
      if (end > now) break;
    }
  }
  return spans;
}

/**
 * What is left of a key's grants that have not expired: the ledger's spend,
 * day by day, drawn from the grant that expires soonest. Null without grants.
 */
export function apiCreditBalance(key: ApiCreditKey, now = Date.now()): { balanceUsd: number; grantedUsd: number; expiresAt: number[] } | null {
  const grants = key.grants ?? [];
  if (grants.length === 0) return null;
  const days = Object.entries(apiKeyDailySpendUsd(API_CREDIT_ACCOUNT_KEY_PREFIX + key.id)).sort(([a], [b]) => a.localeCompare(b));
  const from = days.length > 0 ? dayStart(days[0][0]) : now;
  const spans = grantSpans(grants, from, now).sort((a, b) => a.end - b.end);
  for (const [day, spent] of days) {
    const at = dayStart(day);
    let left = spent;
    for (const span of spans) {
      if (left <= 0) break;
      if (span.start > at || span.end <= at) continue;
      const take = Math.min(left, span.remaining);
      span.remaining -= take;
      left -= take;
    }
  }
  const current = spans.filter(span => span.start <= now && span.end > now);
  if (current.length === 0) return { balanceUsd: 0, grantedUsd: 0, expiresAt: [] };
  return {
    balanceUsd: current.reduce((sum, span) => sum + span.remaining, 0),
    grantedUsd: current.reduce((sum, span) => sum + span.amountUsd, 0),
    expiresAt: current.map(span => span.end),
  };
}

/** The credits of the keys configured for a Claude account (`account`), for its Accounts row; null without any. */
export function apiCreditAccountCredits(account: string, activeKeys: ReadonlySet<string>, now = Date.now()): AccountCredits | null {
  const balances = apiCreditConfig().keys
    .filter(key => key.account === account)
    .map(key => ({ key, balance: apiCreditBalance(key, now) }))
    .filter((entry): entry is { key: ApiCreditKey; balance: NonNullable<ReturnType<typeof apiCreditBalance>> } => entry.balance !== null);
  if (balances.length === 0) return null;
  return {
    balanceUsd: balances.reduce((sum, entry) => sum + entry.balance.balanceUsd, 0),
    grantedUsd: balances.reduce((sum, entry) => sum + entry.balance.grantedUsd, 0),
    expiresAt: balances.flatMap(entry => entry.balance.expiresAt).sort((a, b) => a - b),
    active: balances.some(entry => activeKeys.has(entry.key.id)),
  };
}

/** The status-bar view of the fallback; null when it is off. `active`: credit turns run or would run now. */
export function apiCreditsUsage(active: boolean, now = Date.now()): ApiCreditsUsage | null {
  const config = apiCreditConfig();
  if (!config.enabled) return null;
  const key = usableApiCreditKey(now);
  return {
    active,
    ready: key !== null,
    label: key?.label ?? null,
    spentUsd: config.keys.reduce((sum, entry) => sum + apiCreditCycleSpendUsd(entry, now), 0),
    resetAt: key ? null : apiCreditResetAt(now),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

export function setApiCreditSecretsForTests(source: ApiCreditSecrets | null, stateFilePath: string | null = null): void {
  secrets = source ?? cliSecrets;
  secretNames = null;
  namesRefresh = null;
  keyValues.clear();
  stateFileOverride = stateFilePath;
  states = null;
}
