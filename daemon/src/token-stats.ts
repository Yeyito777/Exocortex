import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tokenStatsDir, worktreeName } from "@exocortex/shared/paths";
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

const CURRENT_VERSION = 1;
const INSTANCE_ID = worktreeName() ?? "main";

interface TokenStatsFile {
  version: 1;
  instance: string;
  updatedAt: number | null;
  days: Record<string, TokenStatsBucket>;
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
    outputTokens: totals.outputTokens,
    totalTokens: totals.totalTokens,
    requests: totals.requests,
  };
}

function cloneBucket(bucket: TokenStatsBucket): TokenStatsBucket {
  return {
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    totalTokens: bucket.totalTokens,
    requests: bucket.requests,
    byProvider: Object.fromEntries(Object.entries(bucket.byProvider).map(([key, value]) => [key, cloneTotals(value)])),
    byModel: Object.fromEntries(Object.entries(bucket.byModel).map(([key, value]) => [key, cloneTotals(value)])),
    bySource: Object.fromEntries(Object.entries(bucket.bySource).map(([key, value]) => [key, cloneTotals(value)])) as TokenStatsBucket["bySource"],
  };
}

function normalizeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function normalizeTotals(raw: unknown): TokenUsageTotals {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const inputTokens = normalizeNumber(obj.inputTokens);
  const outputTokens = normalizeNumber(obj.outputTokens);
  const requests = normalizeNumber(obj.requests);
  const totalTokens = normalizeNumber(obj.totalTokens) || inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    requests,
  };
}

function normalizeTotalsRecord<T extends string>(raw: unknown): Record<T, TokenUsageTotals> {
  if (!raw || typeof raw !== "object") return {} as Record<T, TokenUsageTotals>;
  const normalized: Record<string, TokenUsageTotals> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    normalized[key] = normalizeTotals(value);
  }
  return normalized as Record<T, TokenUsageTotals>;
}

function normalizeBucket(raw: unknown): TokenStatsBucket {
  const totals = normalizeTotals(raw);
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    ...totals,
    byProvider: normalizeTotalsRecord<ProviderId>(obj.byProvider),
    byModel: normalizeTotalsRecord<ModelId>(obj.byModel),
    bySource: normalizeTotalsRecord<TokenUsageSource>(obj.bySource),
  };
}

function normalizeFile(raw: unknown): TokenStatsFile {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const daysRaw = obj.days && typeof obj.days === "object" ? obj.days as Record<string, unknown> : {};
  const days: Record<string, TokenStatsBucket> = {};
  for (const [day, value] of Object.entries(daysRaw)) {
    days[day] = normalizeBucket(value);
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

function addTotals(target: TokenUsageTotals, inputTokens: number, outputTokens: number, requests: number): void {
  target.inputTokens += inputTokens;
  target.outputTokens += outputTokens;
  target.totalTokens += inputTokens + outputTokens;
  target.requests += requests;
}

function addTotalsFromEntry(target: TokenUsageTotals, entry: TokenUsageTotals): void {
  addTotals(target, entry.inputTokens, entry.outputTokens, entry.requests);
}

function addMappedTotals(map: Record<string, TokenUsageTotals>, key: string, entry: TokenUsageTotals): void {
  const current = map[key] ?? createTokenUsageTotals();
  addTotalsFromEntry(current, entry);
  map[key] = current;
}

function addBucketEntry(
  bucket: TokenStatsBucket,
  provider: ProviderId,
  model: ModelId,
  source: TokenUsageSource,
  inputTokens: number,
  outputTokens: number,
): void {
  const entry: TokenUsageTotals = {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    requests: 1,
  };
  addTotalsFromEntry(bucket, entry);
  addMappedTotals(bucket.byProvider as Record<string, TokenUsageTotals>, provider, entry);
  addMappedTotals(bucket.byModel, model, entry);
  addMappedTotals(bucket.bySource as Record<string, TokenUsageTotals>, source, entry);
}

function mergeBucketInto(target: TokenStatsBucket, source: TokenStatsBucket): void {
  addTotalsFromEntry(target, source);
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
  for (const day of days) {
    mergeBucketInto(lifetime, day);
  }

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

export function recordTokenUsage(
  provider: ProviderId,
  model: ModelId,
  usage: { inputTokens?: number; outputTokens?: number },
  tracking: TokenTrackingContext,
): TokenStatsSnapshot | null {
  const inputTokens = normalizeNumber(usage.inputTokens);
  const outputTokens = normalizeNumber(usage.outputTokens);
  if (inputTokens <= 0 && outputTokens <= 0) return null;

  const canonicalModel = canonicalizeModel(provider, model);
  const file = getCurrentFile();
  const day = localDay(Date.now());
  const bucket = file.days[day] ?? createTokenStatsBucket();
  addBucketEntry(bucket, provider, canonicalModel, tracking.source, inputTokens, outputTokens);
  file.days[day] = bucket;
  file.updatedAt = Date.now();
  saveCurrentFile();
  return getTokenStatsSnapshot();
}

export function resetTokenStatsForTest(): void {
  currentFileCache = null;
  rmSync(statsDirPath(), { recursive: true, force: true });
}
