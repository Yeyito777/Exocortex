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

function openAILoginInstruction(): string {
  return [
    "OpenAI login commands:",
    "  /login openai        Authenticate if no OpenAI account is connected",
    "  /login openai list   List connected OpenAI accounts",
    "  /login openai add    Connect another OpenAI account",
    "  /login openai switch <email-or-number>",
    "  /login openai remove <email-or-number>",
  ].join("\n");
}

const OPENAI_ACCOUNT_ACTIONS = [
  { name: "list", desc: "List connected OpenAI accounts" },
  { name: "add", desc: "Connect another OpenAI account" },
  { name: "switch", desc: "Switch the current OpenAI account" },
  { name: "remove", desc: "Remove a connected OpenAI account" },
] as const;

function openAIAccountRemovalItems(state: Parameters<NonNullable<SlashCommand["getArgs"]>>[0]) {
  const accounts = state.authInfoByProvider.openai.accounts ?? [];
  return accounts.map((account, index) => {
    const label = account.email?.trim() || account.displayName?.trim() || account.accountId?.trim() || String(index + 1);
    const plan = account.subscriptionType ? ` · ${account.subscriptionType}` : "";
    const current = account.current ? " · current" : "";
    return {
      name: label,
      desc: `OpenAI account #${index + 1}${plan}${current}`,
    };
  });
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
    "/login openai": [...OPENAI_ACCOUNT_ACTIONS],
    "/login openai remove": openAIAccountRemovalItems(state),
    "/login openai switch": openAIAccountRemovalItems(state),
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
    let action: "list" | "add" | "remove" | "switch" | undefined;
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
        if (arg !== "list" && arg !== "add" && arg !== "remove" && arg !== "switch") {
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

    if (!state.convId && action !== "list" && action !== "remove" && action !== "switch") {
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
