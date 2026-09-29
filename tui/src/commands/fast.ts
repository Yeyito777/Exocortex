import type { FastMode } from "@exocortex/shared/messages";
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
    { name: "ultrafast", desc: "Use Ultrafast when advertised for this model/account" },
  ],
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    const arg = parts[1]?.toLowerCase();
    const enabled: FastMode = arg === "ultrafast" ? "ultrafast" : arg ? arg === "on" : !state.fastMode;
    const supportsFast = providerSupportsFastMode(state, state.provider, state.model, enabled);
    const providerLabel = state.provider;

    if (parts.length > 2 || (arg && !["on", "off", "ultrafast"].includes(arg))) {
      pushSystemMessage(state, "Usage: /fast [on|off|ultrafast]");
      clearPrompt(state);
      return { type: "handled" };
    }

    if (!supportsFast && enabled !== false) {
      pushSystemMessage(state, enabled === "ultrafast"
        ? "Ultrafast is not advertised for this model/account."
        : `Fast mode is only available for ${providerLabel} conversations that support it.`);
      clearPrompt(state);
      return { type: "handled" };
    }

    if (enabled === state.fastMode) {
      pushSystemMessage(state, `Fast mode already ${enabled === "ultrafast" ? "ultrafast" : enabled ? "on" : "off"}.`);
      clearPrompt(state);
      return { type: "handled" };
    }

    state.fastMode = enabled;
    pushSystemMessage(state, `Fast mode ${enabled === "ultrafast" ? "set to ultrafast" : enabled ? "enabled" : "disabled"}.`);
    clearPrompt(state);
    return state.convId ? { type: "fast_mode_changed", enabled } : { type: "handled" };
  },
};
