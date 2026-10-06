import { DEFAULT_PROVIDER_ORDER, type ProviderId } from "./messages";
import type { RenderState } from "./state";

export function availableProviders(state: RenderState): ProviderId[] {
  const ids = state.providerRegistry.map((provider) => provider.id);
  return ids.length > 0 ? ids : [...DEFAULT_PROVIDER_ORDER];
}

export function loginPromptProviders(state: RenderState): ProviderId[] {
  return availableProviders(state);
}

/** A provider selection is conversation/draft state, not a locally saved default. */
export function setChosenProvider(state: RenderState, provider: ProviderId): void {
  state.provider = provider;
  state.hasChosenProvider = true;
}

/** Sync the active provider from daemon state. */
export function syncChosenProvider(state: RenderState, provider: ProviderId): void {
  setChosenProvider(state, provider);
}
