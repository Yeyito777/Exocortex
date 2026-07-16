import { clearPrompt } from "../promptstate";
import { isStreaming, pushSystemMessage } from "../state";
import { conversationalMessages } from "./shared";
import type { SlashCommand } from "./types";

export const COMPACT_COMMAND: SlashCommand = {
  name: "/compact",
  description: "Compact the current conversation context",
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 1) {
      pushSystemMessage(state, "Usage: /compact");
      clearPrompt(state);
      return { type: "handled" };
    }
    if (!state.convId) {
      pushSystemMessage(state, "No active conversation to compact.");
      clearPrompt(state);
      return { type: "handled" };
    }
    if (isStreaming(state)) {
      pushSystemMessage(state, "Cannot compact the conversation while it is streaming.");
      clearPrompt(state);
      return { type: "handled" };
    }
    if (conversationalMessages(state).length === 0) {
      pushSystemMessage(state, "No conversation history to compact.");
      clearPrompt(state);
      return { type: "handled" };
    }
    clearPrompt(state);
    return { type: "compact_requested" };
  },
};
