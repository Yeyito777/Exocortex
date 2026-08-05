import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { theme, themes, THEME_NAMES, setTheme } from "../theme";
import type { SlashCommand } from "./types";

const THEME_SWATCHES = "███";

export const THEME_COMMAND: SlashCommand = {
  name: "/theme",
  description: "Set or show the current theme",
  getArgs: () => ({
    "/theme": THEME_NAMES.map((name) => ({
      name,
      desc: THEME_SWATCHES,
      colorSwatches: themes[name].previewColors,
    })),
  }),
  handler: (text, state) => {
    const parts = text.split(/\s+/);
    const arg = parts[1];
    if (arg && arg in themes) {
      if (arg === theme.name) {
        pushSystemMessage(state, `Theme is already ${arg}`);
        clearPrompt(state);
        return { type: "handled" };
      }
      setTheme(arg);
      pushSystemMessage(state, `Theme set to ${arg}`);
      clearPrompt(state);
      return { type: "theme_changed" };
    }

    pushSystemMessage(state, `Current: ${theme.name}. Available: ${THEME_NAMES.join(", ")}`);
    clearPrompt(state);
    return { type: "handled" };
  },
};
