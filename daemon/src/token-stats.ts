import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tokenStatsDir, worktreeName } from "@exocortex/shared/paths";
import { resolveModelTokenPricing, type ModelTokenPricing, type TokenPricingServiceTier } from "@exocortex/shared/token-pricing";
import {
  createTokenStatsBucket,
  createTokenStatsDay,
  createTokenUsageTotals,
  type ModelId,
  type ProviderId,
  type TokenStatsBucket,
  type TokenStatsDay,
  type TokenStatsSnapshot,
  type TokenTrackingContext,
  type TokenUsageSource,
  type TokenUsageTotals,
} from "./messages";
import { log } from "./log";
import { canonicalizeModel } from "./providers/registry";

const CURRENT_VERSION = 2;
const INSTANCE_ID = worktreeName() ?? "main";

interface TokenStatsFile {
  version: 2;
  instance: string;
  updatedAt: number | null;
  days: Record<string, TokenStatsBucket>;
}

interface ClassifiedInputUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheMissInputTokens: number;
  uncachedInputTokens: number;
  unmeasuredInputTokens: number;
  cacheHitReported: boolean;
  cacheMissReported: boolean;
}

interface TokenCostEstimate {
  estimatedInputCostUsd: number;
  estimatedOutputCostUsd: number;
  pricedInputTokens: number;
  pricedOutputTokens: number;
}

export interface RecordTokenUsageOptions {
  /** Requested tier fallback when the provider omitted the actual response tier. */
  serviceTier?: TokenPricingServiceTier;
  /** Test/replay seam. Production records use the current time. */
  timestamp?: number;
}

function statsDirPath(): string {
  return tokenStatsDir();
}

function currentFilePath(): string {
  return join(statsDirPath(), `${INSTANCE_ID}.json`);
}

function createEmptyFile(): TokenStatsFile {
  return {
    version: CURRENT_VERSION,
    instance: INSTANCE_ID,
    updatedAt: null,
    days: {},
  };
}

function cloneTotals(totals: TokenUsageTotals): TokenUsageTotals {
  return {
    inputTokens: totals.inputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    cacheMissInputTokens: totals.cacheMissInputTokens,
    uncachedInputTokens: totals.uncachedInputTokens,
    unmeasuredInputTokens: totals.unmeasuredInputTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.totalTokens,
    requests: totals.requests,
    estimatedInputCostUsd: totals.estimatedInputCostUsd,
    estimatedOutputCostUsd: totals.estimatedOutputCostUsd,
    pricedInputTokens: totals.pricedInputTokens,
    pricedOutputTokens: totals.pricedOutputTokens,
  };
}

function cloneBucket(bucket: TokenStatsBucket): TokenStatsBucket {
  return {
    ...cloneTotals(bucket),
    byProvider: Object.fromEntries(Object.entries(bucket.byProvider).map(([key, value]) => [key, cloneTotals(value)])),
    byModel: Object.fromEntries(Object.entries(bucket.byModel).map(([key, value]) => [key, cloneTotals(value)])),
    bySource: Object.fromEntries(Object.entries(bucket.bySource).map(([key, value]) => [key, cloneTotals(value)])) as TokenStatsBucket["bySource"],
  };
}

function normalizeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeUsd(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeTotals(raw: unknown, legacy: boolean): TokenUsageTotals {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const inputTokens = normalizeNumber(obj.inputTokens);
  const cachedInputTokens = Math.min(inputTokens, normalizeNumber(obj.cachedInputTokens));
  let remainingInputTokens = inputTokens - cachedInputTokens;

  // V1 stored all non-hit input in `uncachedInputTokens`, before OpenAI exposed
  // cache_write_tokens. That residual cannot be split forensically after the
  // fact, so migrate it to unmeasured rather than pretending it was no-cache.
  const cacheMissInputTokens = legacy ? 0 : Math.min(remainingInputTokens, normalizeNumber(obj.cacheMissInputTokens));
  remainingInputTokens -= cacheMissInputTokens;
  const uncachedInputTokens = legacy ? 0 : Math.min(remainingInputTokens, normalizeNumber(obj.uncachedInputTokens));
  remainingInputTokens -= uncachedInputTokens;
  const unmeasuredInputTokens = remainingInputTokens;

  const outputTokens = normalizeNumber(obj.outputTokens);
  const requests = normalizeNumber(obj.requests);
  return {
    inputTokens,
    cachedInputTokens,
    cacheMissInputTokens,
    uncachedInputTokens,
    unmeasuredInputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    requests,
    estimatedInputCostUsd: legacy ? 0 : normalizeUsd(obj.estimatedInputCostUsd),
    estimatedOutputCostUsd: legacy ? 0 : normalizeUsd(obj.estimatedOutputCostUsd),
    pricedInputTokens: legacy ? 0 : Math.min(inputTokens, normalizeNumber(obj.pricedInputTokens)),
    pricedOutputTokens: legacy ? 0 : Math.min(outputTokens, normalizeNumber(obj.pricedOutputTokens)),
  };
}

function normalizeTotalsRecord<T extends string>(raw: unknown, legacy: boolean): Record<T, TokenUsageTotals> {
  if (!raw || typeof raw !== "object") return {} as Record<T, TokenUsageTotals>;
  const normalized: Record<string, TokenUsageTotals> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    normalized[key] = normalizeTotals(value, legacy);
  }
  return normalized as Record<T, TokenUsageTotals>;
}

function normalizeBucket(raw: unknown, legacy: boolean): TokenStatsBucket {
  const totals = normalizeTotals(raw, legacy);
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    ...totals,
    byProvider: normalizeTotalsRecord<ProviderId>(obj.byProvider, legacy),
    byModel: normalizeTotalsRecord<ModelId>(obj.byModel, legacy),
    bySource: normalizeTotalsRecord<TokenUsageSource>(obj.bySource, legacy),
  };
}

function normalizeFile(raw: unknown): TokenStatsFile {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const legacy = obj.version !== CURRENT_VERSION;
  const daysRaw = obj.days && typeof obj.days === "object" ? obj.days as Record<string, unknown> : {};
  const days: Record<string, TokenStatsBucket> = {};
  for (const [day, value] of Object.entries(daysRaw)) {
    days[day] = normalizeBucket(value, legacy);
  }
  return {
    version: CURRENT_VERSION,
    instance: typeof obj.instance === "string" && obj.instance ? obj.instance : INSTANCE_ID,
    updatedAt: typeof obj.updatedAt === "number" && Number.isFinite(obj.updatedAt) ? obj.updatedAt : null,
    days,
  };
}

function readFileIfPresent(path: string): TokenStatsFile | null {
  try {
    if (!existsSync(path)) return null;
    return normalizeFile(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    log("warn", `token stats: failed to read ${path}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function writeFile(path: string, file: TokenStatsFile): void {
  mkdirSync(statsDirPath(), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

let currentFileCache: TokenStatsFile | null = null;

function getCurrentFile(): TokenStatsFile {
  if (currentFileCache) return currentFileCache;
  currentFileCache = readFileIfPresent(currentFilePath()) ?? createEmptyFile();
  return currentFileCache;
}

function saveCurrentFile(): void {
  writeFile(currentFilePath(), getCurrentFile());
}

function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addTotals(target: TokenUsageTotals, entry: TokenUsageTotals): void {
  target.inputTokens += entry.inputTokens;
  target.cachedInputTokens += entry.cachedInputTokens;
  target.cacheMissInputTokens += entry.cacheMissInputTokens;
  target.uncachedInputTokens += entry.uncachedInputTokens;
  target.unmeasuredInputTokens += entry.unmeasuredInputTokens;
  target.outputTokens += entry.outputTokens;
  target.totalTokens += entry.inputTokens + entry.outputTokens;
  target.requests += entry.requests;
  target.estimatedInputCostUsd += entry.estimatedInputCostUsd;
  target.estimatedOutputCostUsd += entry.estimatedOutputCostUsd;
  target.pricedInputTokens += entry.pricedInputTokens;
  target.pricedOutputTokens += entry.pricedOutputTokens;
}

function addMappedTotals(map: Record<string, TokenUsageTotals>, key: string, entry: TokenUsageTotals): void {
  const current = map[key] ?? createTokenUsageTotals();
  addTotals(current, entry);
  map[key] = current;
}

function addBucketEntry(
  bucket: TokenStatsBucket,
  provider: ProviderId,
  model: ModelId,
  source: TokenUsageSource,
  entry: TokenUsageTotals,
): void {
  addTotals(bucket, entry);
  addMappedTotals(bucket.byProvider as Record<string, TokenUsageTotals>, provider, entry);
  addMappedTotals(bucket.byModel, model, entry);
  addMappedTotals(bucket.bySource as Record<string, TokenUsageTotals>, source, entry);
}

function mergeBucketInto(target: TokenStatsBucket, source: TokenStatsBucket): void {
  addTotals(target, source);
  for (const [provider, totals] of Object.entries(source.byProvider)) {
    addMappedTotals(target.byProvider as Record<string, TokenUsageTotals>, provider, totals);
  }
  for (const [model, totals] of Object.entries(source.byModel)) {
    addMappedTotals(target.byModel, model, totals);
  }
  for (const [sourceKey, totals] of Object.entries(source.bySource)) {
    addMappedTotals(target.bySource as Record<string, TokenUsageTotals>, sourceKey, totals);
  }
}

function mergeDays(files: TokenStatsFile[]): Map<string, TokenStatsBucket> {
  const merged = new Map<string, TokenStatsBucket>();
  for (const file of files) {
    for (const [day, bucket] of Object.entries(file.days)) {
      const current = merged.get(day) ?? createTokenStatsBucket();
      mergeBucketInto(current, bucket);
      merged.set(day, current);
    }
  }
  return merged;
}

function loadAllFiles(): TokenStatsFile[] {
  try {
    const dir = statsDirPath();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readFileIfPresent(join(dir, name)))
      .filter((file): file is TokenStatsFile => file !== null);
  } catch (err) {
    log("warn", `token stats: failed to enumerate stats dir: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export function getTokenStatsSnapshot(): TokenStatsSnapshot {
  const files = loadAllFiles();
  const mergedDays = mergeDays(files);
  const sortedDays = [...mergedDays.keys()].sort((a, b) => b.localeCompare(a));
  const days: TokenStatsDay[] = sortedDays.map((day) => ({ day, ...cloneBucket(mergedDays.get(day)!) }));

  const lifetime = createTokenStatsBucket();
  for (const day of days) mergeBucketInto(lifetime, day);

  const todayKey = localDay(Date.now());
  const todayBucket = mergedDays.get(todayKey);
  return {
    updatedAt: files.reduce<number | null>((latest, file) => {
      if (file.updatedAt == null) return latest;
      return latest == null || file.updatedAt > latest ? file.updatedAt : latest;
    }, null),
    today: todayBucket ? { day: todayKey, ...cloneBucket(todayBucket) } : createTokenStatsDay(todayKey),
    lifetime,
    days,
  };
}

function optionalTokenCount(value: unknown): number | undefined {
  return value == null ? undefined : normalizeNumber(value);
}

export function classifyInputTokenUsage(
  provider: ProviderId,
  inputTokensValue: unknown,
  cachedInputTokensValue: unknown,
  cacheMissInputTokensValue: unknown,
): ClassifiedInputUsage {
  const inputTokens = normalizeNumber(inputTokensValue);
  const rawCached = optionalTokenCount(cachedInputTokensValue);
  const rawCacheMiss = optionalTokenCount(cacheMissInputTokensValue);
  const cacheHitReported = rawCached !== undefined;
  const cacheMissReported = rawCacheMiss !== undefined;
  const cachedInputTokens = Math.min(inputTokens, rawCached ?? 0);
  const cacheMissInputTokens = Math.min(inputTokens - cachedInputTokens, rawCacheMiss ?? 0);
  const residual = inputTokens - cachedInputTokens - cacheMissInputTokens;
  const fullyClassified = (cacheHitReported && cacheMissReported) || residual === 0;
  // OpenAI's two detail fields leave an explicit ordinary/no-cache residual.
  // DeepSeek's contract instead requires hit + miss = prompt_tokens, so any
  // nonzero residual there is inconsistent/unclassified rather than no-cache.
  const residualIsOrdinaryInput = fullyClassified && provider !== "deepseek";
  return {
    inputTokens,
    cachedInputTokens,
    cacheMissInputTokens,
    uncachedInputTokens: residualIsOrdinaryInput ? residual : 0,
    unmeasuredInputTokens: residualIsOrdinaryInput || residual === 0 ? 0 : residual,
    cacheHitReported,
    cacheMissReported,
  };
}

function addPricedCategory(
  tokens: number,
  rate: number | null,
  totals: { cost: number; tokens: number },
): void {
  if (rate === null || tokens <= 0) return;
  totals.cost += tokens / 1_000_000 * rate;
  totals.tokens += tokens;
}

function allEqualPublishedRates(values: Array<number | null>): number | null {
  if (values.length === 0 || values.some((value) => value === null)) return null;
  const published = values as number[];
  return published.every((value) => value === published[0]) ? published[0] : null;
}

function estimateCost(
  usage: ClassifiedInputUsage,
  outputTokens: number,
  pricing: ModelTokenPricing | null,
): TokenCostEstimate {
  if (!pricing) {
    return {
      estimatedInputCostUsd: 0,
      estimatedOutputCostUsd: 0,
      pricedInputTokens: 0,
      pricedOutputTokens: 0,
    };
  }

  const input = { cost: 0, tokens: 0 };
  addPricedCategory(usage.cachedInputTokens, pricing.cachedInputUsdPerMillion, input);
  addPricedCategory(usage.cacheMissInputTokens, pricing.cacheMissInputUsdPerMillion, input);
  addPricedCategory(usage.uncachedInputTokens, pricing.inputUsdPerMillion, input);

  // A provider may omit one cache-detail field on models where all remaining
  // possible categories have exactly the same published rate. Pricing that
  // residual is still exact; otherwise it remains explicitly excluded. A
  // residual left after both fields were reported is inconsistent provider data
  // (not a missing field), so it is always excluded.
  if (usage.unmeasuredInputTokens > 0 && !(usage.cacheHitReported && usage.cacheMissReported)) {
    const possibleRates = [pricing.inputUsdPerMillion];
    if (!usage.cacheHitReported) possibleRates.push(pricing.cachedInputUsdPerMillion);
    if (!usage.cacheMissReported) possibleRates.push(pricing.cacheMissInputUsdPerMillion);
    addPricedCategory(usage.unmeasuredInputTokens, allEqualPublishedRates(possibleRates), input);
  }

  const outputRate = pricing.outputUsdPerMillion;
  return {
    estimatedInputCostUsd: input.cost,
    estimatedOutputCostUsd: outputRate === null ? 0 : outputTokens / 1_000_000 * outputRate,
    pricedInputTokens: input.tokens,
    pricedOutputTokens: outputRate === null ? 0 : outputTokens,
  };
}

export function recordTokenUsage(
  provider: ProviderId,
  model: ModelId,
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheMissInputTokens?: number;
    outputTokens?: number;
    billingServiceTier?: TokenPricingServiceTier;
  },
  tracking: TokenTrackingContext,
  options: RecordTokenUsageOptions = {},
): TokenStatsSnapshot | null {
  const timestamp = options.timestamp ?? Date.now();
  const input = classifyInputTokenUsage(provider, usage.inputTokens, usage.cachedInputTokens, usage.cacheMissInputTokens);
  const outputTokens = normalizeNumber(usage.outputTokens);
  if (input.inputTokens <= 0 && outputTokens <= 0) return null;

  const canonicalModel = canonicalizeModel(provider, model);
  const serviceTier = usage.billingServiceTier ?? options.serviceTier ?? "standard";
  const resolvedPricing = resolveModelTokenPricing(canonicalModel, {
    serviceTier,
    inputTokens: input.inputTokens,
    timestamp,
  });
  const pricing = resolvedPricing?.provider === provider ? resolvedPricing : null;
  const cost = estimateCost(input, outputTokens, pricing);
  const entry: TokenUsageTotals = {
    inputTokens: input.inputTokens,
    cachedInputTokens: input.cachedInputTokens,
    cacheMissInputTokens: input.cacheMissInputTokens,
    uncachedInputTokens: input.uncachedInputTokens,
    unmeasuredInputTokens: input.unmeasuredInputTokens,
    outputTokens,
    totalTokens: input.inputTokens + outputTokens,
    requests: 1,
    ...cost,
  };

  const file = getCurrentFile();
  const day = localDay(timestamp);
  const bucket = file.days[day] ?? createTokenStatsBucket();
  addBucketEntry(bucket, provider, canonicalModel, tracking.source, entry);
  file.days[day] = bucket;
  file.updatedAt = timestamp;
  saveCurrentFile();
  return getTokenStatsSnapshot();
}

export function resetTokenStatsForTest(): void {
  currentFileCache = null;
  rmSync(statsDirPath(), { recursive: true, force: true });
}
