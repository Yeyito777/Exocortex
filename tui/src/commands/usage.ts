import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { SlashCommand } from "./types";

const USAGE = "Usage: /usage reset";

export const USAGE_COMMAND: SlashCommand = {
  name: "/usage",
  description: "Use an earned OpenAI usage-limit reset",
  args: [{ name: "reset", desc: "Reset the current 5-hour and weekly usage limits" }],
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 2 || parts[1]?.toLowerCase() !== "reset") {
      pushSystemMessage(state, USAGE);
      clearPrompt(state);
      return { type: "handled" };
    }
    if (state.provider !== "openai") {
      pushSystemMessage(state, "Usage resets are only supported for OpenAI.");
      clearPrompt(state);
      return { type: "handled" };
    }
    if (!state.authByProvider.openai) {
      pushSystemMessage(state, "OpenAI is not authenticated. Run /login openai first.");
      clearPrompt(state);
      return { type: "handled" };
    }

    clearPrompt(state);
    return { type: "usage_reset_requested", provider: "openai" };
  },
};
