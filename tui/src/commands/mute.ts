import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { SlashCommand } from "./types";

export const MUTE_COMMAND: SlashCommand = {
  name: "/mute",
  description: "Toggle the local microphone for the current realtime call",
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/u).filter(Boolean);
    clearPrompt(state);
    if (parts.length !== 1) {
      pushSystemMessage(state, "Usage: /mute");
      return { type: "handled" };
    }
    if (!state.convId) {
      pushSystemMessage(state, "No conversation is open.");
      return { type: "handled" };
    }
    return { type: "mute_requested" };
  },
};
