import { DEFAULT_PROVIDER_ORDER, type ProviderId } from "./messages";
import type { RenderState } from "./state";
import { savePreferredProvider } from "./preferences";

export function availableProviders(state: RenderState): ProviderId[] {
  const ids = state.providerRegistry.map((provider) => provider.id);
  return ids.length > 0 ? ids : [...DEFAULT_PROVIDER_ORDER];
}

export function loginPromptProviders(state: RenderState): ProviderId[] {
  return availableProviders(state);
}

export function setChosenProvider(state: RenderState, provider: ProviderId, persist = true): void {
  state.provider = provider;
  state.hasChosenProvider = true;
  if (persist) savePreferredProvider(provider);
}

/** Sync the active provider from daemon state without overwriting the user's saved default. */
export function syncChosenProvider(state: RenderState, provider: ProviderId): void {
  setChosenProvider(state, provider, false);
}
