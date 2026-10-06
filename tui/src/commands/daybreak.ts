import { DAYBREAK_UNAVAILABLE, supportsDaybreak } from "@exocortex/shared/daybreak";
import { clearPrompt } from "../promptstate";
import { getModelInfo, isStreaming, pushSystemMessage } from "../state";
import type { SlashCommand } from "./types";

export const DAYBREAK_COMMAND: SlashCommand = {
  name: "/daybreak",
  description: "Toggle Daybreak Blue on Sol (account support required)",
  args: [
    { name: "on", desc: "Enable Daybreak Blue for this conversation" },
    { name: "off", desc: "Return to standard cyber access" },
  ],
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/);
    const arg = parts[1]?.toLowerCase();
    const enabled = arg === "off" ? false : arg === "on" ? true : !state.daybreak;
    if (parts.length > 2 || (arg && arg !== "on" && arg !== "off")) {
      pushSystemMessage(state, "Usage: /daybreak [on|off]");
    } else if (isStreaming(state)) {
      pushSystemMessage(state, "Cannot change Daybreak while streaming. It applies to the next turn.");
    } else if (enabled && !supportsDaybreak(state.provider, getModelInfo(state, state.provider, state.model))) {
      pushSystemMessage(state, DAYBREAK_UNAVAILABLE);
    } else {
      if (state.convId) {
        // The daemon may have a newer account catalog. Do not claim success
        // or alter the header until its authoritative summary arrives.
        clearPrompt(state);
        return { type: "daybreak_changed", enabled };
      }
      state.daybreak = enabled;
      pushSystemMessage(state, `Daybreak ${enabled ? "enabled" : "disabled"}.`);
      clearPrompt(state);
      return { type: "handled" };
    }
    clearPrompt(state);
    return { type: "handled" };
  },
};
