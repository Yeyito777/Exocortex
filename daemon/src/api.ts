import type { ProviderId, ModelId, EffortLevel, ApiMessage, ApiContentBlock } from "./messages";
import { getProviderAdapter } from "./providers/catalog";
import type { ApiToolCall, ContentBlock, ProviderTurnSession, StreamResult, StreamCallbacks, StreamOptions } from "./providers/types";
import { AuthError } from "./providers/errors";
import { recordTokenUsage } from "./token-stats";
import { recordModelRequestDiagnostics } from "./diagnostics";
import { PERFORMANCE_PROFILING_ENABLED } from "@exocortex/shared/performance-profiling";

export type { ApiMessage, ApiContentBlock };
export type { ApiToolCall, ContentBlock, ProviderTurnSession, StreamResult, StreamCallbacks, StreamOptions };
export { AuthError };

/** Daemon-only metadata stripped before options are passed to a provider. */
export interface StreamMessageOptions extends StreamOptions {
  /** Messages newly introduced since the preceding provider request. */
  diagnosticMessages?: ApiMessage[];
}

export function createProviderTurnSession(provider: ProviderId): ProviderTurnSession | null {
  return getProviderAdapter(provider).createTurnSession?.() ?? null;
}

export async function streamMessage(
  provider: ProviderId,
  messages: ApiMessage[],
  model: ModelId,
  callbacks: StreamCallbacks,
  options: StreamMessageOptions = {},
): Promise<StreamResult> {
  const { diagnosticMessages = [], ...providerOptions } = options;
  const result = await getProviderAdapter(provider).streamMessage(messages, model, callbacks, providerOptions);
  if (options.tracking) {
    recordTokenUsage(provider, model, {
      inputTokens: result.inputTokens,
      cachedInputTokens: result.cachedInputTokens,
      cacheMissInputTokens: result.cacheMissInputTokens,
      outputTokens: result.outputTokens,
      billingServiceTier: result.billingServiceTier,
    }, options.tracking, {
      serviceTier: options.serviceTier ?? "standard",
    });
  }
  if (PERFORMANCE_PROFILING_ENABLED) {
    recordModelRequestDiagnostics(provider, model, messages, result, options.tracking, diagnosticMessages, {
      serviceTier: options.serviceTier ?? "standard",
    });
  }
  return result;
}
