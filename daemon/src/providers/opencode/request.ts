import type { ApiMessage, EffortLevel, ModelId } from "../../messages";
import {
  buildOpenAICompatibleMessages,
  buildOpenAICompatibleRequestBody,
  type OpenAICompatibleRequestBody,
  type OpenAICompatibleRequestProfile,
} from "../openai-compatible/request";
import type { StreamOptions } from "../types";

function mapOpenCodeEffort(effort: EffortLevel | undefined) {
  switch (effort) {
    case "xhigh":
    case "max":
      return { thinking: { type: "enabled" as const }, reasoning_effort: "max" as const };
    case "high":
      return { thinking: { type: "enabled" as const }, reasoning_effort: "high" as const };
    case "none":
    case "minimal":
    case "low":
    case "medium":
      return { thinking: { type: "enabled" as const }, reasoning_effort: "low" as const };
    default:
      return { thinking: { type: "enabled" as const }, reasoning_effort: "high" as const };
  }
}

export const OPENCODE_REQUEST_PROFILE: OpenAICompatibleRequestProfile = {
  providerLabel: "OpenCode Zen",
  supportsImages: true,
  mapEffort: mapOpenCodeEffort,
};

export function buildOpenCodeMessages(messages: ApiMessage[], system?: string) {
  return buildOpenAICompatibleMessages(messages, system, OPENCODE_REQUEST_PROFILE);
}

export function buildRequestBody(messages: ApiMessage[], model: ModelId, options: StreamOptions): OpenAICompatibleRequestBody {
  return buildOpenAICompatibleRequestBody(messages, model, options, OPENCODE_REQUEST_PROFILE);
}
