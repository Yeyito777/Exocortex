import type { ModelId, ProviderId } from "../messages";
import { getDefaultProvider } from "../providers/registry";
import type { ToolExecutionContext } from "./types";

export interface InnerLlmSummaryOptions {
  provider: ProviderId;
  model: ModelId;
}

const SUMMARY_MODEL_BY_PROVIDER: Record<ProviderId, ModelId> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4-mini",
};

export function getInnerLlmSummaryOptions(context?: ToolExecutionContext): InnerLlmSummaryOptions {
  const provider = context?.provider ?? getDefaultProvider().id;
  return {
    provider,
    model: SUMMARY_MODEL_BY_PROVIDER[provider],
  };
}
