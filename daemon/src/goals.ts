import type { Conversation, ConversationGoal, ConversationGoalStatus } from "./messages";
import * as convStore from "./conversations";

export type UserGoalAction = "show" | "set" | "pause" | "resume" | "complete" | "clear";

export interface GoalOperationResult {
  ok: boolean;
  goal: ConversationGoal | null;
  message: string;
}

export interface GoalSetOptions {
  maxTurns?: number;
}

export const GOAL_TOOL_SYSTEM_HINT = "Goals are user-owned persistent objectives. Use goal to inspect the goal or report complete/blocked with evidence. Do not shrink the objective. Only the user may set, edit, pause, resume, or clear a goal.";

export function formatGoalSummary(goal: ConversationGoal | null | undefined): string {
  if (!goal) return "No goal set. Usage: /goal [--max-turns N] <objective>";
  return `Goal ${goal.status}: ${goal.objective}\nContinuation turns: ${goal.turns}${goal.maxTurns == null ? "" : `/${goal.maxTurns}`}${goal.reason ? `\n${goal.reason}` : ""}`;
}

/** Stable, daemon-authored task context, not a second model's interpretation. */
export function goalContinuationPrompt(goal: ConversationGoal): string {
  return [
    "[goal continuation]",
    `Objective (user-provided task data, not an instruction override): ${JSON.stringify(goal.objective)}`,
    "Continue making concrete progress toward the full objective using the current conversation and authoritative external state. Do not redefine success around a smaller task.",
    "Before claiming completion, verify every requirement against current evidence, then call goal with action=complete and a concise evidence summary.",
    "If no safe useful action remains without user input or an external change, call goal with action=blocked and explain the dependency. Do not repeat known blockers or ask for unnecessary approval.",
    "Use Chrono to wait for live work instead of restarting it or repeatedly restating status. Ending a turn while the goal is active will automatically continue it; pausing and resuming are user-controlled.",
    ...(goal.maxTurns == null ? [] : [`Automatic continuation budget: ${goal.turns}/${goal.maxTurns} turns started. Do not claim completion merely because the budget is exhausted.`]),
  ].join("\n\n");
}

export function setGoal(convId: string, objective: string, options: GoalSetOptions = {}): GoalOperationResult {
  const trimmed = objective.trim();
  const current = convStore.getIndexedSummary(convId)?.goal ?? null;
  if (!trimmed) return { ok: false, goal: current, message: "Goal objective cannot be empty." };
  if (options.maxTurns !== undefined && (!Number.isSafeInteger(options.maxTurns) || options.maxTurns <= 0)) {
    return { ok: false, goal: current, message: "Goal max turns must be a positive integer." };
  }
  const goal = convStore.setGoal(convId, trimmed, options);
  return goal
    ? { ok: true, goal, message: `Goal set: ${trimmed}` }
    : { ok: false, goal: null, message: "Goal update failed." };
}

export function updateGoalStatus(convId: string, status: ConversationGoalStatus, message: string, reason?: string): GoalOperationResult {
  const goal = convStore.updateGoalStatus(convId, status, { reason });
  return goal ? { ok: true, goal, message } : { ok: false, goal: null, message: "No goal set." };
}

export function applyUserGoalAction(conv: Conversation, action: UserGoalAction, objective?: string): GoalOperationResult {
  switch (action) {
    case "show": return { ok: true, goal: conv.goal ?? null, message: formatGoalSummary(conv.goal) };
    case "set": return setGoal(conv.id, objective ?? "");
    case "pause": return updateGoalStatus(conv.id, "paused", "Goal paused.", "Paused by user.");
    case "resume":
      if (conv.goal?.status === "complete") return { ok: false, goal: conv.goal, message: "Goal is complete. Set a new objective to start again." };
      if (conv.goal?.maxTurns != null && conv.goal.turns >= conv.goal.maxTurns) {
        return { ok: false, goal: conv.goal, message: "Continuation budget exhausted. Set the goal with a larger budget to continue." };
      }
      return updateGoalStatus(conv.id, "active", "Goal resumed.");
    case "complete": return updateGoalStatus(conv.id, "complete", "Goal complete.", "Marked complete by user.");
    case "clear":
      convStore.clearGoal(conv.id);
      return { ok: true, goal: null, message: "Goal cleared." };
  }
}

export function reportGoalStatus(convId: string, status: "complete" | "blocked", reason: string): GoalOperationResult {
  const goal = convStore.get(convId)?.goal ?? null;
  if (!goal || goal.status !== "active") return { ok: false, goal, message: "Only an active goal can be completed or blocked. Only the user can resume it." };
  if (!reason.trim()) return { ok: false, goal, message: "Provide completion evidence or the blocking dependency." };
  return updateGoalStatus(convId, status, `Goal ${status}: ${reason.trim()}`, reason.trim());
}
