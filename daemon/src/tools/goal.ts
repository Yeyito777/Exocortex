import type { Tool } from "./types";
import { applyModelGoalAction, GOAL_TOOL_SYSTEM_HINT, goalPermissionFlagSuffix, normalizeGoalSetOptions } from "../goals";

type GoalAction = "set" | "pause" | "resume" | "complete";

function actionFromInput(input: Record<string, unknown>): GoalAction | null {
  const action = input.action;
  return action === "set" || action === "pause" || action === "resume" || action === "complete"
    ? action
    : null;
}

export const goal: Tool = {
  name: "goal",
  description: "Manage the active conversation goal. Mirrors the user's /goal command: set a goal, pause when user input is required, resume when no longer blocked, or complete and clear the goal.",
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
      pausable: {
        type: "boolean",
        description: "Optional for action=set. Whether this goal may be paused later. Defaults to true. If completable is false, this is forced to false.",
      },
      completable: {
        type: "boolean",
        description: "Optional for action=set. Whether this goal may be marked complete later. Defaults to true. If false, pausable is also forced false.",
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
      const options = normalizeGoalSetOptions({
        pausable: typeof input.pausable === "boolean" ? input.pausable : undefined,
        completable: typeof input.completable === "boolean" ? input.completable : undefined,
      });
      const suffix = goalPermissionFlagSuffix(options);
      return { label: "Goal", detail: objective ? `set: ${objective}${suffix}` : `set${suffix}` };
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
    const options = action === "set"
      ? {
        pausable: typeof input.pausable === "boolean" ? input.pausable : undefined,
        completable: typeof input.completable === "boolean" ? input.completable : undefined,
      }
      : undefined;
    const result = applyModelGoalAction(convId, action, objective, options);
    if (!result.ok) return { output: result.message, isError: true };

    const reason = typeof input.reason === "string" && input.reason.trim()
      ? `\nReason: ${input.reason.trim()}`
      : "";
    return { output: `${result.message}${reason}`, isError: false };
  },
};
