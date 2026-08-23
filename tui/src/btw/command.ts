import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { SlashCommand } from "../commands/types";

export const BTW_COMMAND: SlashCommand = {
  name: "/btw",
  description: "Ask a read-only aside, or follow up in its open panel",
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
    if (state.btw && (state.btw.phase === "starting" || state.btw.phase === "running")) {
      pushSystemMessage(state, "Wait for the current /btw answer before asking a follow-up.", "muted");
      clearPrompt(state);
      return { type: "handled" };
    }

    clearPrompt(state);
    return { type: "btw_requested", query: remainder };
  },
};
