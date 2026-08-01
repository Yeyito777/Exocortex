import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { SlashCommand } from "./types";

export const HANGUP_COMMAND: SlashCommand = {
  name: "/hangup",
  description: "End the realtime call in the current conversation",
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    clearPrompt(state);
    if (parts.length !== 1) {
      pushSystemMessage(state, "Usage: /hangup");
      return { type: "handled" };
    }
    if (!state.convId) {
      pushSystemMessage(state, "No conversation is open.");
      return { type: "handled" };
    }
    return { type: "hangup_requested" };
  },
};
