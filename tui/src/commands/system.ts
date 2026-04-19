import { clearPrompt } from "../promptstate";
import type { SlashCommand } from "./types";

export const SYSTEM_COMMAND: SlashCommand = {
  name: "/system",
  description: "Show the current system prompt",
  handler: (_text, state) => {
    clearPrompt(state);
    return { type: "get_system_prompt" };
  },
};
