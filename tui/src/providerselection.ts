import { DEFAULT_PROVIDER_ORDER, type ProviderId } from "./messages";
import type { RenderState } from "./state";
import { savePreferredProvider } from "./preferences";

export function availableProviders(state: RenderState): ProviderId[] {
  const ids = state.providerRegistry.map((provider) => provider.id);
  return ids.length > 0 ? ids : [...DEFAULT_PROVIDER_ORDER];
}

export function loginPromptProviders(state: RenderState): ProviderId[] {
  const providers = availableProviders(state);
  if (providers.includes("openai") && providers.includes("anthropic")) {
    return ["openai", "anthropic"];
  }
  return providers;
}

export function setChosenProvider(state: RenderState, provider: ProviderId, persist = true): void {
  state.provider = provider;
  state.hasChosenProvider = true;
  if (persist) savePreferredProvider(provider);
}
