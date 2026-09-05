import type { ModelId, ProviderId } from "./messages";

export type TokenPricingServiceTier = "standard" | "fast";

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
  basisModel: ModelId;
  standard: TokenPricingRates;
  fast?: TokenPricingRates;
  longContextThresholdTokens?: number;
  standardLong?: TokenPricingRates;
  fastLong?: TokenPricingRates;
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
 * Exact API pricing references checked 2026-09-05:
 * - https://developers.openai.com/api/docs/pricing
 * - https://developers.openai.com/api/docs/guides/prompt-caching
 * - individual OpenAI model pages under /api/docs/models/
 * - https://api-docs.deepseek.com/quick_start/pricing
 *
 * This is deliberately an exact-ID catalog. Unknown/dynamically advertised
 * models stay unpriced rather than inheriting a guessed family rate. For
 * GPT-6 Astra and GPT-5.6, cache misses are provider-reported cache writes and
 * have their own 1.25x rate. Earlier OpenAI models have no cache-write premium,
 * so their cache miss rate is the ordinary input rate. A null rate records an
 * unpublished category instead of manufacturing one.
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
  longContextThresholdTokens: OPENAI_LONG_CONTEXT_THRESHOLD_TOKENS,
};
register(["gpt-6-astra"], GPT_6_ASTRA);

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

function isDeepSeekPeak(timestamp: number): boolean {
  const date = new Date(timestamp);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

function resolveDeepSeekPricing(modelId: ModelId, timestamp: number): ModelTokenPricing | null {
  const peak = isDeepSeekPeak(timestamp);
  let selected: TokenPricingRates;
  if (modelId === "deepseek-v4-pro") {
    selected = peak ? rates(1.32, 0.044, 1.32, 3.96) : rates(0.66, 0.022, 0.66, 1.98);
  } else if (modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-flash-vision-exp") {
    selected = peak ? rates(0.44, 0.014, 0.44, 1.32) : rates(0.22, 0.007, 0.22, 0.66);
  } else {
    return null;
  }
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

  if (modelId === "deepseek-v4-pro"
      || modelId === "deepseek-v4-flash"
      || modelId === "deepseek-v4-flash-vision-exp") {
    if (serviceTier !== "standard") return null;
    return resolveDeepSeekPricing(modelId, timestamp);
  }

  const definition = STATIC_PRICING.get(modelId);
  if (!definition) return null;
  const longContext = definition.longContextThresholdTokens !== undefined
    && (options.inputTokens ?? 0) > definition.longContextThresholdTokens;
  const selected = serviceTier === "fast"
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
