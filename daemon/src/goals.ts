import type { Conversation, ConversationGoal, ConversationGoalStatus } from "./messages";
import * as convStore from "./conversations";

export type UserGoalAction = "show" | "set" | "pause" | "resume" | "clear";
export type ModelGoalAction = "set" | "pause" | "resume" | "complete";

export interface GoalOperationResult {
  ok: boolean;
  goal: ConversationGoal | null;
  message: string;
}

export const GOAL_CONTINUATION_PROMPT = `You are continuing an active goal objective for this conversation.

Do the next useful unit of work toward the objective. Use the goal tool to manage the goal lifecycle: set a revised/new goal when that is the right continuation, pause when user input is required, resume if you previously paused and can now continue, or complete when the objective is truly finished. Do not ask the user to continue unless you are blocked and pausing the goal.`;

export const GOAL_TOOL_SYSTEM_HINT = "When the user requests a hard or long-horizon task use the goal tool to manage it as a goal. Only mark a goal as complete when it has been genuinely achieved thoroughly and fully. Only pause a goal when you *require* user input to continue chasing your goal and don't see any other path forward. Again: only use this tool when the user requests a genuinely hard or long-horizon task";

export function formatGoalSummary(goal: ConversationGoal | null | undefined): string {
  if (!goal) return "No goal set. Usage: /goal <objective>";
  const turns = goal.turns ? ` (${goal.turns} continuation turn${goal.turns === 1 ? "" : "s"})` : "";
  return `Goal ${goal.status}: ${goal.objective}${turns}`;
}

function statusForModelAction(action: Exclude<ModelGoalAction, "set">): ConversationGoalStatus {
  if (action === "complete") return "complete";
  if (action === "pause") return "paused";
  return "active";
}

function actionPastTense(action: ModelGoalAction): string {
  switch (action) {
    case "set": return "set";
    case "pause": return "paused";
    case "resume": return "resumed";
    case "complete": return "complete";
  }
}

export function setGoal(convId: string, objective: string): GoalOperationResult {
  const trimmed = objective.trim();
  if (!trimmed) return { ok: false, goal: convStore.get(convId)?.goal ?? null, message: "Goal objective cannot be empty." };
  const goal = convStore.setGoal(convId, trimmed);
  if (!goal) return { ok: false, goal: null, message: "Goal update failed." };
  return { ok: true, goal, message: `Goal set: ${trimmed}` };
}

export function clearGoal(convId: string): GoalOperationResult {
  const changed = convStore.clearGoal(convId);
  return { ok: true, goal: null, message: changed ? "Goal cleared." : "No goal set." };
}

export function updateGoalStatus(convId: string, status: ConversationGoalStatus, message: string): GoalOperationResult {
  const goal = convStore.updateGoalStatus(convId, status);
  if (!goal) return { ok: false, goal: null, message: "No goal set." };
  return { ok: true, goal, message };
}

export function applyUserGoalAction(conv: Conversation, action: UserGoalAction, objective?: string): GoalOperationResult {
  switch (action) {
    case "show":
      return { ok: true, goal: conv.goal ?? null, message: formatGoalSummary(conv.goal) };
    case "set":
      return setGoal(conv.id, objective ?? "");
    case "pause":
      return updateGoalStatus(conv.id, "paused", "Goal paused.");
    case "resume":
      return updateGoalStatus(conv.id, "active", "Goal resumed.");
    case "clear":
      return clearGoal(conv.id);
  }
}

export function applyModelGoalAction(convId: string, action: ModelGoalAction, objective?: string): GoalOperationResult {
  if (action === "set") return setGoal(convId, objective ?? "");
  return updateGoalStatus(convId, statusForModelAction(action), `Goal ${actionPastTense(action)}.`);
}
