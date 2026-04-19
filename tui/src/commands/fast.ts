import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { providerSupportsFastMode } from "./shared";
import type { SlashCommand } from "./types";

export const FAST_COMMAND: SlashCommand = {
  name: "/fast",
  description: "Toggle or set OpenAI fast mode",
  args: [
    { name: "on", desc: "Enable fast mode for this conversation" },
    { name: "off", desc: "Disable fast mode for this conversation" },
  ],
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    const arg = parts[1]?.toLowerCase();
    const supportsFast = providerSupportsFastMode(state);
    const providerLabel = state.provider;

    if (parts.length > 2 || (arg && !["on", "off"].includes(arg))) {
      pushSystemMessage(state, "Usage: /fast [on|off]");
      clearPrompt(state);
      return { type: "handled" };
    }

    if (!supportsFast) {
      pushSystemMessage(state, `Fast mode is only available for ${providerLabel} conversations that support it.`);
      clearPrompt(state);
      return { type: "handled" };
    }

    const enabled = arg ? arg === "on" : !state.fastMode;
    if (enabled === state.fastMode) {
      pushSystemMessage(state, `Fast mode already ${enabled ? "on" : "off"}.`);
      clearPrompt(state);
      return { type: "handled" };
    }

    state.fastMode = enabled;
    pushSystemMessage(state, `Fast mode ${enabled ? "enabled" : "disabled"}.`);
    clearPrompt(state);
    return state.convId ? { type: "fast_mode_changed", enabled } : { type: "handled" };
  },
};
