import { clearPrompt } from "../promptstate";
import type { SlashCommand } from "./types";

/** `/accounts` opens the Accounts screen (also `g a` in normal mode); with one account it explains how to add one. */
export const ACCOUNTS_COMMAND: SlashCommand = {
  name: "/accounts",
  description: "Show every Claude and OpenAI account: sign-in, usage, conversations (g a)",
  handler: (_text, state) => {
    clearPrompt(state);
    return { type: "open_accounts" };
  },
};
