import { MAX_CONTEXT, normalizeEffortForModel, type ProviderId, type ProviderInfo, type ModelId, type ModelInfo, type EffortLevel, type ReasoningEffortInfo } from "@exocortex/shared/messages";
import { log } from "../log";
import { fetchAnthropicModels, FALLBACK_ANTHROPIC_MODELS } from "./anthropic/models";
import { fetchOpenAIModels, FALLBACK_OPENAI_MODELS } from "./openai/models";

const FALLBACK_PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    defaultModel: "claude-opus-4-6",
    allowsCustomModels: false,
    models: [...FALLBACK_ANTHROPIC_MODELS],
  },
  {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-5.4",
    allowsCustomModels: true,
    models: [...FALLBACK_OPENAI_MODELS],
  },
];

let providerCache: ProviderInfo[] = structuredClone(FALLBACK_PROVIDERS);
let lastRefreshAt = 0;
let inflightRefresh: Promise<boolean> | null = null;
const REFRESH_TTL_MS = 5 * 60 * 1000;

function cloneProviders(providers: ProviderInfo[]): ProviderInfo[] {
  return structuredClone(providers);
}

function chooseDefaultModel(providerId: ProviderId, models: ModelInfo[]): ModelId {
  const fallback = FALLBACK_PROVIDERS.find((provider) => provider.id === providerId)?.defaultModel;
  if (fallback && models.some((model) => model.id === fallback)) {
    return fallback;
  }
  return models[0]?.id ?? fallback ?? "";
}

async function refreshProviderInfo(fallback: ProviderInfo): Promise<ProviderInfo> {
  try {
    const models = fallback.id === "anthropic"
      ? await fetchAnthropicModels()
      : await fetchOpenAIModels();
    return {
      id: fallback.id,
      label: fallback.label,
      defaultModel: chooseDefaultModel(fallback.id, models),
      allowsCustomModels: fallback.allowsCustomModels,
      models,
    };
  } catch (err) {
    log("warn", `provider registry: using fallback ${fallback.id} models (${err instanceof Error ? err.message : err})`);
    return fallback;
  }
}

export function getProviders(): ProviderInfo[] {
  return cloneProviders(providerCache);
}

export function getProvider(providerId: ProviderId): ProviderInfo | null {
  return getProviders().find((provider) => provider.id === providerId) ?? null;
}

export function getDefaultProvider(): ProviderInfo {
  return getProviders()[0];
}

export function getDefaultModel(providerId: ProviderId): ModelId {
  return getProvider(providerId)?.defaultModel ?? getDefaultProvider().defaultModel;
}

export function getModelInfo(providerId: ProviderId, model: ModelId): ModelInfo | null {
  return getProvider(providerId)?.models.find((candidate) => candidate.id === model) ?? null;
}

export function getMaxContext(providerId: ProviderId, model: ModelId): number | null {
  return getModelInfo(providerId, model)?.maxContext ?? MAX_CONTEXT[model] ?? null;
}

export function getSupportedEfforts(providerId: ProviderId, model: ModelId): ReasoningEffortInfo[] {
  return getModelInfo(providerId, model)?.supportedEfforts ?? [];
}

export function getDefaultEffort(providerId: ProviderId, model: ModelId): EffortLevel {
  return normalizeEffortForModel(getModelInfo(providerId, model), null);
}

export function normalizeEffort(providerId: ProviderId, model: ModelId, effort: EffortLevel | null | undefined): EffortLevel {
  return normalizeEffortForModel(getModelInfo(providerId, model), effort);
}

export function supportsEffort(providerId: ProviderId, model: ModelId, effort: EffortLevel): boolean {
  return getSupportedEfforts(providerId, model).some((candidate) => candidate.effort === effort);
}

export function isKnownModel(providerId: ProviderId, model: ModelId): boolean {
  return getProvider(providerId)?.models.some((candidate) => candidate.id === model) ?? false;
}

export function allowsCustomModels(providerId: ProviderId): boolean {
  return getProvider(providerId)?.allowsCustomModels ?? false;
}

export async function refreshProviders(force = false): Promise<boolean> {
  if (!force && Date.now() - lastRefreshAt < REFRESH_TTL_MS) {
    return false;
  }
  if (inflightRefresh) return inflightRefresh;

  inflightRefresh = (async () => {
    const next = await Promise.all(FALLBACK_PROVIDERS.map((provider) => refreshProviderInfo(provider)));
    const changed = JSON.stringify(providerCache) !== JSON.stringify(next);
    providerCache = next;
    lastRefreshAt = Date.now();
    return changed;
  })().finally(() => {
    inflightRefresh = null;
  });

  return inflightRefresh;
}
