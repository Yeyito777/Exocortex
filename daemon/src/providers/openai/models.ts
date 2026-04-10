import { type EffortLevel, type ModelInfo, type ReasoningEffortInfo } from "@exocortex/shared/messages";
import { formatModelDisplayName } from "@exocortex/shared/model-display";
import { log } from "../../log";
import { getVerifiedSession } from "./auth";
import { supportsOpenAIImageInputs } from "./capabilities";
import { OPENAI_CODEX_CLIENT_VERSION, OPENAI_MODELS_URL } from "./constants";
import { buildOpenAIJsonHeaders } from "./http";

const FALLBACK_OPENAI_EFFORTS: ReasoningEffortInfo[] = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
];

export const FALLBACK_OPENAI_MODELS: ModelInfo[] = [
  {
    id: "gpt-5.4",
    label: formatModelDisplayName("gpt-5.4"),
    maxContext: 272_000,
    supportedEfforts: FALLBACK_OPENAI_EFFORTS,
    defaultEffort: "high",
    supportsImages: supportsOpenAIImageInputs("gpt-5.4"),
  },
  {
    id: "gpt-5.4-mini",
    label: formatModelDisplayName("gpt-5.4-mini"),
    maxContext: 272_000,
    supportedEfforts: FALLBACK_OPENAI_EFFORTS,
    defaultEffort: "medium",
    supportsImages: supportsOpenAIImageInputs("gpt-5.4-mini"),
  },
  {
    id: "gpt-5.3-codex-spark",
    label: formatModelDisplayName("gpt-5.3-codex-spark"),
    maxContext: 128_000,
    supportedEfforts: FALLBACK_OPENAI_EFFORTS,
    defaultEffort: "medium",
    supportsImages: supportsOpenAIImageInputs("gpt-5.3-codex-spark"),
  },
];

const MANUAL_OPENAI_MODEL_IDS = new Set(["gpt-5.3-codex-spark"]);

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

function isPreferredOpenAIModel(model: OpenAICodexModel): boolean {
  return typeof model.slug === "string" && (
    /^gpt-5\.4(?:-|$)/.test(model.slug)
    || MANUAL_OPENAI_MODEL_IDS.has(model.slug)
  );
}

function preferredDefaultEffort(modelSlug: string, apiDefaultEffort: EffortLevel | undefined): EffortLevel {
  // Product preference: make the primary OpenAI default land on high effort,
  // even if the upstream model metadata reports a lower default.
  if (modelSlug === "gpt-5.4") return "high";
  return apiDefaultEffort ?? "medium";
}

function toModelInfo(model: OpenAICodexModel): ModelInfo | null {
  if (!model.slug) return null;
  const supportedEfforts = (model.supported_reasoning_levels ?? [])
    .filter((candidate): candidate is { effort: EffortLevel; description?: string } => typeof candidate.effort === "string")
    .map((candidate) => ({
      effort: candidate.effort,
      description: candidate.description?.trim() || candidate.effort,
    }));
  return {
    id: model.slug,
    label: formatModelDisplayName(model.slug),
    maxContext: model.context_window ?? 272_000,
    supportedEfforts: supportedEfforts.length > 0 ? supportedEfforts : FALLBACK_OPENAI_EFFORTS,
    defaultEffort: preferredDefaultEffort(model.slug, model.default_reasoning_level),
    supportsImages: supportsOpenAIImageInputs(model.slug),
  };
}

function selectPreferredOpenAIModels(models: OpenAICodexModel[]): ModelInfo[] {
  return models
    .filter((model) => model.supported_in_api !== false)
    .filter((model) => model.visibility !== "hide")
    .filter(isPreferredOpenAIModel)
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
    .map(toModelInfo)
    .filter((model): model is ModelInfo => model !== null);
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

  return merged;
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
    log("warn", "openai models: Codex endpoint returned no preferred models, keeping fallback list");
    return FALLBACK_OPENAI_MODELS;
  }

  return mergeMissingFallbackModels(preferredModels, data.models ?? []);
}
