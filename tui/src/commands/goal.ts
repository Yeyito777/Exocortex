import type { SlashCommand } from "./types";

function parseBool(value: string): boolean | null {
  if (["true", "yes", "on", "1"].includes(value)) return true;
  if (["false", "no", "off", "0"].includes(value)) return false;
  return null;
}

function parseSetArgs(rest: string): { objective: string; pausable?: boolean; completable?: boolean } {
  const parts = rest.split(/\s+/).filter(Boolean);
  let pausable: boolean | undefined;
  let completable: boolean | undefined;
  const objectiveParts: string[] = [];

  for (const part of parts) {
    const normalizedPart = part.toLowerCase();
    if (normalizedPart === "unpausable" || normalizedPart === "--unpausable") {
      pausable = false;
      continue;
    }
    if (normalizedPart === "unpausable/uncompletable" || normalizedPart === "--unpausable/--uncompletable") {
      completable = false;
      pausable = false;
      continue;
    }
    if (normalizedPart === "uncompletable" || normalizedPart === "--uncompletable") {
      completable = false;
      pausable = false;
      continue;
    }

    const match = part.match(/^(pausable|completable)=(true|false|yes|no|on|off|1|0)$/i);
    if (!match) {
      objectiveParts.push(part);
      continue;
    }
    const parsed = parseBool(match[2].toLowerCase());
    if (parsed === null) {
      objectiveParts.push(part);
      continue;
    }
    if (match[1].toLowerCase() === "pausable") pausable = parsed;
    else completable = parsed;
  }

  if (completable === false) pausable = false;
  return { objective: objectiveParts.join(" "), pausable, completable };
}

export const GOAL_COMMAND: SlashCommand = {
  name: "/goal",
  description: "Set/show/pause/resume/clear an auto-continuing goal",
  args: [
    { name: "pause", desc: "pause the active goal" },
    { name: "resume", desc: "resume the paused goal" },
    { name: "complete", desc: "mark the active goal complete" },
    { name: "clear", desc: "clear the goal" },
    { name: "unpausable", desc: "set a goal the AI cannot pause" },
    { name: "uncompletable", desc: "set a goal the AI cannot complete or pause" },
  ],
  handler(text) {
    const rest = text.slice("/goal".length).trim();
    if (!rest) return { type: "goal", action: "show" };
    if (rest === "pause") return { type: "goal", action: "pause" };
    if (rest === "resume") return { type: "goal", action: "resume" };
    if (rest === "complete") return { type: "goal", action: "complete" };
    if (rest === "clear") return { type: "goal", action: "clear" };
    const parsed = parseSetArgs(rest);
    return { type: "goal", action: "set", ...parsed };
  },
};
