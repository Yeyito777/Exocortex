import type { SlashCommand } from "./types";

export const GOAL_COMMAND: SlashCommand = {
  name: "/goal",
  description: "Set/show/pause/resume/clear an auto-continuing goal",
  args: [
    { name: "pause", desc: "pause the active goal" },
    { name: "resume", desc: "resume the paused goal" },
    { name: "clear", desc: "clear the goal" },
  ],
  handler(text) {
    const rest = text.slice("/goal".length).trim();
    if (!rest) return { type: "goal", action: "show" };
    if (rest === "pause") return { type: "goal", action: "pause" };
    if (rest === "resume") return { type: "goal", action: "resume" };
    if (rest === "clear") return { type: "goal", action: "clear" };
    return { type: "goal", action: "set", objective: rest };
  },
};
