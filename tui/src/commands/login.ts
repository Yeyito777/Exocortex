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

function openAILoginInstruction(): string {
  return [
    "OpenAI login commands:",
    "  /login openai        Authenticate if no OpenAI account is connected",
    "  /login openai add    Connect another OpenAI account",
    "  /login openai remove <email>",
    "",
    "Use /account to list or switch OpenAI accounts.",
  ].join("\n");
}

const OPENAI_ACCOUNT_ACTIONS = [
  { name: "add", desc: "Connect another OpenAI account" },
  { name: "remove", desc: "Remove a connected OpenAI account" },
] as const;

export const LOGIN_COMMAND: SlashCommand = {
  name: "/login",
  description: "Show login status or authenticate with a provider",
  args: [...DEFAULT_PROVIDER_ORDER].map((provider) => ({
    name: provider,
    desc: loginDescription(provider),
  })),
  getArgs: (state) => ({
    "/login": providerCompletionItems(state),
    "/login openai": [...OPENAI_ACCOUNT_ACTIONS],
  }),
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    const providers = availableProviders(state);

    if (parts.length > 4) {
      pushSystemMessage(state, `Usage: /login [${providers.join("|")}]${providers.includes("deepseek") ? " or /login deepseek <api-key>" : ""}`);
      clearPrompt(state);
      return { type: "handled" };
    }

    const provider = parts[1] as ProviderId | undefined;
    const arg = parts[2];
    const extra = parts[3];
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

    let apiKey: string | undefined;
    let action: "add" | "remove" | undefined;
    let target: string | undefined;

    if (provider === "deepseek") {
      apiKey = arg;
      if (!apiKey) {
        pushSystemMessage(state, deepSeekLoginInstruction());
        clearPrompt(state);
        return { type: "handled" };
      }
      if (extra) {
        pushSystemMessage(state, "Usage: /login deepseek <api-key>");
        clearPrompt(state);
        return { type: "handled" };
      }
    } else if (provider === "openai") {
      if (arg) {
        if (arg !== "add" && arg !== "remove") {
          pushSystemMessage(state, openAILoginInstruction());
          clearPrompt(state);
          return { type: "handled" };
        }
        action = arg;
        target = extra;
      }
    } else if (arg) {
      pushSystemMessage(state, `Extra arguments are only supported for OpenAI account management and DeepSeek API-key login. Use /login ${provider}.`);
      clearPrompt(state);
      return { type: "handled" };
    }

    if (!state.convId && action !== "remove") {
      setChosenProvider(state, provider);
      const nextModel = defaultModelForProvider(state, provider) ?? state.model;
      state.model = nextModel;
      normalizeStateEffort(state, provider, nextModel);
      if (!providerSupportsFastMode(state, provider)) state.fastMode = false;
    }

    clearPrompt(state);
    return { type: "login", provider, ...(apiKey ? { apiKey } : {}), ...(action ? { action } : {}), ...(target ? { target } : {}) };
  },
};
