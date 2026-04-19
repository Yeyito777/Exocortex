import { clearPrompt } from "../promptstate";
import { isStreaming, pushSystemMessage } from "../state";
import { conversationalMessages } from "./shared";
import type { SlashCommand } from "./types";

export const REPLAY_COMMAND: SlashCommand = {
  name: "/replay",
  description: "Replay the current history so the AI can continue",
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 1) {
      pushSystemMessage(state, "Usage: /replay");
      clearPrompt(state);
      return { type: "handled" };
    }
    if (!state.convId) {
      pushSystemMessage(state, "No active conversation to replay.");
      clearPrompt(state);
      return { type: "handled" };
    }
    if (isStreaming(state)) {
      pushSystemMessage(state, "Cannot replay the conversation while it is streaming.");
      clearPrompt(state);
      return { type: "handled" };
    }
    if (conversationalMessages(state).length === 0) {
      pushSystemMessage(state, "No conversation history to replay.");
      clearPrompt(state);
      return { type: "handled" };
    }
    clearPrompt(state);
    return { type: "replay_requested" };
  },
};
