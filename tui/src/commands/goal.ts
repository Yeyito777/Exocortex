import type { SlashCommand } from "./types";
import { pushSystemMessage } from "../state";

export const GOAL_COMMAND: SlashCommand = {
  name: "/goal",
  description: "Set/show/pause/resume/complete/clear a persistent goal",
  args: [
    { name: "pause", desc: "stop goal work until explicitly resumed" },
    { name: "resume", desc: "resume a paused or blocked goal" },
    { name: "complete", desc: "mark complete and retain the result" },
    { name: "clear", desc: "remove the goal" },
    { name: "--max-turns", desc: "optional automatic continuation budget" },
  ],
  handler(text, state) {
    let objective = text.slice("/goal".length).trim();
    if (!objective) return { type: "goal", action: "show" };
    if (objective === "pause" || objective === "resume" || objective === "complete" || objective === "clear") {
      return { type: "goal", action: objective };
    }
    let maxTurns: number | undefined;
    if (objective.startsWith("--max-turns")) {
      const match = objective.match(/^--max-turns[ =](\d+)\s+([\s\S]+)$/);
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1) {
        pushSystemMessage(state, "Usage: /goal --max-turns <positive integer> <objective>");
        return { type: "handled" };
      }
      maxTurns = Number(match[1]);
      objective = match[2].trim();
    }
    if (/(?:^|\s)(?:--)?un(?:pausable|completable)(?=\s|\/|$)|(?:^|\s)(?:pausable|completable)=/i.test(objective)) {
      pushSystemMessage(state, "Goal permission flags were removed. Use /goal <objective>; for recurring monitoring use Chrono.");
      return { type: "handled" };
    }
    return { type: "goal", action: "set", objective, ...(maxTurns === undefined ? {} : { maxTurns }) };
  },
};
