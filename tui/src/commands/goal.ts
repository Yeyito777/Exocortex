import { parseGoalDuration } from "@exocortex/shared/goals";
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
    { name: "max-time", desc: "optional active-time limit, e.g. 9h2m1s, 8h3m, 5m, 2d" },
  ],
  handler(text, state) {
    let objective = text.slice("/goal".length).trim();
    if (!objective) return { type: "goal", action: "show" };
    if (objective === "pause" || objective === "resume" || objective === "complete" || objective === "clear") {
      return { type: "goal", action: objective };
    }
    let maxTimeMs: number | undefined;
    if (/^max-time(?:\s|$)/.test(objective)) {
      const match = objective.match(/^max-time\s+(\S+)\s+([\s\S]+)$/);
      const parsed = match ? parseGoalDuration(match[1]) : null;
      if (!match || parsed == null) {
        pushSystemMessage(state, "Usage: /goal max-time <duration> <objective>, with a duration such as 9h2m1s, 8h3m, 1h, 5m or 2d");
        return { type: "handled" };
      }
      maxTimeMs = parsed;
      objective = match[2].trim();
    }
    if (/^--max-turns(?:[\s=]|$)/.test(objective)) {
      pushSystemMessage(state, "--max-turns was removed. Use /goal max-time <duration> <objective>.");
      return { type: "handled" };
    }
    if (/(?:^|\s)(?:--)?un(?:pausable|completable)(?=\s|\/|$)|(?:^|\s)(?:pausable|completable)=/i.test(objective)) {
      pushSystemMessage(state, "Goal permission flags were removed. Use /goal <objective>; for recurring monitoring use Chrono.");
      return { type: "handled" };
    }
    return { type: "goal", action: "set", objective, ...(maxTimeMs === undefined ? {} : { maxTimeMs }) };
  },
};
