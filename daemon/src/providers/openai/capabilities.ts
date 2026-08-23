import type { ModelId } from "@exocortex/shared/messages";

interface OpenAIModelCapabilityOverride {
  supportsReasoningSummary?: boolean;
  supportsImages?: boolean;
  supportsMaxReasoningEffort?: boolean;
  supportsUltraReasoningEffort?: boolean;
  usesResponsesLite?: boolean;
  supportsFastServiceTier?: boolean;
  defaultVerbosity?: "low" | "medium" | "high";
}

// Model-level wire quirks verified against the Codex Responses endpoint.
// Keep these here so request building and UI metadata stay in sync.
const OPENAI_MODEL_CAPABILITY_OVERRIDES = new Map<ModelId, OpenAIModelCapabilityOverride>([
  ["gpt-5.6-sol", {
    supportsUltraReasoningEffort: true,
  }],
  ["gpt-5.6-terra", {
    supportsUltraReasoningEffort: true,
  }],
  ["gpt-5.3-codex-spark", {
    supportsReasoningSummary: false,
    supportsImages: false,
  }],
  ["gpt-daybreak-blue-latest", {
    supportsMaxReasoningEffort: true,
    supportsUltraReasoningEffort: true,
    usesResponsesLite: true,
    supportsFastServiceTier: false,
    defaultVerbosity: "low",
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

export function supportsOpenAIMaxReasoningEffort(model: ModelId): boolean {
  return /^gpt-5\.6-/.test(model)
    || openAIModelCapabilityOverride(model)?.supportsMaxReasoningEffort === true;
}

export function usesOpenAIResponsesLite(model: ModelId): boolean {
  return openAIModelCapabilityOverride(model)?.usesResponsesLite === true;
}

export function supportsOpenAIUltraReasoningEffort(model: ModelId): boolean {
  return openAIModelCapabilityOverride(model)?.supportsUltraReasoningEffort === true;
}

export function supportsOpenAIFastServiceTier(model: ModelId): boolean {
  return openAIModelCapabilityOverride(model)?.supportsFastServiceTier ?? true;
}

export function defaultOpenAIVerbosity(model: ModelId): "low" | "medium" | "high" | undefined {
  return openAIModelCapabilityOverride(model)?.defaultVerbosity;
}
