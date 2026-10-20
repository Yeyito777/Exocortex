import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { SlashCommand } from "./types";

export const INSTRUCTIONS_COMMAND: SlashCommand = {
  name: "/instructions",
  description: "View and edit conversation, folder or global instructions; with text, set this conversation's",
  args: [{ name: "clear", desc: "Clear this conversation's instructions" }],
  handler: (text, state) => {
    const trimmed = text.slice("/instructions".length).trim();
    clearPrompt(state);
    if (!trimmed) return { type: "open_instructions" };
    if (trimmed === "clear") {
      if (!state.convId) {
        pushSystemMessage(state, "This conversation has no instructions to clear yet.");
        return { type: "handled" };
      }
      pushSystemMessage(state, "Conversation instructions cleared.");
      return { type: "set_system_instructions", text: "" };
    }
    if (!state.convId) return { type: "create_conversation_for_instructions", text: trimmed };
    pushSystemMessage(state, "Conversation instructions set. /instructions shows them.");
    return { type: "set_system_instructions", text: trimmed };
  },
};
