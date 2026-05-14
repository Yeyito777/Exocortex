import { clearPrompt } from "../promptstate";
import { autocompleteAccountLabel } from "../privacy";
import type { SlashCommand } from "./types";

function openAIAccountItems(state: Parameters<NonNullable<SlashCommand["getArgs"]>>[0]) {
  const accounts = state.authInfoByProvider.openai.accounts ?? [];
  return accounts.map((account, index) => {
    const label = autocompleteAccountLabel(state, account, index);
    const plan = account.subscriptionType ? ` · ${account.subscriptionType}` : "";
    const current = account.current ? " · current" : "";
    return {
      name: label,
      desc: `OpenAI account${plan}${current}`,
    };
  });
}

export const ACCOUNT_COMMAND: SlashCommand = {
  name: "/account",
  description: "List or switch the active OpenAI account",
  getArgs: (state) => ({
    "/account": openAIAccountItems(state),
  }),
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 2) {
      clearPrompt(state);
      return { type: "handled" };
    }

    const target = parts[1];
    clearPrompt(state);
    return { type: "account", provider: "openai", ...(target ? { target } : {}) };
  },
};
