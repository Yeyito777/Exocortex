import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { SlashCommand } from "./types";
import { REALTIME_VOICES, isRealtimeVoice } from "@exocortex/shared/realtime";

export const CALL_COMMAND: SlashCommand = {
  name: "/call",
  description: "Start a realtime call; optionally choose and remember its voice",
  args: REALTIME_VOICES.map(voice => ({ name: voice, desc: `Use the ${voice} voice` })),
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 2) {
      pushSystemMessage(state, "Usage: /call [voice]");
      clearPrompt(state);
      return { type: "handled" };
    }
    const requestedVoice = parts[1]?.toLowerCase();
    if (requestedVoice && !isRealtimeVoice(requestedVoice)) {
      pushSystemMessage(state, `Unknown call voice: ${parts[1]}. Supported voices: ${REALTIME_VOICES.join(", ")}.`);
      clearPrompt(state);
      return { type: "handled" };
    }
    const voice = requestedVoice && isRealtimeVoice(requestedVoice) ? requestedVoice : undefined;
    clearPrompt(state);
    return { type: "call_requested", ...(voice ? { voice } : {}) };
  },
};
