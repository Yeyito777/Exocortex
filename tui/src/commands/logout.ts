import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { DEFAULT_PROVIDER_ORDER } from "../messages";
import { providerCompletionItems } from "./shared";
import { parseOptionalProviderCommand } from "./auth-shared";
import type { SlashCommand } from "./types";

export const LOGOUT_COMMAND: SlashCommand = {
  name: "/logout",
  description: "Log out and clear credentials for a provider",
  args: [...DEFAULT_PROVIDER_ORDER].map((provider) => ({
    name: provider,
    desc: provider === "openai" ? "Log out from OpenAI" : "Log out from Anthropic",
  })),
  getArgs: (state) => ({
    "/logout": providerCompletionItems(state),
  }),
  handler: (text, state) => {
    const parsed = parseOptionalProviderCommand(text, state, "/logout");
    if (!parsed.ok) return parsed.result;

    const { provider, providers } = parsed;
    if (!provider) {
      pushSystemMessage(state, `Choose a provider first: ${providers.map((candidate) => `/logout ${candidate}`).join(" or ")}`);
      clearPrompt(state);
      return { type: "handled" };
    }

    clearPrompt(state);
    return { type: "logout", provider };
  },
};
