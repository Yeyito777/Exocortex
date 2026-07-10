import type { Conversation, ConversationGoal, ConversationGoalStatus } from "./messages";
import * as convStore from "./conversations";

export type UserGoalAction = "show" | "set" | "pause" | "resume" | "complete";
export type ModelGoalAction = "set" | "pause" | "resume" | "complete";

export interface GoalOperationResult {
  ok: boolean;
  goal: ConversationGoal | null;
  message: string;
}

export interface GoalSetOptions {
  pausable?: boolean;
  completable?: boolean;
}

type IncompleteGoalStatus = Exclude<ConversationGoalStatus, "complete">;

export const GOAL_TOOL_SYSTEM_HINT = "Only set a goal when the user explicitly asks you to. If a goal is already active, use this tool only to pause, resume, or complete it when appropriate.";

export function formatGoalSummary(goal: ConversationGoal | null | undefined): string {
  if (!goal) return "No goal set. Usage: /goal <objective>";
  const turns = goal.turns ? ` (${goal.turns} continuation turn${goal.turns === 1 ? "" : "s"})` : "";
  return `Goal ${goal.status}: ${goal.objective}${turns}`;
}

export function goalCanComplete(goal: ConversationGoal | null | undefined): boolean {
  return goal?.completable !== false;
}

export function goalCanPause(goal: ConversationGoal | null | undefined): boolean {
  return goalCanComplete(goal) && goal?.pausable !== false;
}

export function goalPermissionFlagSuffix(goal: ConversationGoal | Required<GoalSetOptions>): string {
  const flags = [
    goal.pausable === false ? "--unpausable" : null,
    goal.completable === false ? "--uncompletable" : null,
  ].filter((entry): entry is string => Boolean(entry));
  return flags.length ? ` ${flags.join(" ")}` : "";
}

export function goalContinuationUserMessage(goal: ConversationGoal): string {
  const lifecycle = [
    goalCanComplete(goal) ? "If the goal is finished, mark it complete." : null,
    goalCanPause(goal) ? "If you are blocked or need user input or review, pause it." : null,
    goalCanComplete(goal) || goalCanPause(goal) ? "Otherwise, keep working." : null,
  ].filter((instruction): instruction is string => Boolean(instruction));
  return [
    "Continue the active goal:",
    goal.objective,
    lifecycle.join(" "),
  ].filter(Boolean).join("\n\n");
}

function statusForModelAction(action: Exclude<ModelGoalAction, "set" | "complete">): IncompleteGoalStatus {
  if (action === "pause") return "paused";
  return "active";
}

export function normalizeGoalSetOptions(options: GoalSetOptions = {}): Required<GoalSetOptions> {
  const completable = options.completable ?? true;
  return {
    completable,
    pausable: completable ? options.pausable ?? true : false,
  };
}

export function setGoal(convId: string, objective: string, options: GoalSetOptions = {}): GoalOperationResult {
  const trimmed = objective.trim();
  if (!trimmed) return { ok: false, goal: convStore.get(convId)?.goal ?? null, message: "Goal objective cannot be empty." };
  const normalizedOptions = normalizeGoalSetOptions(options);
  const goal = convStore.setGoal(convId, trimmed, normalizedOptions);
  if (!goal) return { ok: false, goal: null, message: "Goal update failed." };
  return { ok: true, goal, message: `Goal set: ${trimmed}${goalPermissionFlagSuffix(normalizedOptions)}` };
}

export function updateGoalStatus(convId: string, status: IncompleteGoalStatus, message: string, options: { enforceModelPermissions?: boolean } = {}): GoalOperationResult {
  const currentGoal = convStore.get(convId)?.goal ?? null;
  const enforceModelPermissions = options.enforceModelPermissions ?? false;
  if (enforceModelPermissions && status === "paused" && currentGoal && !goalCanPause(currentGoal)) {
    return { ok: false, goal: currentGoal, message: "This goal cannot be paused." };
  }
  const goal = convStore.updateGoalStatus(convId, status);
  if (!goal) return { ok: false, goal: null, message: "No goal set." };
  return { ok: true, goal, message };
}

export function completeGoal(convId: string, message = "Goal complete.", options: { enforceModelPermissions?: boolean } = {}): GoalOperationResult {
  const currentGoal = convStore.get(convId)?.goal ?? null;
  const enforceModelPermissions = options.enforceModelPermissions ?? false;
  if (!currentGoal) return { ok: false, goal: null, message: "No goal set." };
  if (enforceModelPermissions && !goalCanComplete(currentGoal)) {
    return { ok: false, goal: currentGoal, message: "This goal cannot be completed." };
  }

  convStore.clearGoal(convId);
  return { ok: true, goal: null, message };
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
    case "complete":
      return completeGoal(conv.id);
  }
}

export function applyModelGoalAction(convId: string, action: ModelGoalAction, objective?: string, options?: GoalSetOptions): GoalOperationResult {
  if (action === "set") return setGoal(convId, objective ?? "", options);
  if (action === "complete") return completeGoal(convId, "Goal complete.", { enforceModelPermissions: true });
  return updateGoalStatus(convId, statusForModelAction(action), action === "pause" ? "Goal paused." : "Goal resumed.", { enforceModelPermissions: true });
}
