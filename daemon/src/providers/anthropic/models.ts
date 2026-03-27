import type { EffortLevel, ModelInfo, ReasoningEffortInfo } from "@exocortex/shared/messages";
import { log } from "../../log";
import { getVerifiedAccessToken } from "./auth";
import { ANTHROPIC_BASE_URL } from "./constants";

const FIXED_ANTHROPIC_EFFORT: ReasoningEffortInfo[] = [
  { effort: "high", description: "This model uses Anthropic's fixed default reasoning effort." },
];

const OPUS_ANTHROPIC_EFFORTS: ReasoningEffortInfo[] = [
  { effort: "low", description: "Lower effort for faster responses." },
  { effort: "medium", description: "Balanced speed and reasoning depth." },
  { effort: "high", description: "Higher reasoning depth for harder tasks." },
  { effort: "max", description: "Maximum Anthropic effort for the deepest reasoning." },
];

function anthropicEffortMetadata(modelId: string): { supportedEfforts: ReasoningEffortInfo[]; defaultEffort: EffortLevel } {
  if (modelId === "claude-opus-4-6" || modelId === "opus") {
    return { supportedEfforts: OPUS_ANTHROPIC_EFFORTS, defaultEffort: "high" };
  }
  return { supportedEfforts: FIXED_ANTHROPIC_EFFORT, defaultEffort: "high" };
}

export const FALLBACK_ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-6", label: "claude-opus-4-6", maxContext: 1_000_000, ...anthropicEffortMetadata("claude-opus-4-6") },
  { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6", maxContext: 1_000_000, ...anthropicEffortMetadata("claude-sonnet-4-6") },
  { id: "claude-haiku-4-5-20251001", label: "claude-haiku-4-5-20251001", maxContext: 1_000_000, ...anthropicEffortMetadata("claude-haiku-4-5-20251001") },
];

interface AnthropicModelResponse {
  data?: Array<{
    id: string;
    display_name?: string;
    max_input_tokens?: number;
  }>;
}

export async function fetchAnthropicModels(): Promise<ModelInfo[]> {
  const accessToken = await getVerifiedAccessToken();
  const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/models`, {
    headers: {
      "x-api-key": accessToken,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic model fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = await res.json() as AnthropicModelResponse;
  const models = (data.data ?? [])
    .filter((model) => typeof model.id === "string" && model.id.startsWith("claude-"))
    .map((model) => ({
      id: model.id,
      label: model.display_name?.trim() || model.id,
      maxContext: model.max_input_tokens ?? 1_000_000,
      ...anthropicEffortMetadata(model.id),
    }));

  if (models.length === 0) {
    log("warn", "anthropic models: API returned no usable models, keeping fallback list");
    return FALLBACK_ANTHROPIC_MODELS;
  }

  return models;
}
