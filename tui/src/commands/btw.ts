import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { SlashCommand } from "./types";

export const BTW_COMMAND: SlashCommand = {
  name: "/btw",
  description: "Ask a read-only one-shot question using a snapshot of this conversation",
  handler: (text, state) => {
    const trimmed = text.trim();
    const remainder = trimmed.slice("/btw".length).trim();

    if (remainder === "close") {
      clearPrompt(state);
      if (!state.btw) {
        pushSystemMessage(state, "No /btw session is open.", "muted");
        return { type: "handled" };
      }
      return { type: "btw_close_requested" };
    }

    if (!remainder) {
      pushSystemMessage(state, "Usage: /btw <query>\n       /btw close");
      clearPrompt(state);
      return { type: "handled" };
    }
    if (!state.convId || state.folderInstructionsDoc) {
      pushSystemMessage(state, "Open a conversation before using /btw.", "warning");
      clearPrompt(state);
      return { type: "handled" };
    }

    clearPrompt(state);
    return { type: "btw_requested", query: remainder };
  },
};
