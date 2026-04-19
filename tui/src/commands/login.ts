import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { buildLoginInfoMessage } from "../logininfo";
import { setChosenProvider } from "../providerselection";
import { DEFAULT_PROVIDER_ORDER } from "../messages";
import { defaultModelForProvider, normalizeStateEffort, providerCompletionItems, providerSupportsFastMode } from "./shared";
import { parseOptionalProviderCommand } from "./auth-shared";
import type { SlashCommand } from "./types";

export const LOGIN_COMMAND: SlashCommand = {
  name: "/login",
  description: "Show login status or authenticate with a provider",
  args: [...DEFAULT_PROVIDER_ORDER].map((provider) => ({
    name: provider,
    desc: provider === "openai" ? "Sign in with OpenAI" : "Sign in with Anthropic",
  })),
  getArgs: (state) => ({
    "/login": providerCompletionItems(state),
  }),
  handler: (text, state) => {
    const parsed = parseOptionalProviderCommand(text, state, "/login");
    if (!parsed.ok) return parsed.result;

    const { provider } = parsed;
    if (!provider) {
      pushSystemMessage(state, buildLoginInfoMessage(state));
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
    return { type: "login", provider };
  },
};
