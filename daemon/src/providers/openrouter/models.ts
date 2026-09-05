import type { ModelInfo, ReasoningEffortInfo } from "@exocortex/shared/messages";
import { buildOpenRouterUrl } from "./http";
import { OPENROUTER_MODELS_PATH } from "./constants";

// Curated uncensored-oriented fine-tunes, not claims of weight abliteration.
interface OpenRouterModelInfo extends ModelInfo {
  maxCompletionTokens: number;
}

const HERMES_EFFORTS: ReasoningEffortInfo[] = [
  { effort: "none", description: "Reasoning off" },
  { effort: "high", description: "Reasoning on (provider-managed budget)" },
];

export const FALLBACK_OPENROUTER_MODELS: OpenRouterModelInfo[] = [
  {
    id: "nousresearch/hermes-4-405b", label: "Hermes 4 405B",
    maxContext: 131072, maxCompletionTokens: 117964,
    supportedEfforts: HERMES_EFFORTS, defaultEffort: "high", supportsImages: false, supportsTools: false,
  },
  {
    id: "nousresearch/hermes-4-70b", label: "Hermes 4 70B",
    maxContext: 131072, maxCompletionTokens: 117964,
    supportedEfforts: HERMES_EFFORTS, defaultEffort: "high", supportsImages: false, supportsTools: false,
  },
  {
    id: "cognitivecomputations/dolphin-mistral-24b-venice-edition", label: "Dolphin Mistral 24B · Venice",
    maxContext: 128000, maxCompletionTokens: 8192,
    supportedEfforts: [], defaultEffort: "none", supportsImages: false, supportsTools: false,
  },
  {
    id: "thedrummer/cydonia-24b-v4.1", label: "Cydonia 24B v4.1",
    maxContext: 131072, maxCompletionTokens: 117964,
    supportedEfforts: [], defaultEffort: "none", supportsImages: false, supportsTools: false,
  },
];

let models = structuredClone(FALLBACK_OPENROUTER_MODELS);
export function openRouterModel(model: string): OpenRouterModelInfo {
  const info = models.find((candidate) => candidate.id === model);
  if (!info) throw new Error(`OpenRouter model is unavailable or unsupported: ${model}`);
  return info;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function parseOpenRouterModels(payload: unknown): OpenRouterModelInfo[] {
  const data = (payload as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) throw new Error("Invalid OpenRouter /models response");
  return FALLBACK_OPENROUTER_MODELS.flatMap((fallback) => {
    const entry = record(data.find((item) => record(item)?.id === fallback.id));
    if (!entry) return [];
    const parameters: string[] = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
    const reasoning = parameters.includes("reasoning");
    const modalities = record(entry.architecture)?.input_modalities;
    return [{ ...fallback,
      maxContext: positiveInteger(entry.context_length, fallback.maxContext),
      maxCompletionTokens: positiveInteger(record(entry.top_provider)?.max_completion_tokens, fallback.maxCompletionTokens),
      supportsTools: parameters.includes("tools"),
      supportsImages: Array.isArray(modalities) && modalities.includes("image"),
      supportedEfforts: reasoning ? fallback.supportedEfforts : [],
      defaultEffort: reasoning ? fallback.defaultEffort : "none" as const,
    }];
  });
}

export async function fetchOpenRouterModels(): Promise<ModelInfo[]> {
  // The model catalog is public; never use it to verify a secret API key.
  const response = await fetch(buildOpenRouterUrl(OPENROUTER_MODELS_PATH), { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`OpenRouter model fetch failed (${response.status})`);
  models = parseOpenRouterModels(await response.json());
  return structuredClone(models);
}
