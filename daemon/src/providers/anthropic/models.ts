import { type EffortLevel, type ModelInfo, type ReasoningEffortInfo } from "@exocortex/shared/messages";
import { formatModelDisplayName } from "@exocortex/shared/model-display";
import { loadProviderAuth } from "../../store";
import type { StoredAnthropicAuth } from "./types";

const FIXED_ANTHROPIC_EFFORT: ReasoningEffortInfo[] = [
  { effort: "high", description: "This model uses Claude Code's default reasoning effort." },
];

const OPUS_ANTHROPIC_EFFORTS: ReasoningEffortInfo[] = [
  { effort: "low", description: "Lower effort for faster responses." },
  { effort: "medium", description: "Balanced speed and reasoning depth." },
  { effort: "high", description: "Higher reasoning depth for harder tasks." },
  { effort: "max", description: "Maximum Claude Code effort for the deepest reasoning." },
];

function anthropicEffortMetadata(modelId: string): { supportedEfforts: ReasoningEffortInfo[]; defaultEffort: EffortLevel } {
  if (modelId === "claude-opus-4-6" || modelId === "opus") {
    return { supportedEfforts: OPUS_ANTHROPIC_EFFORTS, defaultEffort: "high" };
  }
  return { supportedEfforts: FIXED_ANTHROPIC_EFFORT, defaultEffort: "high" };
}

export const FALLBACK_ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-6", label: formatModelDisplayName("claude-opus-4-6"), maxContext: 1_000_000, ...anthropicEffortMetadata("claude-opus-4-6") },
  { id: "claude-sonnet-4-6", label: formatModelDisplayName("claude-sonnet-4-6"), maxContext: 1_000_000, ...anthropicEffortMetadata("claude-sonnet-4-6") },
  { id: "claude-haiku-4-5-20251001", label: formatModelDisplayName("claude-haiku-4-5-20251001"), maxContext: 1_000_000, ...anthropicEffortMetadata("claude-haiku-4-5-20251001") },
];

function storedSubscriptionType(): string | null {
  return loadProviderAuth<StoredAnthropicAuth>("anthropic")?.cli.subscriptionType ?? null;
}

function filterModelsForSubscription(models: ModelInfo[], subscriptionType: string | null): ModelInfo[] {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "") ?? null;
  if (!normalized) return models;
  if (normalized.includes("max") || normalized.includes("team") || normalized.includes("enterprise")) {
    return models;
  }
  if (normalized.includes("pro")) {
    return models.filter((model) => model.id !== "claude-opus-4-6");
  }
  return models.filter((model) => model.id.includes("haiku") || model.id.includes("sonnet"));
}

export async function fetchAnthropicModels(): Promise<ModelInfo[]> {
  return filterModelsForSubscription(FALLBACK_ANTHROPIC_MODELS, storedSubscriptionType());
}
