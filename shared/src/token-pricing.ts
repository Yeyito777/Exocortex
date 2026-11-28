import type { ModelId, ProviderId, TokenUsageTotals } from "./messages";

export type TokenPricingServiceTier = "standard" | "fast" | "ultrafast";

/** Exact published rates selected for one request. Null means that rate is not published. */
export interface ModelTokenPricing {
  provider: ProviderId;
  /** Published model whose rates apply. Differs only for an explicitly documented alias. */
  basisModel: ModelId;
  serviceTier: TokenPricingServiceTier;
  rateClass: string;
  longContext: boolean;
  inputUsdPerMillion: number | null;
  cachedInputUsdPerMillion: number | null;
  /** Provider cache-miss/cache-write rate. For GPT-6/5.6 this is the cache-write premium. */
  cacheMissInputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
}

export interface ResolveModelTokenPricingOptions {
  serviceTier?: TokenPricingServiceTier;
  inputTokens?: number;
  timestamp?: number;
}

interface TokenPricingRates {
  inputUsdPerMillion: number | null;
  cachedInputUsdPerMillion: number | null;
  cacheMissInputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
}

interface StaticPricingDefinition {
  provider: ProviderId;
  /** A published price change: requests at or after `from` (ms) use `definition`. */
  changes?: { from: number; definition: Omit<StaticPricingDefinition, "changes"> };
  basisModel: ModelId;
  standard: TokenPricingRates;
  fast?: TokenPricingRates;
  ultrafast?: TokenPricingRates;
  longContextThresholdTokens?: number;
  standardLong?: TokenPricingRates;
  fastLong?: TokenPricingRates;
  ultrafastLong?: TokenPricingRates;
}

const rates = (
  inputUsdPerMillion: number | null,
  cachedInputUsdPerMillion: number | null,
  cacheMissInputUsdPerMillion: number | null,
  outputUsdPerMillion: number | null,
): TokenPricingRates => ({
  inputUsdPerMillion,
  cachedInputUsdPerMillion,
  cacheMissInputUsdPerMillion,
  outputUsdPerMillion,
});

/**
 * Exact API list prices. Sources, each re-checked 2026-11-27 unless noted:
 * - OpenAI: https://developers.openai.com/api/docs/pricing and the model pages
 *   under https://developers.openai.com/api/docs/models/ (e.g. gpt-6.2-sol);
 *   cache writes are the 30-minute rate (Exocortex never asks for 12-hour
 *   retention). Older GPT-5.x rows were checked 2026-09-05.
 * - Gemini API (paid tier, Standard): https://aistudio.google.com/docs/pricing
 *   (formerly ai.google.dev/gemini-api/docs/pricing). Implicit caching only, so
 *   there is no cache-write premium: a miss costs ordinary input.
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
 * - Claude: https://platform.claude.com/docs/en/about-claude/pricing
 *   (ANTHROPIC_API_PRICING below).
 *
 * This is deliberately an exact-ID catalog. Unknown/dynamically advertised
 * models stay unpriced rather than inheriting a guessed family rate. For
 * GPT-6 and GPT-5.6 models, cache misses are provider-reported cache writes and
 * have their own 1.25x rate. Earlier OpenAI models have no cache-write premium,
 * so their cache miss rate is the ordinary input rate. A null rate records an
 * unpublished category instead of manufacturing one. Rates that change on a
 * published date take the request's timestamp.
 */
const STATIC_PRICING = new Map<ModelId, StaticPricingDefinition>();

function register(ids: readonly ModelId[], definition: StaticPricingDefinition): void {
  for (const id of ids) STATIC_PRICING.set(id, definition);
}

const OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

const GPT_6_ASTRA: StaticPricingDefinition = {
  provider: "openai",
  basisModel: "gpt-6-astra",
  standard: rates(10, 1, 12.5, 50),
  standardLong: rates(20, 2, 25, 75),
  fast: rates(20, 2, 25, 100),
  fastLong: rates(40, 4, 50, 150),
  // https://developers.openai.com/api/docs/pricing?latest-pricing=ultrafast
  // Verified 2026-09-29. Preview models without published rates stay unpriced.
  ultrafast: rates(60, 6, 75, 300),
  ultrafastLong: rates(120, 12, 150, 450),
  longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
};
register(["gpt-6-astra"], GPT_6_ASTRA);

// https://developers.openai.com/api/docs/models/gpt-6.1-sol (2026-09-29;
// Ultrafast, 6x Standard, 2026-11-27). Cached reads are 5% here, not GPT-6 Sol's 10%.
register(["gpt-6.1-sol"], {
  provider: "openai",
  basisModel: "gpt-6.1-sol",
  standard: rates(2, 0.1, 2.5, 10),
  standardLong: rates(4, 0.2, 5, 15),
  fast: rates(4, 0.2, 5, 20),
  fastLong: rates(8, 0.4, 10, 30),
  ultrafast: rates(12, 0.6, 15, 60),
  ultrafastLong: rates(24, 1.2, 30, 90),
  longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
});

// https://developers.openai.com/api/docs/models/gpt-6.2-sol (2026-11-27):
// long context (>272K) doubles input and cache rates and makes output 1.5x;
// Fast is 2x Standard; Ultrafast is 3x Standard through 2027-02-28 and 6x from
// 2027-03-01 (Pacific time).
const GPT_6_2_SOL_ULTRAFAST_LIST_FROM = Date.UTC(2027, 2, 1, 8);
const GPT_6_2_SOL: StaticPricingDefinition = {
  provider: "openai",
  basisModel: "gpt-6.2-sol",
  standard: rates(2, 0.1, 2.5, 10),
  standardLong: rates(4, 0.2, 5, 15),
  fast: rates(4, 0.2, 5, 20),
  fastLong: rates(8, 0.4, 10, 30),
  ultrafast: rates(6, 0.3, 7.5, 30),
  ultrafastLong: rates(12, 0.6, 15, 45),
  longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
};
register(["gpt-6.2-sol"], {
  ...GPT_6_2_SOL,
  changes: {
    from: GPT_6_2_SOL_ULTRAFAST_LIST_FROM,
    definition: { ...GPT_6_2_SOL, ultrafast: rates(12, 0.6, 15, 60), ultrafastLong: rates(24, 1.2, 30, 90) },
  },
});

// GPT-6 Sol/Luna model pages, checked 2026-09-22:
// https://developers.openai.com/api/docs/models/gpt-6-sol
// https://developers.openai.com/api/docs/models/gpt-6-luna
register(["gpt-6-sol", "gpt-6-sol-daybreak"], {
  provider: "openai",
  basisModel: "gpt-6-sol",
  standard: rates(2, 0.2, 2.5, 10),
  standardLong: rates(4, 0.4, 5, 15),
  fast: rates(4, 0.4, 5, 20),
  fastLong: rates(8, 0.8, 10, 30),
  longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
});
register(["gpt-6-luna"], {
  provider: "openai",
  basisModel: "gpt-6-luna",
  standard: rates(0.1, 0.01, 0.125, 0.5),
  standardLong: rates(0.2, 0.02, 0.25, 0.75),
  fast: rates(0.2, 0.02, 0.25, 1),
  fastLong: rates(0.4, 0.04, 0.5, 1.5),
  longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
});

const GPT_5_6_SOL: StaticPricingDefinition = {
  provider: "openai",
  basisModel: "gpt-5.6-sol",
  standard: rates(4, 0.4, 5, 20),
  standardLong: rates(8, 0.8, 10, 30),
  fast: rates(8, 0.8, 10, 40),
  fastLong: rates(16, 1.6, 20, 60),
  longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
};
register(["gpt-5.6-sol", "gpt-5.6"], GPT_5_6_SOL);
register(["gpt-daybreak-blue-latest"], { ...GPT_5_6_SOL, basisModel: "gpt-5.6-sol" });

const GPT_5_6_TERRA: StaticPricingDefinition = {
  provider: "openai",
  basisModel: "gpt-5.6-terra",
  standard: rates(2, 0.2, 2.5, 12),
  standardLong: rates(4, 0.4, 5, 18),
  fast: rates(4, 0.4, 5, 24),
  fastLong: rates(8, 0.8, 10, 36),
  longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
};
register(["gpt-5.6-terra"], GPT_5_6_TERRA);

const GPT_5_6_LUNA: StaticPricingDefinition = {
  provider: "openai",
  basisModel: "gpt-5.6-luna",
  standard: rates(0.2, 0.02, 0.25, 1.2),
  standardLong: rates(0.4, 0.04, 0.5, 1.8),
  fast: rates(0.4, 0.04, 0.5, 2.4),
  fastLong: rates(0.8, 0.08, 1, 3.6),
  longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
};
register(["gpt-5.6-luna"], GPT_5_6_LUNA);

const GPT_5_6_CYBER: StaticPricingDefinition = {
  provider: "openai",
  basisModel: "gpt-5.6-cyber",
  standard: rates(12.5, 1.25, 15.625, 75),
};
register(["gpt-5.6-cyber"], GPT_5_6_CYBER);
register(["gpt-daybreak-red-latest"], { ...GPT_5_6_CYBER, basisModel: "gpt-5.6-cyber" });

const GPT_5_5: StaticPricingDefinition = {
  provider: "openai",
  basisModel: "gpt-5.5",
  standard: rates(5, 0.5, 5, 30),
  // The model page publishes 2x ordinary input and 1.5x output above 272K,
  // but does not explicitly publish the long-context cached-input rate.
  standardLong: rates(10, null, 10, 45),
  longContextThresholdTokens: 272_000,
};
register(["gpt-5.5", "gpt-5.5-2026-04-23"], GPT_5_5);

const GPT_5_5_PRO: StaticPricingDefinition = {
  provider: "openai",
  basisModel: "gpt-5.5-pro",
  // The model page explicitly says this model has no cached-input discount.
  standard: rates(30, 30, 30, 180),
};
register(["gpt-5.5-pro", "gpt-5.5-pro-2026-04-23"], GPT_5_5_PRO);

const GPT_5_4: StaticPricingDefinition = {
  provider: "openai",
  basisModel: "gpt-5.4",
  standard: rates(2.5, 0.25, 2.5, 15),
  // As with GPT-5.5, the long-context cached-input rate is not explicit.
  standardLong: rates(5, null, 5, 22.5),
  longContextThresholdTokens: 272_000,
};
register(["gpt-5.4", "gpt-5.4-2026-03-05"], GPT_5_4);

const GPT_5_4_PRO: StaticPricingDefinition = {
  provider: "openai",
  basisModel: "gpt-5.4-pro",
  // Its model page does not publish a cached-input rate.
  standard: rates(30, null, 30, 180),
  standardLong: rates(60, null, 60, 270),
  longContextThresholdTokens: 272_000,
};
register(["gpt-5.4-pro", "gpt-5.4-pro-2026-03-05"], GPT_5_4_PRO);

const GPT_5_4_MINI: StaticPricingDefinition = {
  provider: "openai",
  basisModel: "gpt-5.4-mini",
  standard: rates(0.75, 0.075, 0.75, 4.5),
};
register(["gpt-5.4-mini", "gpt-5.4-mini-2026-03-17"], GPT_5_4_MINI);

const GPT_5_4_NANO: StaticPricingDefinition = {
  provider: "openai",
  basisModel: "gpt-5.4-nano",
  standard: rates(0.2, 0.02, 0.2, 1.25),
};
register(["gpt-5.4-nano", "gpt-5.4-nano-2026-03-17"], GPT_5_4_NANO);

const GPT_5_3_CODEX: StaticPricingDefinition = {
  provider: "openai",
  basisModel: "gpt-5.3-codex",
  standard: rates(1.75, 0.175, 1.75, 14),
  fast: rates(3.5, 0.35, 3.5, 28),
};
register(["gpt-5.3-codex"], GPT_5_3_CODEX);

const OX_ALPHA: StaticPricingDefinition = {
  provider: "opencode",
  basisModel: "ox-alpha",
  standard: rates(0, 0, 0, 0),
};
register(["ox-alpha"], OX_ALPHA);

// Gemini API paid tier, Standard (https://aistudio.google.com/docs/pricing,
// 2026-11-27): one rate at any prompt length, implicit caching only. Dated
// changes are taken at midnight Pacific time.
const geminiRates = (input: number, cached: number, output: number) => rates(input, cached, input, output);
register(["gemini-4-neon"], { provider: "gemini", basisModel: "gemini-4-neon", standard: geminiRates(3, 0.15, 15) });
register(["gemini-4-hydrogen"], { provider: "gemini", basisModel: "gemini-4-hydrogen", standard: geminiRates(1.5, 0.075, 7.5) });
for (const id of ["gemini-4-carbon", "gemini-4-argon"] as const) {
  register([id], {
    provider: "gemini",
    basisModel: id,
    standard: geminiRates(2, 0.1, 10),
    changes: { from: Date.UTC(2026, 11, 1, 8), definition: { provider: "gemini", basisModel: id, standard: geminiRates(4, 0.2, 20) } },
  });
}
register(["gemini-3.8-flash"], {
  provider: "gemini",
  basisModel: "gemini-3.8-flash",
  standard: geminiRates(0.75, 0.075, 3.75),
  changes: { from: Date.UTC(2027, 0, 1, 8), definition: { provider: "gemini", basisModel: "gemini-3.8-flash", standard: geminiRates(1.5, 0.15, 7.5) } },
});

function isDeepSeekPeak(timestamp: number): boolean {
  const date = new Date(timestamp);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

const DEEPSEEK_MODELS = new Set<ModelId>(["deepseek-v4-pro", "deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);

/**
 * DeepSeek's published peak/off-peak rates (2026-11-27). The retired V4 Flash
 * names are served by DeepSeek-V4.1-Flash and billed at the deepseek-flash price.
 */
function deepSeekRates(modelId: ModelId, peak: boolean): TokenPricingRates | null {
  if (modelId === "deepseek-v4-pro") return peak ? rates(1.32, 0.044, 1.32, 3.96) : rates(0.66, 0.022, 0.66, 1.98);
  if (DEEPSEEK_MODELS.has(modelId)) return peak ? rates(0.3, 0.006, 0.3, 1.2) : rates(0.15, 0.003, 0.15, 0.6);
  return null;
}

function resolveDeepSeekPricing(modelId: ModelId, timestamp: number): ModelTokenPricing | null {
  const peak = isDeepSeekPeak(timestamp);
  const selected = deepSeekRates(modelId, peak);
  if (!selected) return null;
  return {
    provider: "deepseek",
    basisModel: modelId,
    serviceTier: "standard",
    rateClass: peak ? "peak" : "off-peak",
    longContext: false,
    ...selected,
  };
}

/**
 * Resolve published pricing for one exact model/request class.
 *
 * No model-name or provider-family heuristics are used. A requested service tier
 * with no published table returns null rather than assuming a multiplier.
 */
export function resolveModelTokenPricing(
  modelId: ModelId,
  options: ResolveModelTokenPricingOptions = {},
): ModelTokenPricing | null {
  const serviceTier = options.serviceTier ?? "standard";
  const timestamp = options.timestamp ?? Date.now();

  if (DEEPSEEK_MODELS.has(modelId)) {
    if (serviceTier !== "standard") return null;
    return resolveDeepSeekPricing(modelId, timestamp);
  }

  const registered = STATIC_PRICING.get(modelId);
  if (!registered) return null;
  const definition: StaticPricingDefinition = registered.changes && timestamp >= registered.changes.from ? registered.changes.definition : registered;
  const longContext = definition.longContextThresholdTokens !== undefined
    && (options.inputTokens ?? 0) > definition.longContextThresholdTokens;
  const selected = serviceTier === "ultrafast"
    ? (longContext ? definition.ultrafastLong : definition.ultrafast)
    : serviceTier === "fast"
    ? (longContext ? definition.fastLong : definition.fast)
    : (longContext ? definition.standardLong : definition.standard);
  if (!selected) return null;

  return {
    provider: definition.provider,
    basisModel: definition.basisModel,
    serviceTier,
    rateClass: `${serviceTier}${longContext ? "-long" : ""}`,
    longContext,
    ...selected,
  };
}

// ── Claude API (Anthropic) ──────────────────────────────────────────

/** Published Claude API rates for one request, USD per million tokens. */
export interface AnthropicApiPricing {
  basisModel: ModelId;
  speed: "standard" | "fast";
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  /** 5-minute cache writes: 1.25× input. */
  cacheWrite5mUsdPerMillion: number;
  /** 1-hour cache writes: 2× input. */
  cacheWrite1hUsdPerMillion: number;
}

interface AnthropicRates { input: number; output: number }

interface AnthropicEntry {
  basisModel: ModelId;
  standard: AnthropicRates;
  /** Cache hits as a fraction of input: 0.1 on most models. */
  cacheReadMultiplier: number;
  long?: AnthropicRates;
  longContextThresholdTokens?: number;
  fast?: AnthropicRates;
}

/**
 * Claude API list prices (first-party), checked 2026-11-27 against
 * https://platform.claude.com/docs/en/about-claude/pricing: input and output
 * per million tokens; cache writes are 1.25× input (5 minutes) and 2× input
 * (1 hour); cache hits are 0.1× input except 0.025× on Fable/Mythos 5.1 and
 * 5.2 and 0.05× on Opus 5.5 and Sonnet 5.5. Fast mode has its own input and
 * output rates, and the cache multipliers apply on top of them.
 *
 * Subscription turns are not billed per token; /tokens cost prices them here
 * anyway, as what the same requests would cost on the API.
 */
const ANTHROPIC_API_PRICING = new Map<ModelId, AnthropicEntry>();

function registerClaude(ids: readonly ModelId[], standard: AnthropicRates, cacheReadMultiplier: number, extra: { long?: { thresholdTokens: number; rates: AnthropicRates }; fast?: AnthropicRates } = {}): void {
  for (const id of ids) {
    ANTHROPIC_API_PRICING.set(id, {
      basisModel: ids[0],
      standard,
      cacheReadMultiplier,
      ...(extra.long ? { long: extra.long.rates, longContextThresholdTokens: extra.long.thresholdTokens } : {}),
      ...(extra.fast ? { fast: extra.fast } : {}),
    });
  }
}

registerClaude(["claude-fable-5-2", "claude-mythos-5-2"], { input: 8, output: 40 }, 0.025, { fast: { input: 16, output: 80 } });
registerClaude(["claude-fable-5-1", "claude-mythos-5-1"], { input: 10, output: 50 }, 0.025);
registerClaude(["claude-fable-5", "claude-mythos-5"], { input: 10, output: 50 }, 0.1);
registerClaude(["claude-opus-5-5"], { input: 4, output: 20 }, 0.05, { fast: { input: 8, output: 40 } });
registerClaude(["claude-opus-5", "claude-opus-4-8"], { input: 5, output: 25 }, 0.1, { fast: { input: 10, output: 50 } });
registerClaude(["claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5"], { input: 5, output: 25 }, 0.1);
registerClaude(["claude-sonnet-5-5"], { input: 2, output: 10 }, 0.05);
registerClaude(["claude-sonnet-5"], { input: 2, output: 10 }, 0.1);
registerClaude(["claude-sonnet-4-6", "claude-sonnet-4-5"], { input: 3, output: 15 }, 0.1);
// Haiku 5.5's rates are for prompts up to 100K tokens; longer ones cost 5×.
registerClaude(["claude-haiku-5-5"], { input: 0.1, output: 0.5 }, 0.1, { long: { thresholdTokens: 100_000, rates: { input: 0.5, output: 2.5 } } });
registerClaude(["claude-haiku-4-5"], { input: 1, output: 5 }, 0.1);

/** `claude-opus-5-5[1m]`, `claude-haiku-4-5-20251001` → the catalog id. */
function claudeCatalogId(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
}

/**
 * Claude API rates for one request (`promptTokens`: its whole prompt, cached
 * parts included); null for an unknown model or a speed it has no published
 * rate for.
 */
export function resolveAnthropicApiPricing(model: string, promptTokens = 0, options: { speed?: "standard" | "fast" } = {}): AnthropicApiPricing | null {
  const entry = ANTHROPIC_API_PRICING.get(claudeCatalogId(model));
  if (!entry) return null;
  const speed = options.speed ?? "standard";
  const long = entry.long && entry.longContextThresholdTokens !== undefined && promptTokens > entry.longContextThresholdTokens;
  const selected = speed === "fast" ? entry.fast : long ? entry.long : entry.standard;
  if (!selected) return null;
  return {
    basisModel: entry.basisModel,
    speed,
    inputUsdPerMillion: selected.input,
    outputUsdPerMillion: selected.output,
    cacheReadUsdPerMillion: selected.input * entry.cacheReadMultiplier,
    cacheWrite5mUsdPerMillion: selected.input * 1.25,
    cacheWrite1hUsdPerMillion: selected.input * 2,
  };
}

/** One Claude API request's usage, as its `usage` object reports it. */
export interface ClaudeRequestUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
}

/** List-price cost of one Claude API request; null for a model or speed without published rates. */
export function claudeRequestCostUsd(model: string, usage: ClaudeRequestUsage, speed: "standard" | "fast" = "standard"): { inputUsd: number; outputUsd: number } | null {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
  const pricing = resolveAnthropicApiPricing(model, prompt, { speed });
  if (!pricing) return null;
  return {
    inputUsd: (usage.inputTokens * pricing.inputUsdPerMillion
      + usage.cacheReadTokens * pricing.cacheReadUsdPerMillion
      + usage.cacheWrite5mTokens * pricing.cacheWrite5mUsdPerMillion
      + usage.cacheWrite1hTokens * pricing.cacheWrite1hUsdPerMillion) / 1_000_000,
    outputUsd: usage.outputTokens * pricing.outputUsdPerMillion / 1_000_000,
  };
}

// ── Estimates for usage recorded without a captured cost ─────────────

/** List-price estimate for tokens that have no per-request captured cost. */
export interface UncapturedCostEstimate {
  /** Uncaptured input tokens the estimate covers (the rest have no published rate). */
  inputTokens: number;
  outputTokens: number;
  lowUsd: number;
  highUsd: number;
}

interface CategoryRates {
  cached: number | null;
  miss: number | null;
  uncached: number | null;
  unmeasured: number | null;
  output: number | null;
}

function minRate(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : Math.min(a, b);
}

function maxRate(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : Math.max(a, b);
}

function tableBounds(low: TokenPricingRates, high: TokenPricingRates): [CategoryRates, CategoryRates] {
  return [
    { cached: low.cachedInputUsdPerMillion, miss: low.cacheMissInputUsdPerMillion, uncached: low.inputUsdPerMillion, unmeasured: minRate(low.inputUsdPerMillion, low.cacheMissInputUsdPerMillion), output: low.outputUsdPerMillion },
    { cached: high.cachedInputUsdPerMillion, miss: high.cacheMissInputUsdPerMillion, uncached: high.inputUsdPerMillion, unmeasured: maxRate(high.inputUsdPerMillion, high.cacheMissInputUsdPerMillion), output: high.outputUsdPerMillion },
  ];
}

/**
 * Low and high rates per stored token category, for what a day's totals do
 * not record about each request. Claude: a stored miss was fresh input or a
 * cache write of unknown TTL (input to 2× input), and Haiku 5.5 prompts may
 * have been over 100K. DeepSeek: off-peak to peak. OpenAI legacy totals keep
 * a write-or-ordinary residual as unmeasured. Speed and OpenAI long context
 * are not stored, so the standard short-context table is used.
 */
function categoryBounds(model: ModelId, timestamp: number): [CategoryRates, CategoryRates] | null {
  const claudeLow = resolveAnthropicApiPricing(model, 0);
  if (claudeLow) {
    const claudeHigh = resolveAnthropicApiPricing(model, Number.MAX_SAFE_INTEGER)!;
    return [
      { cached: claudeLow.cacheReadUsdPerMillion, miss: claudeLow.inputUsdPerMillion, uncached: claudeLow.inputUsdPerMillion, unmeasured: claudeLow.inputUsdPerMillion, output: claudeLow.outputUsdPerMillion },
      { cached: claudeHigh.cacheReadUsdPerMillion, miss: claudeHigh.cacheWrite1hUsdPerMillion, uncached: claudeHigh.inputUsdPerMillion, unmeasured: claudeHigh.cacheWrite1hUsdPerMillion, output: claudeHigh.outputUsdPerMillion },
    ];
  }
  if (DEEPSEEK_MODELS.has(model)) {
    const offPeak = deepSeekRates(model, false);
    const peak = deepSeekRates(model, true);
    return offPeak && peak ? tableBounds(offPeak, peak) : null;
  }
  const standard = resolveModelTokenPricing(model, { timestamp });
  return standard ? tableBounds(standard, standard) : null;
}

/**
 * Price a bucket's tokens that have no captured per-request cost (recorded
 * before cost capture existed, or while the model had no price entry) from
 * its stored token categories, at the list rates in force at `timestamp`.
 * Null when the model has no published API rate.
 */
export function estimateUncapturedCost(model: ModelId, totals: TokenUsageTotals, timestamp: number): UncapturedCostEstimate | null {
  const uncapturedInput = Math.max(0, totals.inputTokens - totals.pricedInputTokens);
  const uncapturedOutput = Math.max(0, totals.outputTokens - totals.pricedOutputTokens);
  const bounds = categoryBounds(model, timestamp);
  if (!bounds) return null;
  if (uncapturedInput === 0 && uncapturedOutput === 0) return { inputTokens: 0, outputTokens: 0, lowUsd: 0, highUsd: 0 };
  // A wholly uncaptured bucket keeps its categories; a partly captured one
  // (a rare provider report missing one field) leaves only its residual.
  const categories: Array<[keyof CategoryRates, number]> = totals.pricedInputTokens === 0
    ? [["cached", totals.cachedInputTokens], ["miss", totals.cacheMissInputTokens], ["uncached", totals.uncachedInputTokens], ["unmeasured", totals.unmeasuredInputTokens]]
    : [["unmeasured", uncapturedInput]];
  const [low, high] = bounds;
  let inputTokens = 0;
  let lowUsd = 0;
  let highUsd = 0;
  for (const [category, tokens] of categories) {
    const a = low[category];
    const b = high[category];
    if (tokens <= 0 || a === null || b === null) continue;
    inputTokens += tokens;
    lowUsd += tokens * Math.min(a, b) / 1_000_000;
    highUsd += tokens * Math.max(a, b) / 1_000_000;
  }
  let outputTokens = 0;
  if (uncapturedOutput > 0 && low.output !== null && high.output !== null) {
    outputTokens = uncapturedOutput;
    lowUsd += uncapturedOutput * Math.min(low.output, high.output) / 1_000_000;
    highUsd += uncapturedOutput * Math.max(low.output, high.output) / 1_000_000;
  }
  return { inputTokens, outputTokens, lowUsd, highUsd };
}

/** The provider whose price list has this exact model id; null when no catalog lists it. */
export function pricedModelProvider(model: ModelId): ProviderId | null {
  if (resolveAnthropicApiPricing(model)) return "anthropic";
  if (DEEPSEEK_MODELS.has(model)) return "deepseek";
  return STATIC_PRICING.get(model)?.provider ?? null;
}
