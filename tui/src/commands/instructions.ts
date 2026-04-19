import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { showNoSystemInstructions } from "./shared";
import type { SlashCommand } from "./types";

export const INSTRUCTIONS_COMMAND: SlashCommand = {
  name: "/instructions",
  description: "Set, show, or clear per-conversation system instructions",
  args: [{ name: "clear", desc: "Clear instructions" }],
  handler: (text, state) => {
    const arg = text.slice("/instructions".length);
    const trimmed = arg.trimStart();
    if (!trimmed) {
      if (!state.convId) {
        return showNoSystemInstructions(state);
      }
      const instrMsg = state.messages.find((m): m is import("../messages").SystemInstructionsMessage => m.role === "system_instructions");
      if (instrMsg?.text.trim()) {
        pushSystemMessage(state, `Current instructions:\n${instrMsg.text}`);
        clearPrompt(state);
        return { type: "handled" };
      }
      return showNoSystemInstructions(state);
    }
    if (trimmed === "clear") {
      if (!state.convId) {
        return showNoSystemInstructions(state);
      }
      clearPrompt(state);
      return { type: "set_system_instructions", text: "" };
    }
    if (!state.convId) {
      clearPrompt(state);
      return { type: "create_conversation_for_instructions", text: trimmed };
    }
    clearPrompt(state);
    return { type: "set_system_instructions", text: trimmed };
  },
};
