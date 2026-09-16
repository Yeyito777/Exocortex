import type { Tool } from "./types";
import * as convStore from "../conversations";
import { formatGoalSummary, GOAL_TOOL_SYSTEM_HINT, reportGoalStatus } from "../goals";

export const goal: Tool = {
  name: "goal",
  description: "Inspect the user-set persistent goal, or report it complete/blocked. Completion requires current evidence for the full objective. Block only when no useful safe action remains without user input or an external change. Cannot create, edit, pause, or resume goals.",
  systemHint: GOAL_TOOL_SYSTEM_HINT,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["show", "complete", "blocked"] },
      reason: { type: "string", description: "Required for complete/blocked: verification evidence or the precise blocking dependency." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  display: { label: "Goal", color: "#c792ea" },
  summarize(input) { return { label: "Goal", detail: `${input.action ?? "show"}${input.reason ? `: ${input.reason}` : ""}` }; },
  async execute(input, context, signal) {
    const id = context?.conversationId;
    if (!id) return { output: "No active conversation goal context.", isError: true };
    if (signal?.aborted) return { output: "Goal update interrupted.", isError: true };
    if (input.action === "show") return { output: formatGoalSummary(convStore.get(id)?.goal), isError: false };
    if (input.action !== "complete" && input.action !== "blocked") return { output: "Use show, complete, or blocked. Goal creation and resuming are user-controlled.", isError: true };
    if (context && Object.prototype.hasOwnProperty.call(context, "goalAtTurnStart")
        && (convStore.get(id)?.goal ?? null) !== context.goalAtTurnStart) {
      return { output: "The user changed the goal during this turn. Leave its current state unchanged; any replacement objective will be handled by the next turn. Do not complete or block it using evidence for the previous task.", isError: true };
    }
    const result = reportGoalStatus(id, input.action, typeof input.reason === "string" ? input.reason : "");
    return { output: result.message, isError: !result.ok };
  },
};
