import type { Tool } from "./types";
import { applyModelGoalAction, GOAL_TOOL_SYSTEM_HINT } from "../goals";

type GoalAction = "set" | "pause" | "resume" | "complete";

function actionFromInput(input: Record<string, unknown>): GoalAction | null {
  const action = input.action;
  return action === "set" || action === "pause" || action === "resume" || action === "complete"
    ? action
    : null;
}

function goalMessage(action: GoalAction, objective?: string): string {
  switch (action) {
    case "set": return `Goal set: ${objective}`;
    case "pause": return "Goal paused.";
    case "resume": return "Goal resumed.";
    case "complete": return "Goal complete.";
  }
}

export const goal: Tool = {
  name: "goal",
  description: "Manage the active conversation goal. Mirrors the user's /goal command: set a goal, pause when user input is required, resume when no longer blocked, or mark the goal complete.",
  systemHint: GOAL_TOOL_SYSTEM_HINT,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["set", "pause", "resume", "complete"],
        description: "Goal lifecycle action to perform.",
      },
      objective: {
        type: "string",
        description: "Required for action=set. The new active goal objective.",
      },
      reason: {
        type: "string",
        description: "Optional short reason, especially useful when pausing for user input or completing a goal.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  display: { label: "Goal", color: "#c792ea" },
  summarize(input) {
    const action = actionFromInput(input);
    if (!action) return { label: "Goal", detail: "invalid action" };
    if (action === "set") {
      const objective = typeof input.objective === "string" ? input.objective : "";
      return { label: "Goal", detail: objective ? `set: ${objective}` : "set" };
    }
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    return { label: "Goal", detail: reason ? `${action}: ${reason}` : action };
  },
  async execute(input, context) {
    const convId = context?.conversationId;
    if (!convId) return { output: "No active conversation goal context.", isError: true };

    const action = actionFromInput(input);
    if (!action) return { output: "Invalid goal action. Use set, pause, resume, or complete.", isError: true };

    const objective = typeof input.objective === "string" ? input.objective.trim() : undefined;
    const result = applyModelGoalAction(convId, action, objective);
    if (!result.ok) return { output: result.message, isError: true };

    const reason = typeof input.reason === "string" && input.reason.trim()
      ? `\nReason: ${input.reason.trim()}`
      : "";
    return { output: `${goalMessage(action, objective)}${reason}`, isError: false };
  },
};
