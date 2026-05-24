import type { Conversation, ConversationGoal, ConversationGoalStatus } from "./messages";
import * as convStore from "./conversations";

export type UserGoalAction = "show" | "set" | "pause" | "resume" | "clear";
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

export const GOAL_CONTINUATION_PROMPT = `This is an automated message you're seeing because the user isn't present and you didn't pause / complete the goal you've been working on. Ask yourself: Should you pause it? Are you stuck and need human review? Perhaps you're addressing a tangent rn bc of user request and should also pause? If so pause. Also ask yourself: Should you complete it? is the goal done? Have you completed it thoroughly, accurately, and to a level of satisfaction that when the user comes back he'll most likely say "good job!"? If so, complete it. Else, if you don't need to pause or complete your goal, continue working.`;

export const GOAL_CONTINUATION_NO_PAUSE_PROMPT = `This is an automated message you're seeing because the user isn't present and you didn't complete the goal you've been working on. Ask yourself: Should you complete it? Is the goal done? Have you completed it thoroughly, accurately, and to a level of satisfaction that when the user comes back he'll most likely say "good job!"? If so, complete it. Else continue working.`;

export const GOAL_CONTINUATION_WORK_ONLY_PREFIX = "Continue working on the active goal: ";

export const GOAL_TOOL_SYSTEM_HINT = "When the user requests a hard or long-horizon task use the goal tool to manage it as a goal. When setting a goal, pausable and completable default to true; set completable=false for goals that should continue until the user intervenes, which also forces pausable=false. Only mark a goal as complete when it has been genuinely achieved thoroughly and fully and completion is allowed. Only pause a goal when you *require* user input to continue chasing your goal, don't see any other path forward, and pausing is allowed. Again: only use this tool when the user requests a genuinely hard or long-horizon task";

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

export function goalContinuationSystemPrompt(goal: ConversationGoal): string | null {
  if (!goalCanComplete(goal)) return null;
  return goalCanPause(goal) ? GOAL_CONTINUATION_PROMPT : GOAL_CONTINUATION_NO_PAUSE_PROMPT;
}

export function goalContinuationUserMessage(goal: ConversationGoal): string {
  if (!goalCanComplete(goal) && !goalCanPause(goal)) return `${GOAL_CONTINUATION_WORK_ONLY_PREFIX}${goal.objective}`;
  return `Continue the active /goal objective now: ${goal.objective}`;
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

export function clearGoal(convId: string): GoalOperationResult {
  const changed = convStore.clearGoal(convId);
  return { ok: true, goal: null, message: changed ? "Goal cleared." : "No goal set." };
}

export function updateGoalStatus(convId: string, status: ConversationGoalStatus, message: string): GoalOperationResult {
  const currentGoal = convStore.get(convId)?.goal ?? null;
  if (status === "paused" && currentGoal && !goalCanPause(currentGoal)) {
    return { ok: false, goal: currentGoal, message: "This goal cannot be paused." };
  }
  if (status === "complete" && currentGoal && !goalCanComplete(currentGoal)) {
    return { ok: false, goal: currentGoal, message: "This goal cannot be completed." };
  }
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

export function applyModelGoalAction(convId: string, action: ModelGoalAction, objective?: string, options?: GoalSetOptions): GoalOperationResult {
  if (action === "set") return setGoal(convId, objective ?? "", options);
  return updateGoalStatus(convId, statusForModelAction(action), `Goal ${actionPastTense(action)}.`);
}
