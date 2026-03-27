import type { ProviderId, ModelId, EffortLevel, ApiMessage, ApiContentBlock } from "./messages";
import {
  streamMessage as streamAnthropicMessage,
} from "./providers/anthropic/api";
import { streamMessage as streamOpenAIMessage } from "./providers/openai/api";
import type { ApiToolCall, ContentBlock, StreamResult, StreamCallbacks, StreamOptions } from "./providers/types";
import { AuthError } from "./providers/anthropic/auth";

export type { ApiMessage, ApiContentBlock };
export type { ApiToolCall, ContentBlock, StreamResult, StreamCallbacks, StreamOptions };
export { AuthError };

export async function streamMessage(
  provider: ProviderId,
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  switch (provider) {
    case "anthropic":
      return streamAnthropicMessage(messages, model, callbacks, options);
    case "openai":
      return streamOpenAIMessage(messages, model, callbacks, options);
    default:
      throw new Error(`API streaming is not implemented for provider: ${provider}`);
  }
}
