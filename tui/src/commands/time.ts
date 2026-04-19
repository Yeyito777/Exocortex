import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { formatTimestamp } from "../time";
import { conversationalMessages, parseNonNegativeInt } from "./shared";
import type { SlashCommand } from "./types";

export const TIME_COMMAND: SlashCommand = {
  name: "/time",
  description: "Show the timestamp of the last chat message",
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 2) {
      pushSystemMessage(state, "Usage: /time [n]");
      clearPrompt(state);
      return { type: "handled" };
    }

    const offset = parts.length === 2 ? parseNonNegativeInt(parts[1]) : 0;
    if (parts.length === 2 && offset === null) {
      pushSystemMessage(state, "Usage: /time [n]\n\nn must be a non-negative integer starting at 0.");
      clearPrompt(state);
      return { type: "handled" };
    }

    const history = conversationalMessages(state);
    if (history.length === 0) {
      pushSystemMessage(state, "No chat messages yet.");
      clearPrompt(state);
      return { type: "handled" };
    }

    const indexFromEnd = offset ?? 0;
    if (indexFromEnd >= history.length) {
      pushSystemMessage(state, `Only ${history.length} chat message${history.length === 1 ? "" : "s"} available.`);
      clearPrompt(state);
      return { type: "handled" };
    }

    const target = history[history.length - 1 - indexFromEnd];
    const timestamp = target.metadata?.startedAt;
    if (typeof timestamp !== "number") {
      pushSystemMessage(state, "No timestamp available for that message.");
      clearPrompt(state);
      return { type: "handled" };
    }

    pushSystemMessage(state, formatTimestamp(timestamp));
    clearPrompt(state);
    return { type: "handled" };
  },
};
