import { saveFoldStylePreference } from "../diagnostics";
import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import { FOLD_STYLES, type FoldStyle } from "../turncollapse";
import type { SlashCommand } from "./types";

/** Experimental: switch between the folded-history styles being compared. */
export const FOLDSTYLE_COMMAND: SlashCommand = {
  name: "/foldstyle",
  description: "Experimental: how folded work and notifications look (saved locally)",
  args: [
    { name: "rows", desc: "A row per notification and per turn's work (today)" },
    { name: "inline", desc: "No extra rows: a tag on the reply's metadata line" },
    { name: "episode", desc: "One line per stretch between your messages; replies stay" },
    { name: "gutter", desc: "A dim marker in the left gutter of each reply" },
  ],
  handler: (text, state) => {
    const arg = text.trim().split(/\s+/)[1]?.toLowerCase();
    if (!arg || !(FOLD_STYLES as readonly string[]).includes(arg)) {
      pushSystemMessage(state, `Usage: /foldstyle ${FOLD_STYLES.join("|")} (now ${state.foldStyle})`);
      clearPrompt(state);
      return { type: "handled" };
    }
    state.foldStyle = arg as FoldStyle;
    saveFoldStylePreference(state.foldStyle);
    pushSystemMessage(state, `Fold style: ${arg}.`);
    clearPrompt(state);
    return { type: "handled" };
  },
};
