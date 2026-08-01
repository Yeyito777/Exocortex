import { formatMicGainDb, loadMicGainDb, parseMicGainDb } from "../mic-gain";
import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { SlashCommand } from "./types";

export const MIC_COMMAND: SlashCommand = {
  name: "/mic",
  description: "Show or set local microphone gain",
  args: [{ name: "volume", desc: "Show or set microphone gain in dB" }],
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/u).filter(Boolean);
    if ((parts.length !== 2 && parts.length !== 3) || parts[1] !== "volume") {
      pushSystemMessage(state, "Usage: /mic volume [gain]");
      clearPrompt(state);
      return { type: "handled" };
    }
    if (parts.length === 2) {
      pushSystemMessage(state, `Microphone gain: ${formatMicGainDb(loadMicGainDb())}`);
      clearPrompt(state);
      return { type: "handled" };
    }
    const gainDb = parseMicGainDb(parts[2]);
    if (gainDb === null) {
      pushSystemMessage(state, "Usage: /mic volume [gain]");
      clearPrompt(state);
      return { type: "handled" };
    }
    clearPrompt(state);
    return { type: "mic_gain_changed", gainDb };
  },
};
