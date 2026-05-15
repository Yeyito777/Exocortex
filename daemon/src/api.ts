import type { ProviderId, ModelId, EffortLevel, ApiMessage, ApiContentBlock } from "./messages";
import { getProviderAdapter } from "./providers/catalog";
import type { ApiToolCall, ContentBlock, ProviderTurnSession, StreamResult, StreamCallbacks, StreamOptions } from "./providers/types";
import { AuthError } from "./providers/errors";
import { recordTokenUsage } from "./token-stats";

export type { ApiMessage, ApiContentBlock };
export type { ApiToolCall, ContentBlock, ProviderTurnSession, StreamResult, StreamCallbacks, StreamOptions };
export { AuthError };

export function createProviderTurnSession(provider: ProviderId): ProviderTurnSession | null {
  return getProviderAdapter(provider).createTurnSession?.() ?? null;
}

export async function streamMessage(
  provider: ProviderId,
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamOptions = {},
): Promise<StreamResult> {
  const result = await getProviderAdapter(provider).streamMessage(messages, model, callbacks, options);
  if (options.tracking) {
    recordTokenUsage(provider, model, {
      inputTokens: result.inputTokens,
      cachedInputTokens: result.cachedInputTokens,
      outputTokens: result.outputTokens,
    }, options.tracking);
  }
  return result;
}
