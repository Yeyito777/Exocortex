import { clearPendingAI, clearStreamingTailMessages, resetNewConversationDefaults } from "../state";
import { clearPrompt } from "../promptstate";
import type { SlashCommand } from "./types";

export const NEW_COMMAND: SlashCommand = {
  name: "/new",
  description: "Start a new conversation",
  handler: (_text, state) => {
    state.messages = [];
    clearPendingAI(state);
    clearStreamingTailMessages(state);
    clearPrompt(state);
    state.scrollOffset = 0;
    state.contextTokens = 0;
    resetNewConversationDefaults(state);
    return { type: "new_conversation" };
  },
};
