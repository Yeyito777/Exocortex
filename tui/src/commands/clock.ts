import { saveClockPreference } from "../clock";
import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { SlashCommand } from "./types";

export const CLOCK_COMMAND: SlashCommand = {
  name: "/clock",
  description: "Show or set the 12h/24h clock for message finish times (saved locally)",
  args: [
    { name: "12h", desc: "Finish times like 2:03pm (default)" },
    { name: "24h", desc: "Finish times like 14:03" },
  ],
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/);
    const arg = parts[1]?.toLowerCase();
    if (parts.length > 2 || (arg !== undefined && arg !== "12h" && arg !== "24h")) {
      pushSystemMessage(state, "Usage: /clock [12h|24h]");
    } else if (arg === undefined) {
      pushSystemMessage(state, `Clock: ${state.clock}.`);
    } else {
      saveClockPreference(arg);
      state.clock = arg;
      pushSystemMessage(state, `Clock set to ${arg}.`);
    }
    clearPrompt(state);
    return { type: "handled" };
  },
};
