import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { saveHideSensitiveInfoPreference } from "../privacy";
import type { SlashCommand } from "./types";

function parseHideArg(arg: string | undefined): boolean | null {
  if (!arg) return null;
  switch (arg.toLowerCase()) {
    case "on":
    case "true":
    case "yes":
      return true;
    case "off":
    case "false":
    case "no":
      return false;
    default:
      return null;
  }
}

export const HIDE_COMMAND: SlashCommand = {
  name: "/hide",
  description: "Toggle censoring emails in the UI",
  args: [
    { name: "on", desc: "Censor emails in status blocks and autocomplete" },
    { name: "off", desc: "Show emails normally" },
  ],
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 2) {
      pushSystemMessage(state, "Usage: /hide [on|off]");
      clearPrompt(state);
      return { type: "handled" };
    }

    const requested = parseHideArg(parts[1]);
    if (parts[1] && requested === null) {
      pushSystemMessage(state, "Usage: /hide [on|off]");
      clearPrompt(state);
      return { type: "handled" };
    }

    state.hideSensitiveInfo = requested ?? !state.hideSensitiveInfo;
    saveHideSensitiveInfoPreference(state.hideSensitiveInfo);
    pushSystemMessage(state, `Email hiding ${state.hideSensitiveInfo ? "enabled" : "disabled"}.`);
    clearPrompt(state);
    return { type: "handled" };
  },
};
