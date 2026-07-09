import { EFFORT_LEVELS, type EffortLevel, type ModelInfo, type ReasoningEffortInfo } from "@exocortex/shared/messages";
import { formatModelDisplayName } from "@exocortex/shared/model-display";
import { log } from "../../log";
import { getVerifiedSession } from "./auth";
import { supportsOpenAIImageInputs } from "./capabilities";
import { OPENAI_CODEX_CLIENT_VERSION, OPENAI_MODELS_URL } from "./constants";
import { buildOpenAIJsonHeaders } from "./http";

const DEFAULT_OPENAI_CONTEXT_TOKENS = 272_000;
const GPT_5_6_CONTEXT_TOKENS = 1_050_000;
const CODEX_SPARK_CONTEXT_TOKENS = 128_000;

const FALLBACK_OPENAI_EFFORTS: ReasoningEffortInfo[] = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
];

const GPT_5_6_OPENAI_EFFORTS: ReasoningEffortInfo[] = [
  { effort: "none", description: "Disable reasoning for the fastest responses" },
  ...FALLBACK_OPENAI_EFFORTS,
  { effort: "max", description: "Maximum reasoning for the hardest quality-first workloads" },
];

function fallbackOpenAIModel(
  id: string,
  maxContext = DEFAULT_OPENAI_CONTEXT_TOKENS,
  supportedEfforts: ReasoningEffortInfo[] = FALLBACK_OPENAI_EFFORTS,
  defaultEffort: EffortLevel = "medium",
): ModelInfo {
  return {
    id,
    label: formatModelDisplayName(id),
    maxContext,
    supportedEfforts,
    defaultEffort,
    supportsImages: supportsOpenAIImageInputs(id),
  };
}

export const FALLBACK_OPENAI_MODELS: ModelInfo[] = [
  fallbackOpenAIModel("gpt-5.6-sol", GPT_5_6_CONTEXT_TOKENS, GPT_5_6_OPENAI_EFFORTS),
  fallbackOpenAIModel("gpt-5.6-terra", GPT_5_6_CONTEXT_TOKENS, GPT_5_6_OPENAI_EFFORTS),
  fallbackOpenAIModel("gpt-5.6-luna", GPT_5_6_CONTEXT_TOKENS, GPT_5_6_OPENAI_EFFORTS),
  fallbackOpenAIModel("gpt-5.5"),
  fallbackOpenAIModel("gpt-5.4", DEFAULT_OPENAI_CONTEXT_TOKENS, FALLBACK_OPENAI_EFFORTS, "high"),
  fallbackOpenAIModel("gpt-5.4-mini"),
  fallbackOpenAIModel("gpt-5.3-codex-spark", CODEX_SPARK_CONTEXT_TOKENS),
];

const PRIMARY_OPENAI_MODEL_FAMILIES = ["gpt-5.6", "gpt-5.5", "gpt-5.4"] as const;
const PREFERRED_OPENAI_MODEL_ORDER = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.5-mini",
  "gpt-5.5-nano",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex-spark",
] as const;
const MANUAL_OPENAI_MODEL_IDS = new Set(["gpt-5.3-codex-spark"]);

type PrimaryOpenAIModelFamily = typeof PRIMARY_OPENAI_MODEL_FAMILIES[number];

interface OpenAICodexModel {
  slug?: string;
  display_name?: string;
  context_window?: number;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
  default_reasoning_level?: EffortLevel;
  supported_reasoning_levels?: Array<{
    effort?: EffortLevel;
    description?: string;
  }>;
}

interface OpenAIModelsResponse {
  models?: OpenAICodexModel[];
}

function isOpenAIModelInFamily(modelSlug: string, family: PrimaryOpenAIModelFamily): boolean {
  return new RegExp(`^${family.replace(".", "\\.")}(?:-|$)`).test(modelSlug);
}

function isUnsupportedOpenAIModel(modelSlug: string): boolean {
  // Do not expose the broad GPT-5.6 alias; users should choose a concrete
  // GPT-5.6 tier explicitly: Sol, Terra, or Luna.
  return modelSlug === "gpt-5.6";
}

function preferredOpenAIPrimaryFamily(models: OpenAICodexModel[]): PrimaryOpenAIModelFamily {
  for (const family of PRIMARY_OPENAI_MODEL_FAMILIES) {
    if (models.some((model) => typeof model.slug === "string" && isOpenAIModelInFamily(model.slug, family))) {
      return family;
    }
  }
  return PRIMARY_OPENAI_MODEL_FAMILIES[PRIMARY_OPENAI_MODEL_FAMILIES.length - 1];
}

function isPreferredOpenAIModel(model: OpenAICodexModel, preferredFamily: PrimaryOpenAIModelFamily): boolean {
  return typeof model.slug === "string" && (
    isOpenAIModelInFamily(model.slug, preferredFamily)
    || MANUAL_OPENAI_MODEL_IDS.has(model.slug)
  );
}

function preferredDefaultEffort(modelSlug: string, apiDefaultEffort: EffortLevel | undefined): EffortLevel {
  // Product preference: use medium effort for GPT-5.6/5.5-family models, even if
  // upstream model metadata reports a higher default.
  if (isOpenAIModelInFamily(modelSlug, "gpt-5.6")) return "medium";
  if (isOpenAIModelInFamily(modelSlug, "gpt-5.5")) return "medium";
  // Keep the older primary OpenAI default on high effort.
  if (modelSlug === "gpt-5.4") return "high";
  return apiDefaultEffort ?? "medium";
}

function fallbackEffortsForModel(modelSlug: string): ReasoningEffortInfo[] {
  if (isOpenAIModelInFamily(modelSlug, "gpt-5.6")) return GPT_5_6_OPENAI_EFFORTS;
  return FALLBACK_OPENAI_EFFORTS;
}

function supportedEffortsForModel(modelSlug: string, apiEfforts: ReasoningEffortInfo[]): ReasoningEffortInfo[] {
  const fallbackEfforts = fallbackEffortsForModel(modelSlug);
  if (apiEfforts.length === 0) return fallbackEfforts;
  if (!isOpenAIModelInFamily(modelSlug, "gpt-5.6")) return apiEfforts;

  const apiEffortByLevel = new Map(apiEfforts.map((item) => [item.effort, item]));
  const fallbackLevels = new Set(fallbackEfforts.map((item) => item.effort));
  return [
    ...fallbackEfforts.map((fallback) => apiEffortByLevel.get(fallback.effort) ?? fallback),
    ...apiEfforts.filter((item) => !fallbackLevels.has(item.effort)),
  ];
}

function fallbackContextWindow(modelSlug: string): number {
  if (isOpenAIModelInFamily(modelSlug, "gpt-5.6")) return GPT_5_6_CONTEXT_TOKENS;
  if (modelSlug === "gpt-5.3-codex-spark") return CODEX_SPARK_CONTEXT_TOKENS;
  return DEFAULT_OPENAI_CONTEXT_TOKENS;
}

function toModelInfo(model: OpenAICodexModel): ModelInfo | null {
  if (!model.slug) return null;
  const supportedEfforts = (model.supported_reasoning_levels ?? [])
    .filter((candidate): candidate is { effort: EffortLevel; description?: string } => (
      typeof candidate.effort === "string" && (EFFORT_LEVELS as readonly string[]).includes(candidate.effort)
    ))
    .map((candidate) => ({
      effort: candidate.effort,
      description: candidate.description?.trim() || candidate.effort,
    }));
  return {
    id: model.slug,
    label: formatModelDisplayName(model.slug),
    maxContext: model.context_window ?? fallbackContextWindow(model.slug),
    supportedEfforts: supportedEffortsForModel(model.slug, supportedEfforts),
    defaultEffort: preferredDefaultEffort(model.slug, model.default_reasoning_level),
    supportsImages: supportsOpenAIImageInputs(model.slug),
  };
}

function selectPreferredOpenAIModels(models: OpenAICodexModel[]): ModelInfo[] {
  const visibleModels = models
    .filter((model) => model.supported_in_api !== false)
    .filter((model) => model.visibility !== "hide")
    .filter((model) => typeof model.slug !== "string" || !isUnsupportedOpenAIModel(model.slug));
  const preferredFamily = preferredOpenAIPrimaryFamily(visibleModels);

  return visibleModels
    .filter((model) => isPreferredOpenAIModel(model, preferredFamily))
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
    .map(toModelInfo)
    .filter((model): model is ModelInfo => model !== null);
}

function sortOpenAIModels(models: ModelInfo[]): ModelInfo[] {
  const order = new Map<string, number>(PREFERRED_OPENAI_MODEL_ORDER.map((id, index) => [id, index]));
  return models
    .map((model, index) => ({ model, index, rank: order.get(model.id) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ model }) => model);
}

function mergeMissingFallbackModels(models: ModelInfo[], remoteModels: OpenAICodexModel[]): ModelInfo[] {
  const merged = [...models];
  const selectedModelIds = new Set(models.map((model) => model.id));
  const remoteModelById = new Map(
    remoteModels
      .filter((model): model is OpenAICodexModel & { slug: string } => typeof model.slug === "string")
      .map((model) => [model.slug, model]),
  );

  for (const fallbackModel of FALLBACK_OPENAI_MODELS) {
    if (selectedModelIds.has(fallbackModel.id)) continue;

    const remoteModel = remoteModelById.get(fallbackModel.id);
    if (remoteModel && (remoteModel.supported_in_api === false || remoteModel.visibility === "hide")) {
      continue;
    }

    merged.push(fallbackModel);
  }

  return sortOpenAIModels(merged);
}

export function selectOpenAIModelsForTest(models: OpenAICodexModel[]): ModelInfo[] {
  return mergeMissingFallbackModels(selectPreferredOpenAIModels(models), models);
}

export async function fetchOpenAIModels(): Promise<ModelInfo[]> {
  const session = await getVerifiedSession();
  const url = `${OPENAI_MODELS_URL}?client_version=${encodeURIComponent(OPENAI_CODEX_CLIENT_VERSION)}`;
  const res = await fetch(url, {
    headers: {
      ...buildOpenAIJsonHeaders({
        Authorization: `Bearer ${session.accessToken}`,
      }),
      ...(session.accountId ? { "ChatGPT-Account-ID": session.accountId } : {}),
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI Codex model fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json() as OpenAIModelsResponse;
  const preferredModels = selectPreferredOpenAIModels(data.models ?? []);

  if (preferredModels.length === 0) {
    log("warn", "openai models: Codex endpoint returned no preferred GPT-5 family models, keeping fallback list");
    return FALLBACK_OPENAI_MODELS;
  }

  return mergeMissingFallbackModels(preferredModels, data.models ?? []);
}
