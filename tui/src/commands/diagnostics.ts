import { saveDiagnosticsPreference } from "../diagnostics";
import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { SlashCommand } from "./types";

export const DIAGNOSTICS_COMMAND: SlashCommand = {
  name: "/diagnostics",
  description: "Toggle token counts in AI metadata (saved locally)",
  args: [
    { name: "on", desc: "Show output-token counts alongside tokens/second" },
    { name: "off", desc: "Hide output-token counts" },
  ],
  handler: (text, state) => {
    const parts = text.trim().split(/\s+/);
    const arg = parts[1]?.toLowerCase();
    if (parts.length > 2 || (arg !== undefined && arg !== "on" && arg !== "off")) {
      pushSystemMessage(state, "Usage: /diagnostics [on|off]");
      clearPrompt(state);
      return { type: "handled" };
    }

    const enabled = arg === undefined ? !state.showDiagnostics : arg === "on";
    saveDiagnosticsPreference(enabled);
    state.showDiagnostics = enabled;
    pushSystemMessage(state, `Diagnostics ${enabled ? "enabled" : "disabled"}.`);
    clearPrompt(state);
    return { type: "handled" };
  },
};
