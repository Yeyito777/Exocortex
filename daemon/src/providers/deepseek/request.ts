import type { ApiMessage, EffortLevel, ModelId } from "../../messages";
import {
  buildOpenAICompatibleMessages,
  buildOpenAICompatibleRequestBody,
  type OpenAICompatibleMessage,
  type OpenAICompatibleRequestBody,
  type OpenAICompatibleRequestProfile,
} from "../openai-compatible/request";
import type { StreamOptions } from "../types";

export type DeepSeekChatMessage = OpenAICompatibleMessage;
export type DeepSeekRequestBody = OpenAICompatibleRequestBody;

function mapDeepSeekEffort(effort: EffortLevel | undefined) {
  switch (effort) {
    case "none":
      return { thinking: { type: "disabled" as const } };
    case "xhigh":
    case "max":
      return { thinking: { type: "enabled" as const }, reasoning_effort: "max" as const };
    case "minimal":
    case "low":
    case "medium":
    case "high":
    default:
      return { thinking: { type: "enabled" as const }, reasoning_effort: "high" as const };
  }
}

export const DEEPSEEK_REQUEST_PROFILE: OpenAICompatibleRequestProfile = {
  providerLabel: "DeepSeek",
  supportsImages: false,
  mapEffort: mapDeepSeekEffort,
};

export function buildDeepSeekMessages(messages: ApiMessage[], system?: string): DeepSeekChatMessage[] {
  return buildOpenAICompatibleMessages(messages, system, DEEPSEEK_REQUEST_PROFILE);
}

export function buildRequestBody(messages: ApiMessage[], model: ModelId, options: StreamOptions): DeepSeekRequestBody {
  return buildOpenAICompatibleRequestBody(messages, model, options, DEEPSEEK_REQUEST_PROFILE);
}
