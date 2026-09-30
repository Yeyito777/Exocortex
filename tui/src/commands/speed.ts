import type { FastMode } from "@exocortex/shared/messages";
import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { providerSupportsFastMode } from "./shared";
import type { CompletionItem, SlashCommand } from "./types";

export const SPEED_COMMAND_ARGS: CompletionItem[] = [
  { name: "on", desc: "Enable this speed tier for this conversation" },
  { name: "off", desc: "Return to standard speed" },
];

export function speedModeForArgument(tier: true | "ultrafast", arg: string | undefined, current: FastMode): FastMode {
  if (arg === "off") return false;
  if (arg === "on") return tier;
  return current === tier ? false : tier;
}

export function createSpeedCommand(name: "/fast" | "/ultrafast", tier: true | "ultrafast"): SlashCommand {
  const label = tier === "ultrafast" ? "Ultrafast" : "Fast";
  return {
    name,
    description: `Toggle or set OpenAI ${label.toLowerCase()} mode`,
    args: SPEED_COMMAND_ARGS,
    handler: (text, state) => {
      const parts = text.trim().split(/\s+/).filter(Boolean);
      const arg = parts[1]?.toLowerCase();
      if (parts.length > 2 || (arg && !["on", "off"].includes(arg))) {
        pushSystemMessage(state, `Usage: ${name} [on|off]`);
        clearPrompt(state);
        return { type: "handled" };
      }
      const enabled = speedModeForArgument(tier, arg, state.fastMode);
      if (enabled && !providerSupportsFastMode(state, state.provider, state.model, enabled)) {
        pushSystemMessage(state, tier === "ultrafast"
          ? "Ultrafast is not advertised for this model/account."
          : `Fast mode is only available for ${state.provider} conversations that support it.`);
        clearPrompt(state);
        return { type: "handled" };
      }
      if (enabled === state.fastMode) {
        pushSystemMessage(state, `${label} mode already ${enabled ? "on" : "off"}.`);
        clearPrompt(state);
        return { type: "handled" };
      }
      state.fastMode = enabled;
      pushSystemMessage(state, `${label} mode ${enabled ? "enabled" : "disabled"}.`);
      clearPrompt(state);
      return state.convId ? { type: "fast_mode_changed", enabled } : { type: "handled" };
    },
  };
}
