import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { queueTargetCompletionItems } from "../queuetargets";
import type { SlashCommand } from "./types";

export const QUEUE_COMMAND: SlashCommand = {
  name: "/queue",
  description: "Queue a message or compatible command until the selected scope is idle or a delay passes",
  getArgs: (state) => ({
    "/queue": queueTargetCompletionItems(state),
  }),
  handler: (_text, state) => {
    pushSystemMessage(state, "Usage: include /queue in a message, or combine it with a compatible command such as /replay or /compact, to run after all conversations and queued turns are idle. Use /queue <conversation-or-folder> to wait for one conversation, or a 📁 folder, instead, or /queue <duration> (such as 30s, 5h, 8h3m1s, or 9d) to send after that delay once this conversation is idle.");
    clearPrompt(state);
    return { type: "handled" };
  },
};
