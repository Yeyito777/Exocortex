import { DEFAULT_MODEL_BY_PROVIDER, type EffortLevel, type ModelInfo, type ReasoningEffortInfo } from "@exocortex/shared/messages";
import { formatModelDisplayName } from "@exocortex/shared/model-display";
import { log } from "../../log";
import { getVerifiedApiKey } from "./auth";
import { DEEPSEEK_MODELS_PATH } from "./constants";
import { buildDeepSeekJsonHeaders, buildDeepSeekUrl } from "./http";
import type { DeepSeekModelsResponse } from "./types";

const DEEPSEEK_CONTEXT_TOKENS = 1_000_000;

export const DEEPSEEK_EFFORTS: ReasoningEffortInfo[] = [
  { effort: "none", description: "Disable DeepSeek thinking mode" },
  { effort: "high", description: "DeepSeek thinking mode, high effort" },
  { effort: "max", description: "DeepSeek thinking mode, maximum effort" },
];

function deepSeekDefaultEffort(_modelId: string): EffortLevel {
  return "high";
}

function modelInfo(modelId: string): ModelInfo {
  return {
    id: modelId,
    label: formatModelDisplayName(modelId),
    maxContext: DEEPSEEK_CONTEXT_TOKENS,
    supportedEfforts: DEEPSEEK_EFFORTS,
    defaultEffort: deepSeekDefaultEffort(modelId),
    supportsImages: false,
  };
}

export const FALLBACK_DEEPSEEK_MODELS: ModelInfo[] = [
  modelInfo(DEFAULT_MODEL_BY_PROVIDER.deepseek),
  modelInfo("deepseek-v4-flash"),
];

const PREFERRED_DEEPSEEK_MODEL_ORDER = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
] as const;

function sortDeepSeekModels(models: ModelInfo[]): ModelInfo[] {
  const order = new Map<string, number>(PREFERRED_DEEPSEEK_MODEL_ORDER.map((id, index) => [id, index]));
  return models
    .map((model, index) => ({ model, index, rank: order.get(model.id) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ model }) => model);
}

export async function fetchDeepSeekModels(): Promise<ModelInfo[]> {
  const apiKey = await getVerifiedApiKey();
  const res = await fetch(buildDeepSeekUrl(DEEPSEEK_MODELS_PATH), {
    headers: buildDeepSeekJsonHeaders(apiKey),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek model fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json() as DeepSeekModelsResponse;
  const remoteIds = (data.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const models = remoteIds.map(modelInfo);
  for (const fallback of FALLBACK_DEEPSEEK_MODELS) {
    if (!models.some((model) => model.id === fallback.id)) models.push(fallback);
  }

  if (models.length === 0) {
    log("warn", "deepseek models: /models returned no models, keeping fallback list");
    return FALLBACK_DEEPSEEK_MODELS;
  }

  return sortDeepSeekModels(models);
}
