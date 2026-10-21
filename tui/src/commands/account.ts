import { clearPrompt } from "../promptstate";
import { autocompleteAccountLabel } from "../privacy";
import { pushSystemMessage } from "../state";
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

/** `/account claude …` and `/account anthropic …` manage Claude accounts. */
const CLAUDE_ALIASES = new Set(["claude", "anthropic"]);

const CLAUDE_ACTIONS = [
  { name: "add", desc: "Register another Claude account (its own Claude Code config dir)" },
  { name: "remove", desc: "Unregister a Claude account (its login is left as is)", exact: true },
] as const;

const CLAUDE_USAGE = "Usage: /account claude [add <name> [config-dir] | remove <name>]";

export const ACCOUNT_COMMAND: SlashCommand = {
  name: "/account",
  description: "List or switch OpenAI accounts; list, add or remove Claude accounts",
  getArgs: (state) => ({
    "/account": [
      { name: "claude", desc: "Claude accounts: status, usage, add/remove" },
      ...openAIAccountItems(state),
    ],
    "/account claude": [...CLAUDE_ACTIONS],
    "/account anthropic": [...CLAUDE_ACTIONS],
  }),
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);

    if (parts[1] && CLAUDE_ALIASES.has(parts[1].toLowerCase())) {
      clearPrompt(state);
      const action = parts[2]?.toLowerCase();
      if (!action) return { type: "account", provider: "anthropic" };
      if ((action !== "add" && action !== "remove") || !parts[3] || parts.length > (action === "add" ? 5 : 4)) {
        pushSystemMessage(state, CLAUDE_USAGE);
        return { type: "handled" };
      }
      return {
        type: "account",
        provider: "anthropic",
        action,
        target: parts[3],
        ...(action === "add" && parts[4] ? { configDir: parts[4] } : {}),
      };
    }

    if (parts.length > 2) {
      clearPrompt(state);
      return { type: "handled" };
    }

    const target = parts[1];
    clearPrompt(state);
    return { type: "account", provider: "openai", ...(target ? { target } : {}) };
  },
};
