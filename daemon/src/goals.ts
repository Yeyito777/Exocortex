import type { Conversation, ConversationGoal, ConversationGoalStatus } from "./messages";
import * as convStore from "./conversations";

export type UserGoalAction = "show" | "set" | "pause" | "resume" | "complete";

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

export const GOAL_TOOL_SYSTEM_HINT = "Only set a goal when the user explicitly asks you to. Capture the user's general direction rather than a specific next step.";

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

export function normalizeGoalSetOptions(options: GoalSetOptions = {}): Required<GoalSetOptions> {
  const completable = options.completable ?? true;
  return {
    completable,
    pausable: completable ? options.pausable ?? true : false,
  };
}

export function setGoal(convId: string, objective: string, options: GoalSetOptions = {}): GoalOperationResult {
  const trimmed = objective.trim();
  if (!trimmed) return { ok: false, goal: convStore.getIndexedSummary(convId)?.goal ?? null, message: "Goal objective cannot be empty." };
  const normalizedOptions = normalizeGoalSetOptions(options);
  const goal = convStore.setGoal(convId, trimmed, normalizedOptions);
  if (!goal) return { ok: false, goal: null, message: "Goal update failed." };
  return { ok: true, goal, message: `Goal set: ${trimmed}${goalPermissionFlagSuffix(normalizedOptions)}` };
}

export function updateGoalStatus(
  convId: string,
  status: IncompleteGoalStatus,
  message: string,
  options: {
    enforceModelPermissions?: boolean;
    pausedBy?: "user" | "controller";
    reason?: string;
  } = {},
): GoalOperationResult {
  const currentGoal = convStore.getIndexedSummary(convId)?.goal ?? null;
  const enforceModelPermissions = options.enforceModelPermissions ?? false;
  if (enforceModelPermissions && status === "paused" && currentGoal && !goalCanPause(currentGoal)) {
    return { ok: false, goal: currentGoal, message: "This goal cannot be paused." };
  }
  const goal = convStore.updateGoalStatus(convId, status, {
    pausedBy: options.pausedBy,
    reason: options.reason,
  });
  if (!goal) return { ok: false, goal: null, message: "No goal set." };
  return { ok: true, goal, message };
}

export function completeGoal(convId: string, message = "Goal complete.", options: { enforceModelPermissions?: boolean } = {}): GoalOperationResult {
  const currentGoal = convStore.getIndexedSummary(convId)?.goal ?? null;
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
      return updateGoalStatus(conv.id, "paused", "Goal paused.", { pausedBy: "user" });
    case "resume":
      return updateGoalStatus(conv.id, "active", "Goal resumed.");
    case "complete":
      return completeGoal(conv.id);
  }
}

export function applyGoalControllerAction(
  convId: string,
  action: "pause" | "complete",
  reason?: string,
): GoalOperationResult {
  const trimmedReason = reason?.trim();
  if (action === "complete") {
    return completeGoal(
      convId,
      trimmedReason ? `Goal complete: ${trimmedReason}` : "Goal complete.",
      { enforceModelPermissions: true },
    );
  }
  return updateGoalStatus(
    convId,
    "paused",
    trimmedReason ? `Goal paused: ${trimmedReason}` : "Goal paused.",
    { enforceModelPermissions: true, pausedBy: "controller", reason: trimmedReason },
  );
}
