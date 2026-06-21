import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { SlashCommand } from "./types";

export const QUEUE_COMMAND: SlashCommand = {
  name: "/queue",
  description: "Queue a message until all TUI conversations are idle",
  handler: (_text, state) => {
    pushSystemMessage(state, "Usage: include /queue in a message to send it after all TUI conversations and queued turns are idle.");
    clearPrompt(state);
    return { type: "handled" };
  },
};
