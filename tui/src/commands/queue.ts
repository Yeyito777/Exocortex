import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { queueTargetCompletionItems } from "../queuetargets";
import type { SlashCommand } from "./types";

export const QUEUE_COMMAND: SlashCommand = {
  name: "/queue",
  description: "Queue a message until global, conversation, or folder idle",
  getArgs: (state) => ({
    "/queue": queueTargetCompletionItems(state),
  }),
  handler: (_text, state) => {
    pushSystemMessage(state, "Usage: include /queue in a message to send it after all conversations and queued turns are idle. Use /queue <conversation-or-folder> to wait for one conversation, or a 📁 folder, instead.");
    clearPrompt(state);
    return { type: "handled" };
  },
};
