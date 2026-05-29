import type { EffortLevel, ModelId, ProviderId } from "../messages";
import { getDefaultProvider } from "../providers/registry";
import type { ServiceTier } from "../providers/types";
import type { ToolExecutionContext } from "./types";

export interface InnerLlmSummaryOptions {
  provider: ProviderId;
  model: ModelId;
  effort: EffortLevel;
  serviceTier?: ServiceTier;
  preferHttp?: boolean;
}

const SUMMARY_EFFORT: EffortLevel = "none";

const SUMMARY_MODEL_BY_PROVIDER: Record<ProviderId, ModelId> = {
  // The Codex ChatGPT-account backend rejects the literal "fast" model id.
  // Use the smallest accepted OpenAI model, then request the fast service tier.
  openai: "gpt-5.4-mini",
  deepseek: "deepseek-v4-flash",
};

const SUMMARY_SERVICE_TIER_BY_PROVIDER: Partial<Record<ProviderId, ServiceTier>> = {
  openai: "fast",
};

export function getInnerLlmSummaryOptions(context?: ToolExecutionContext): InnerLlmSummaryOptions {
  const provider = context?.provider ?? getDefaultProvider().id;
  return {
    provider,
    model: SUMMARY_MODEL_BY_PROVIDER[provider],
    effort: SUMMARY_EFFORT,
    preferHttp: provider === "openai",
    ...(SUMMARY_SERVICE_TIER_BY_PROVIDER[provider] ? { serviceTier: SUMMARY_SERVICE_TIER_BY_PROVIDER[provider] } : {}),
  };
}
