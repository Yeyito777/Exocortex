import type { ConversationGoal } from "./messages";

/** Read old goals without retaining the removed controller permissions. */
export function normalizeConversationGoal(goal: ConversationGoal | null | undefined): ConversationGoal | null {
  if (!goal) return null;
  const { pausable: _pausable, completable: _completable, pausedBy, pauseReason, ...current } = goal;
  if (current.status === "paused" && pausedBy === "controller") current.status = "blocked";
  current.reason ??= pauseReason;
  return current;
}
