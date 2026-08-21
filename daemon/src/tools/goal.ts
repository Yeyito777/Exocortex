import type { Tool } from "./types";
import { readExocortexConfig, type ExocortexConfig } from "@exocortex/shared/config";
import { GOAL_TOOL_SYSTEM_HINT, goalPermissionFlagSuffix, normalizeGoalSetOptions, setGoal } from "../goals";

export function isGoalToolFeatureEnabled(config: ExocortexConfig = readExocortexConfig()): boolean {
  // The goal tool is product behavior by default; hide/disable it only when the
  // user explicitly opts out with config.features.goalTool=false.
  return config.features?.goalTool !== false;
}

export const goal: Tool = {
  name: "goal",
  description: "Set a goal that lets you work on a task for 100+ hours. Only use it when the user explicitly asks you to set a goal.",
  systemHint: GOAL_TOOL_SYSTEM_HINT,
  isAvailable: isGoalToolFeatureEnabled,
  inputSchema: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description: "The new active goal objective.",
      },
      pausable: {
        type: "boolean",
        description: "Whether the private goal controller may pause this goal later. Defaults to true. If completable is false, this is forced to false.",
      },
      completable: {
        type: "boolean",
        description: "Whether the private goal controller may mark this goal complete later. Defaults to true. If false, pausable is also forced to false.",
      },
    },
    required: ["objective"],
    additionalProperties: false,
  },
  display: { label: "Goal", color: "#c792ea" },
  summarize(input) {
    const objective = typeof input.objective === "string" ? input.objective : "";
    const options = normalizeGoalSetOptions({
      pausable: typeof input.pausable === "boolean" ? input.pausable : undefined,
      completable: typeof input.completable === "boolean" ? input.completable : undefined,
    });
    const suffix = goalPermissionFlagSuffix(options);
    return { label: "Goal", detail: objective ? `set: ${objective}${suffix}` : `set${suffix}` };
  },
  async execute(input, context) {
    const convId = context?.conversationId;
    if (!convId) return { output: "No active conversation goal context.", isError: true };

    const objective = typeof input.objective === "string" ? input.objective.trim() : "";
    if (!objective) return { output: "Goal objective cannot be empty.", isError: true };
    const result = setGoal(convId, objective, {
      pausable: typeof input.pausable === "boolean" ? input.pausable : undefined,
      completable: typeof input.completable === "boolean" ? input.completable : undefined,
    });
    return { output: result.message, isError: !result.ok };
  },
};
