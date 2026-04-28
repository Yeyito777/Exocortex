import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { buildLoginInfoMessage } from "../logininfo";
import { setChosenProvider } from "../providerselection";
import { DEFAULT_PROVIDER_ORDER, type ProviderId } from "../messages";
import { availableProviders, defaultModelForProvider, normalizeStateEffort, providerCompletionItems, providerSupportsFastMode } from "./shared";
import type { SlashCommand } from "./types";

function loginDescription(provider: ProviderId): string {
  switch (provider) {
    case "openai": return "Sign in with OpenAI";
    case "anthropic": return "Sign in with Anthropic";
    case "deepseek": return "Save a DeepSeek API key";
  }
}

function deepSeekLoginInstruction(): string {
  return [
    "DeepSeek uses API-key login.",
    "1. Create or copy an API key at https://platform.deepseek.com/api_keys",
    "2. Run: /login deepseek <api-key>",
  ].join("\n");
}

export const LOGIN_COMMAND: SlashCommand = {
  name: "/login",
  description: "Show login status or authenticate with a provider",
  args: [...DEFAULT_PROVIDER_ORDER].map((provider) => ({
    name: provider,
    desc: loginDescription(provider),
  })),
  getArgs: (state) => ({
    "/login": providerCompletionItems(state),
  }),
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    const providers = availableProviders(state);

    if (parts.length > 3) {
      pushSystemMessage(state, `Usage: /login [${providers.join("|")}]${providers.includes("deepseek") ? " or /login deepseek <api-key>" : ""}`);
      clearPrompt(state);
      return { type: "handled" };
    }

    const provider = parts[1] as ProviderId | undefined;
    const apiKey = parts[2];
    if (!provider) {
      pushSystemMessage(state, buildLoginInfoMessage(state));
      clearPrompt(state);
      return { type: "handled" };
    }

    if (!providers.includes(provider)) {
      pushSystemMessage(state, `Unknown provider: ${provider}. Available: ${providers.join(", ")}`);
      clearPrompt(state);
      return { type: "handled" };
    }

    if (provider === "deepseek") {
      if (!apiKey) {
        pushSystemMessage(state, deepSeekLoginInstruction());
        clearPrompt(state);
        return { type: "handled" };
      }
    } else if (apiKey) {
      pushSystemMessage(state, `API-key login is only supported for DeepSeek. Use /login ${provider}.`);
      clearPrompt(state);
      return { type: "handled" };
    }

    if (!state.convId) {
      setChosenProvider(state, provider);
      const nextModel = defaultModelForProvider(state, provider) ?? state.model;
      state.model = nextModel;
      normalizeStateEffort(state, provider, nextModel);
      if (!providerSupportsFastMode(state, provider)) state.fastMode = false;
    }

    clearPrompt(state);
    return { type: "login", provider, ...(apiKey ? { apiKey } : {}) };
  },
};
