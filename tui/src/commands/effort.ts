import { clearPrompt } from "../promptstate";
import { pushSystemMessage } from "../state";
import type { EffortLevel } from "../messages";
import { defaultEffortFor, effortItems, formatEffortChoices, supportedEfforts } from "./shared";
import type { SlashCommand } from "./types";

export const EFFORT_COMMAND: SlashCommand = {
  name: "/effort",
  description: "Set or show reasoning effort level",
  getArgs: (state) => ({
    "/effort": effortItems(state),
  }),
  handler: (text, state) => {
    const parts = text.split(/\s+/);
    const arg = parts[1];
    const supported = supportedEfforts(state);
    const supportedLevels = supported.map((candidate) => candidate.effort);
    const defaultEffort = defaultEffortFor(state);
    if (arg && supportedLevels.includes(arg as EffortLevel)) {
      const effort = arg as EffortLevel;
      state.effort = effort;
      pushSystemMessage(state, `Effort set to ${effort}`);
      clearPrompt(state);
      return { type: "effort_changed", effort };
    }

    const detail = supported
      .map((candidate) => `${candidate.effort}: ${candidate.description}`)
      .join("\n");
    pushSystemMessage(state, `Current: ${state.effort}. Available: ${formatEffortChoices(supported, state.effort, defaultEffort)}${detail ? `\n${detail}` : ""}`);
    clearPrompt(state);
    return { type: "handled" };
  },
};
