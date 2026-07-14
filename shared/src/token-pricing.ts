import type { ModelId, ProviderId } from "./messages";

export interface ModelTokenPricing {
  provider: ProviderId;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Published/known model whose rates are being used for this estimate. */
  basisModel: ModelId;
}

/** Minimal provider catalog shape needed to associate dynamically listed models. */
export interface ModelProviderCatalogEntry {
  id: ProviderId;
  models: readonly { id: ModelId }[];
}

interface TokenPricingRates {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

interface ModelPricingRule {
  matches: (modelId: ModelId) => boolean;
  basisModel: ModelId;
  rates: TokenPricingRates;
}

interface ProviderPricingProfile {
  inferModel: (modelId: ModelId) => boolean;
  defaultBasisModel: ModelId;
  defaultRates: TokenPricingRates;
  rules: readonly ModelPricingRule[];
}

/**
 * Pricing references checked 2026-04-19:
 * - OpenAI API pricing + API docs pricing pages
 *
 * OpenAI does not publish numeric rates for every Codex model/tier. The
 * standard and mini GPT-5.4 rates are therefore provider-family fallbacks,
 * while GPT-5.3-Codex-Spark uses the published standard GPT-5.3-Codex rate.
 * A resolved basisModel makes every such fallback visible to callers.
 */
const OPENAI_STANDARD_RATES: TokenPricingRates = {
  inputUsdPerMillion: 2.5,
  cachedInputUsdPerMillion: 0.25,
  outputUsdPerMillion: 15,
};

const OPENAI_MINI_RATES: TokenPricingRates = {
  inputUsdPerMillion: 0.75,
  cachedInputUsdPerMillion: 0.075,
  outputUsdPerMillion: 4.5,
};

const OPENAI_CODEX_SPARK_RATES: TokenPricingRates = {
  inputUsdPerMillion: 1.75,
  cachedInputUsdPerMillion: 0.175,
  outputUsdPerMillion: 14,
};

const DEEPSEEK_PRO_RATES: TokenPricingRates = {
  inputUsdPerMillion: 0.435,
  cachedInputUsdPerMillion: 0.003625,
  outputUsdPerMillion: 0.87,
};

const DEEPSEEK_FLASH_RATES: TokenPricingRates = {
  inputUsdPerMillion: 0.14,
  cachedInputUsdPerMillion: 0.0028,
  outputUsdPerMillion: 0.28,
};

const PROVIDER_PRICING_PROFILES: Record<ProviderId, ProviderPricingProfile> = {
  openai: {
    inferModel: (modelId) => /^gpt-/i.test(modelId),
    defaultBasisModel: "gpt-5.4",
    defaultRates: OPENAI_STANDARD_RATES,
    rules: [
      {
        matches: (modelId) => modelId === "gpt-5.3-codex-spark",
        basisModel: "gpt-5.3-codex",
        rates: OPENAI_CODEX_SPARK_RATES,
      },
      {
        matches: (modelId) => /(?:^|-)mini(?:-|$)/i.test(modelId),
        basisModel: "gpt-5.4-mini",
        rates: OPENAI_MINI_RATES,
      },
    ],
  },
  deepseek: {
    inferModel: (modelId) => /^deepseek-/i.test(modelId),
    defaultBasisModel: "deepseek-v4-pro",
    defaultRates: DEEPSEEK_PRO_RATES,
    rules: [
      {
        matches: (modelId) => /(?:^|-)flash(?:-|$)/i.test(modelId),
        basisModel: "deepseek-v4-flash",
        rates: DEEPSEEK_FLASH_RATES,
      },
    ],
  },
};

function inferProvider(modelId: ModelId): ProviderId | null {
  for (const provider of Object.keys(PROVIDER_PRICING_PROFILES) as ProviderId[]) {
    if (PROVIDER_PRICING_PROFILES[provider].inferModel(modelId)) return provider;
  }
  return null;
}

function catalogProvider(modelId: ModelId, catalog: readonly ModelProviderCatalogEntry[]): ProviderId | null {
  const matches = catalog
    .filter((provider) => provider.models.some((model) => model.id === modelId))
    .map((provider) => provider.id);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const inferred = inferProvider(modelId);
    return inferred && matches.includes(inferred) ? inferred : null;
  }
  return null;
}

/**
 * Resolve cost-estimation pricing for a model.
 *
 * Models advertised by a provider automatically inherit that provider's
 * default pricing profile, so adding a model does not require updating the
 * /tokens command. Known variants can override the provider default. For old
 * persisted models absent from today's catalog, provider-specific id patterns
 * preserve the same behavior. Unknown models return null instead of silently
 * receiving a potentially unrelated provider's rates.
 */
export function resolveModelTokenPricing(
  modelId: ModelId,
  catalog: readonly ModelProviderCatalogEntry[] = [],
): ModelTokenPricing | null {
  const provider = catalogProvider(modelId, catalog) ?? inferProvider(modelId);
  if (!provider) return null;

  const profile = PROVIDER_PRICING_PROFILES[provider];
  const rule = profile.rules.find((candidate) => candidate.matches(modelId));
  const basisModel = rule?.basisModel ?? profile.defaultBasisModel;
  const rates = rule?.rates ?? profile.defaultRates;
  return { provider, basisModel, ...rates };
}
