import type { ModelId } from "@exocortex/shared/messages";

interface OpenAIModelCapabilityOverride {
  supportsReasoningSummary?: boolean;
  supportsImages?: boolean;
}

// Model-level wire quirks verified against the Codex Responses endpoint.
// Keep these here so request building and UI metadata stay in sync.
const OPENAI_MODEL_CAPABILITY_OVERRIDES = new Map<ModelId, OpenAIModelCapabilityOverride>([
  ["gpt-5.3-codex-spark", {
    supportsReasoningSummary: false,
    supportsImages: false,
  }],
]);

function openAIModelCapabilityOverride(model: ModelId): OpenAIModelCapabilityOverride | undefined {
  return OPENAI_MODEL_CAPABILITY_OVERRIDES.get(model);
}

export function supportsOpenAIReasoningSummary(model: ModelId): boolean {
  return openAIModelCapabilityOverride(model)?.supportsReasoningSummary ?? true;
}

export function supportsOpenAIImageInputs(model: ModelId): boolean {
  return openAIModelCapabilityOverride(model)?.supportsImages ?? true;
}
