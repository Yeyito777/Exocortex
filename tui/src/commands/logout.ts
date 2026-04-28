import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { DEFAULT_PROVIDER_ORDER, type ProviderId } from "../messages";
import { providerCompletionItems } from "./shared";
import { parseOptionalProviderCommand } from "./auth-shared";
import type { SlashCommand } from "./types";

function logoutDescription(provider: ProviderId): string {
  switch (provider) {
    case "openai": return "Log out from OpenAI";
    case "anthropic": return "Log out from Anthropic";
    case "deepseek": return "Forget the saved DeepSeek API key";
  }
}

export const LOGOUT_COMMAND: SlashCommand = {
  name: "/logout",
  description: "Log out and clear credentials for a provider",
  args: [...DEFAULT_PROVIDER_ORDER].map((provider) => ({
    name: provider,
    desc: logoutDescription(provider),
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
