import type { FastMode } from "@exocortex/shared/messages";
import { DAYBREAK_BASE_MODEL_ID, DAYBREAK_MODEL_ID, DAYBREAK_RETIRED_MODEL, DAYBREAK_UNAVAILABLE, isDaybreakModelId, openAIWireModel, supportsDaybreak as modelSupportsDaybreak } from "@exocortex/shared/daybreak";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_ORDER,
  MAX_CONTEXT,
  defaultEffortForModelId,
  normalizeEffortForModel,
  supportsImageInputsForModel,
  type ProviderId,
  type ProviderInfo,
  type ModelId,
  type ModelInfo,
  type EffortLevel,
  type ReasoningEffortInfo,
} from "@exocortex/shared/messages";
import { log } from "../log";
import { getProviderAdapter, getProviderAdapters } from "./catalog";

function buildFallbackProviderInfo(providerId: ProviderId): ProviderInfo {
  const adapter = getProviderAdapter(providerId);
  return {
    id: adapter.id,
    label: adapter.label,
    defaultModel: DEFAULT_MODEL_BY_PROVIDER[providerId],
    allowsCustomModels: adapter.allowsCustomModels,
    supportsFastMode: adapter.supportsFastMode,
    models: [...adapter.models.fallbackModels],
  };
}

let fallbackProvidersByIdCache: Record<ProviderId, ProviderInfo> | null = null;

function getFallbackProvidersById(): Record<ProviderId, ProviderInfo> {
  if (fallbackProvidersByIdCache) return fallbackProvidersByIdCache;
  fallbackProvidersByIdCache = {
    openai: buildFallbackProviderInfo("openai"),
    deepseek: buildFallbackProviderInfo("deepseek"),
    opencode: buildFallbackProviderInfo("opencode"),
    openrouter: buildFallbackProviderInfo("openrouter"),
    anthropic: buildFallbackProviderInfo("anthropic"),
  };
  return fallbackProvidersByIdCache;
}

function getFallbackProviders(): ProviderInfo[] {
  const byId = getFallbackProvidersById();
  return DEFAULT_PROVIDER_ORDER.map((providerId) => byId[providerId]);
}

const MODEL_ID_ALIASES: Record<ProviderId, Record<string, ModelId>> = {
  openrouter: {},
  anthropic: {
    fable: "claude-fable-5-1",
    opus: "claude-opus-5-5",
    sonnet: "claude-sonnet-5-5",
    haiku: "claude-haiku-5-5",
  },
  openai: {},
  deepseek: {
    pro: "deepseek-v4-pro",
    "v4-pro": "deepseek-v4-pro",
    flash: "deepseek-v4-flash",
    "v4-flash": "deepseek-v4-flash",
  },
  opencode: {
    ox: "ox-alpha",
    "ox-alpha-free": "ox-alpha",
  },
};

let providerCache: ProviderInfo[] | null = null;
let lastRefreshAt = 0;
let inflightRefresh: Promise<boolean> | null = null;
const REFRESH_TTL_MS = 5 * 60 * 1000;

function cloneProviders(providers: ProviderInfo[]): ProviderInfo[] {
  return structuredClone(providers);
}

function getProviderCache(): ProviderInfo[] {
  if (!providerCache) {
    providerCache = structuredClone(getFallbackProviders());
  }
  return providerCache;
}

function chooseDefaultModel(providerId: ProviderId, models: ModelInfo[]): ModelId {
  const fallback = getFallbackProviders().find((provider) => provider.id === providerId)?.defaultModel;
  if (fallback && models.some((model) => model.id === fallback)) {
    return fallback;
  }
  return models[0]?.id ?? fallback ?? "";
}

async function refreshProviderInfo(fallback: ProviderInfo): Promise<ProviderInfo> {
  try {
    const adapter = getProviderAdapter(fallback.id);
    const models = await adapter.models.fetch();
    return {
      id: fallback.id,
      label: adapter.label,
      defaultModel: chooseDefaultModel(fallback.id, models),
      allowsCustomModels: adapter.allowsCustomModels,
      supportsFastMode: adapter.supportsFastMode,
      models,
    };
  } catch (err) {
    log("warn", `provider registry: using fallback ${fallback.id} models (${err instanceof Error ? err.message : err})`);
    return fallback;
  }
}

export function getProviders(): ProviderInfo[] {
  return cloneProviders(getProviderCache());
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

export function canonicalizeModel(providerId: ProviderId, model: ModelId): ModelId {
  return getModelInfo(providerId, model)?.id ?? MODEL_ID_ALIASES[providerId][model] ?? model;
}

export function getMaxContext(providerId: ProviderId, model: ModelId): number | null {
  return getModelInfo(providerId, model)?.maxContext ?? MAX_CONTEXT[providerId === "openai" ? openAIWireModel(model) : model] ?? null;
}

export function getSupportedEfforts(providerId: ProviderId, model: ModelId): ReasoningEffortInfo[] {
  return getModelInfo(providerId, model)?.supportedEfforts ?? [];
}

export function getDefaultEffort(providerId: ProviderId, model: ModelId): EffortLevel {
  return getModelInfo(providerId, model)?.defaultEffort ?? defaultEffortForModelId(providerId, model);
}

export function normalizeEffort(providerId: ProviderId, model: ModelId, effort: EffortLevel | null | undefined): EffortLevel {
  const modelInfo = getModelInfo(providerId, model);
  if (modelInfo) return normalizeEffortForModel(modelInfo, effort);
  return effort ?? defaultEffortForModelId(providerId, model);
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

export function supportsFastMode(providerId: ProviderId, model?: ModelId, mode: FastMode = true): boolean {
  const provider = getProvider(providerId);
  if (!provider?.supportsFastMode) return false;
  if (mode === "ultrafast") return !!model && getModelInfo(providerId, model)?.supportsUltrafastMode === true;
  return !model || getModelInfo(providerId, model)?.supportsFastMode !== false;
}

export function supportsImageInputs(providerId: ProviderId, model: ModelId): boolean {
  return supportsImageInputsForModel(getModelInfo(providerId, model));
}

/** Fail closed for our reserved product aliases, even on custom-model providers. */
export function daybreakSelectionError(providerId: ProviderId, model: ModelId): string | null {
  if (!isDaybreakModelId(model)) return null;
  if (providerId !== "openai" || model !== DAYBREAK_MODEL_ID) return DAYBREAK_RETIRED_MODEL;
  return modelSupportsDaybreak(providerId, getModelInfo(providerId, DAYBREAK_BASE_MODEL_ID))
    ? null : DAYBREAK_UNAVAILABLE;
}

/** Resolve once at turn admission; all tool rounds and compactions reuse it. */
export function cyberAccessProgramForSelection(providerId: ProviderId, model: ModelId): "standard" | "daybreak_blue" | undefined {
  const error = daybreakSelectionError(providerId, model);
  if (error) throw new Error(error);
  if (model === DAYBREAK_MODEL_ID) {
    return "daybreak_blue";
  }
  return providerId === "openai" && getModelInfo(providerId, model)?.supportsStandardCyber
    ? "standard" : undefined;
}

export async function refreshProviders(force = false): Promise<boolean> {
  if (!force && Date.now() - lastRefreshAt < REFRESH_TTL_MS) {
    return false;
  }
  if (inflightRefresh) return inflightRefresh;

  inflightRefresh = (async () => {
    const fallbackProvidersById = getFallbackProvidersById();
    const currentProviders = getProviderCache();
    const next = await Promise.all(getProviderAdapters().map((provider) => refreshProviderInfo(fallbackProvidersById[provider.id])));
    const changed = JSON.stringify(currentProviders) !== JSON.stringify(next);
    providerCache = next;
    lastRefreshAt = Date.now();
    return changed;
  })().finally(() => {
    inflightRefresh = null;
  });

  return inflightRefresh;
}
