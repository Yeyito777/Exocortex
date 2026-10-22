/**
 * What an OpenAI API key has spent, counted from the `usage` of the responses
 * Exocortex received with it. API keys have no ChatGPT plan windows, and the
 * billing/credit endpoints refuse project keys (credit_grants needs a browser
 * session key, organization/costs an admin `api.usage.read` key), so this
 * local count is the honest equivalent: tokens per day and month, priced from
 * the published table where a rate exists. Requests made elsewhere with the
 * same key are not seen.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "@exocortex/shared/paths";
import { resolveModelTokenPricing, type TokenPricingServiceTier } from "@exocortex/shared/token-pricing";
import type { ApiKeySpend, ApiKeyUsage } from "../../messages";
import { log } from "../../log";

const KEEP_DAYS = 400;

interface LedgerFile {
  version: 1;
  /** Account key (`api-key:<hash>`) → local day (YYYY-MM-DD) → spend. */
  byAccount: Record<string, Record<string, ApiKeySpend>>;
}

export interface ApiKeyRequestUsage {
  model: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  /** OpenAI `cache_write_tokens`, priced at the cache-write rate where one is published. */
  cacheMissInputTokens?: number;
  outputTokens?: number;
  serviceTier?: TokenPricingServiceTier;
  timestamp?: number;
}

let ledger: LedgerFile | null = null;

function ledgerPath(): string {
  return join(dataDir(), "openai-api-key-usage.json");
}

function emptySpend(): ApiKeySpend {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, requests: 0, estimatedCostUsd: 0, unpricedRequests: 0 };
}

function loadLedger(): LedgerFile {
  if (ledger) return ledger;
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(), "utf-8")) as LedgerFile;
    if (parsed?.version === 1 && parsed.byAccount && typeof parsed.byAccount === "object") ledger = parsed;
  } catch (err) {
    if (existsSync(ledgerPath())) log("warn", `openai api-key usage: unreadable ledger, starting over (${err})`);
  }
  ledger ??= { version: 1, byAccount: {} };
  return ledger;
}

function saveLedger(file: LedgerFile): void {
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
  renameSync(tmp, path);
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Published-rate estimate of one request; null when some of its tokens have no published rate. */
export function estimateApiKeyRequestCostUsd(usage: ApiKeyRequestUsage): number | null {
  const pricing = resolveModelTokenPricing(usage.model, {
    serviceTier: usage.serviceTier ?? "standard",
    inputTokens: usage.inputTokens,
    timestamp: usage.timestamp,
  });
  if (!pricing || pricing.provider !== "openai") return null;
  const input = count(usage.inputTokens);
  const cached = Math.min(input, count(usage.cachedInputTokens));
  const cacheWrite = Math.min(input - cached, count(usage.cacheMissInputTokens));
  const ordinary = input - cached - cacheWrite;
  const output = count(usage.outputTokens);
  let cost = 0;
  for (const [tokens, rate] of [
    [cached, pricing.cachedInputUsdPerMillion],
    [cacheWrite, pricing.cacheMissInputUsdPerMillion],
    [ordinary, pricing.inputUsdPerMillion],
    [output, pricing.outputUsdPerMillion],
  ] as const) {
    if (tokens === 0) continue;
    if (rate === null) return null;
    cost += tokens / 1_000_000 * rate;
  }
  return cost;
}

/** Count one request made with the API key. Image and audio models have no table entry: counted, not priced. */
export function recordApiKeyUsage(accountKey: string | null | undefined, usage: ApiKeyRequestUsage): void {
  if (!accountKey) return;
  const timestamp = usage.timestamp ?? Date.now();
  const file = loadLedger();
  const days = file.byAccount[accountKey] ??= {};
  const day = days[localDay(timestamp)] ??= emptySpend();
  const cost = estimateApiKeyRequestCostUsd({ ...usage, timestamp });
  day.inputTokens += count(usage.inputTokens);
  day.cachedInputTokens += Math.min(count(usage.inputTokens), count(usage.cachedInputTokens));
  day.outputTokens += count(usage.outputTokens);
  day.requests += 1;
  if (cost === null) day.unpricedRequests += 1;
  else day.estimatedCostUsd += cost;

  const oldest = localDay(timestamp - KEEP_DAYS * 86_400_000);
  for (const key of Object.keys(days)) if (key < oldest) delete days[key];
  try {
    saveLedger(file);
  } catch (err) {
    log("warn", `openai api-key usage: could not save the ledger (${err instanceof Error ? err.message : err})`);
  }
}

function addSpend(into: ApiKeySpend, from: ApiKeySpend): void {
  into.inputTokens += from.inputTokens;
  into.cachedInputTokens += from.cachedInputTokens;
  into.outputTokens += from.outputTokens;
  into.requests += from.requests;
  into.estimatedCostUsd += from.estimatedCostUsd;
  into.unpricedRequests += from.unpricedRequests;
}

/** Today's and this calendar month's spend for the key, local time. */
export function apiKeyUsage(accountKey: string, label: string, now = Date.now()): ApiKeyUsage {
  const days = loadLedger().byAccount[accountKey] ?? {};
  const today = localDay(now);
  const month = today.slice(0, 7);
  const todaySpend = emptySpend();
  const monthSpend = emptySpend();
  for (const [day, spend] of Object.entries(days)) {
    if (day === today) addSpend(todaySpend, spend);
    if (day.startsWith(month)) addSpend(monthSpend, spend);
  }
  return { label, today: todaySpend, month: monthSpend };
}

export function resetApiKeyUsageForTest(): void {
  ledger = null;
  rmSync(ledgerPath(), { force: true });
}
