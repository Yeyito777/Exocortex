import type { ModelInfo, ReasoningEffortInfo } from "@exocortex/shared/messages";
import { formatModelDisplayName } from "@exocortex/shared/model-display";

const CLAUDE_CODE_EFFORTS: ReasoningEffortInfo[] = [
  { effort: "low", description: "Fastest responses." },
  { effort: "medium", description: "Balanced speed and reasoning depth." },
  { effort: "high", description: "Default reasoning depth." },
  { effort: "xhigh", description: "Deeper reasoning for harder tasks." },
  { effort: "max", description: "Maximum reasoning effort." },
];

function claudeModel(id: string): ModelInfo {
  return {
    id,
    label: formatModelDisplayName(id),
    maxContext: 1_000_000,
    supportedEfforts: CLAUDE_CODE_EFFORTS,
    defaultEffort: "high",
    supportsImages: true,
  };
}

export const FALLBACK_ANTHROPIC_MODELS: ModelInfo[] = [
  claudeModel("claude-opus-5-5"),
  claudeModel("claude-fable-5-1"),
  claudeModel("claude-sonnet-5-5"),
  claudeModel("claude-haiku-5-5"),
];

export async function fetchAnthropicModels(): Promise<ModelInfo[]> {
  return FALLBACK_ANTHROPIC_MODELS;
}
