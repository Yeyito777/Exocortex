import { clearPrompt } from "../promptstate";
import { isStreaming, pushSystemMessage } from "../state";
import { DEFAULT_EFFORT, DEFAULT_PROVIDER_ORDER, type ModelId, type ProviderId } from "../messages";
import {
  applyProviderModelSelection,
  availableProviders,
  defaultModelForProvider,
  effortItems,
  formatProviderModels,
  providerAllowsCustomModels,
  providerModels,
} from "./shared";
import type { SlashCommand } from "./types";

export const MODEL_COMMAND: SlashCommand = {
  name: "/model",
  description: "Set or show the current provider/model",
  args: [...DEFAULT_PROVIDER_ORDER].map((provider) => ({
    name: provider,
    desc: provider === "openai" ? "OpenAI models" : "Anthropic models",
  })),
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    const providers = availableProviders(state);

    if (parts.length === 1) {
      pushSystemMessage(state, `Current: ${state.provider}/${state.model}\nAvailable:\n${providers.map((provider) => formatProviderModels(state, provider)).join("\n")}\nUsage: /model <provider> <model>`);
      clearPrompt(state);
      return { type: "handled" };
    }

    if (parts.length > 3) {
      pushSystemMessage(state, "Usage: /model <provider> <model>");
      clearPrompt(state);
      return { type: "handled" };
    }

    const provider = parts[1] as ProviderId;
    if (!providers.includes(provider)) {
      pushSystemMessage(state, `Unknown provider: ${parts[1]}. Available: ${providers.join(", ")}`);
      clearPrompt(state);
      return { type: "handled" };
    }

    if (parts.length === 2) {
      const currentModel = provider === state.provider ? state.model : defaultModelForProvider(state, provider) ?? "(unknown)";
      const efforts = effortItems(state, provider, currentModel);
      pushSystemMessage(state, `Current: ${currentModel}\nAvailable: ${providerModels(state, provider).join(", ") || "(waiting for daemon)"}\nEffort: ${efforts.map((item) => item.name).join(", ") || DEFAULT_EFFORT}${providerAllowsCustomModels(state, provider) ? "\nThis provider also accepts custom model ids." : ""}`);
      clearPrompt(state);
      return { type: "handled" };
    }

    if (state.convId && isStreaming(state)) {
      pushSystemMessage(state, "Cannot switch provider/model while this conversation is streaming.");
      clearPrompt(state);
      return { type: "handled" };
    }

    const model = parts[2] as ModelId;
    const selection = applyProviderModelSelection(state, provider, model);

    const effortSuffix = selection.effortChanged ? ` (effort ${state.effort})` : "";
    const fastSuffix = selection.fastDisabled ? " (fast off)" : "";
    pushSystemMessage(state, `Model set to ${state.provider}/${state.model}${effortSuffix}${fastSuffix}`);

    if (selection.contextWarning) {
      pushSystemMessage(state, selection.contextWarning, "warning");
    }

    clearPrompt(state);
    return state.convId ? { type: "model_changed", provider, model } : { type: "handled" };
  },
};
