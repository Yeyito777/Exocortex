import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID, normalizeEffortForModel } from "../messages";
import { syncChosenProvider } from "../providerselection";
import type { Event } from "../protocol";
import type { RenderState } from "../state";

export function fallbackProvider(state: RenderState): RenderState["provider"] {
  return state.providerRegistry[0]?.id ?? state.provider ?? DEFAULT_PROVIDER_ID;
}

export function syncModelEffortSelection(state: RenderState): void {
  const provider = state.providerRegistry.find((candidate) => candidate.id === state.provider);
  const model = provider?.models.find((candidate) => candidate.id === state.model) ?? null;
  state.effort = normalizeEffortForModel(model, state.effort);
  if (provider && !provider.supportsFastMode) state.fastMode = false;
}

export function handleToolsAvailable(event: Extract<Event, { type: "tools_available" }>, state: RenderState): void {
  if (Array.isArray(event.providers)) {
    state.providerRegistry = event.providers;
  }
  state.toolRegistry = Array.isArray(event.tools) ? event.tools : [];
  if (event.authByProvider) {
    state.authByProvider = event.authByProvider;
  }
  if (event.authInfoByProvider) {
    state.authInfoByProvider = event.authInfoByProvider;
  }
  state.externalToolStyles = event.externalToolStyles ?? [];
  const registry = state.providerRegistry ?? [];

  let provider = registry.find((p) => p.id === state.provider) ?? null;
  if (!state.hasChosenProvider) {
    const authenticated = registry.filter((candidate) => state.authByProvider[candidate.id]);
    if (authenticated.length === 1) {
      provider = authenticated[0];
      syncChosenProvider(state, provider.id);
      state.model = provider.defaultModel ?? DEFAULT_MODEL_BY_PROVIDER[provider.id];
    }
  }

  if (provider && state.hasChosenProvider) {
    const allowsCustomModels = provider.allowsCustomModels;
    if (!provider.models.some((m) => m.id === state.model) && !allowsCustomModels) {
      state.model = provider.defaultModel;
    }
    syncModelEffortSelection(state);
  }
}
