import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { SlashCommand } from "./types";

export const CALL_COMMAND: SlashCommand = {
  name: "/call",
  description: "Start a realtime voice call using this TUI's microphone and speakers",
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 1) {
      pushSystemMessage(state, "Usage: /call");
      clearPrompt(state);
      return { type: "handled" };
    }
    clearPrompt(state);
    return { type: "call_requested" };
  },
};
