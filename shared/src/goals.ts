import type { ConversationGoal, ConversationGoalStatus } from "./messages";

/** Read old goals without retaining the removed controller permissions or turn budget. */
export function normalizeConversationGoal(goal: ConversationGoal | null | undefined): ConversationGoal | null {
  if (!goal) return null;
  const { pausable: _pausable, completable: _completable, maxTurns: _maxTurns, pausedBy, pauseReason, ...current } = goal;
  if (current.status === "paused" && pausedBy === "controller") current.status = "blocked";
  current.reason ??= pauseReason;
  return current;
}

/** Move a goal to `status`, closing or opening its active-time period. */
export function applyGoalStatus(goal: ConversationGoal, status: ConversationGoalStatus, reason: string | undefined, now = Date.now()): void {
  if (status === "active") {
    goal.activeSince ??= now;
    goal.emptyTurns = 0;
  } else if (goal.status === "active") {
    goal.activeMs = goalActiveMs(goal, now);
    delete goal.activeSince;
  }
  goal.status = status;
  goal.reason = reason?.trim() || undefined;
  delete goal.pausedBy;
  delete goal.pauseReason;
  goal.updatedAt = now;
}

/** Time the goal has spent active, excluding paused/blocked/complete periods. */
export function goalActiveMs(goal: ConversationGoal, now = Date.now()): number {
  const current = goal.status === "active" && goal.activeSince != null ? Math.max(0, now - goal.activeSince) : 0;
  return (goal.activeMs ?? 0) + current;
}

/** Active time left before the goal's max-time, or null when it has no limit. */
export function goalRemainingMs(goal: ConversationGoal, now = Date.now()): number | null {
  return goal.maxTimeMs == null ? null : Math.max(0, goal.maxTimeMs - goalActiveMs(goal, now));
}

const DURATION_UNITS = [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1_000]] as const;

/** Parse a goal duration such as `9h2m1s`, `8h3m`, `1h`, `5m` or `2d`; null if invalid or zero. */
export function parseGoalDuration(text: string): number | null {
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(text.trim());
  if (!match || !text.trim()) return null;
  const ms = DURATION_UNITS.reduce((total, [, unitMs], index) => total + Number(match[index + 1] ?? 0) * unitMs, 0);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

/** Format milliseconds in the same unit style, e.g. `1d2h`, `9h2m1s`, `0s`. */
export function formatGoalDuration(ms: number): string {
  let rest = Math.max(0, Math.floor(ms / 1_000)) * 1_000;
  const parts: string[] = [];
  for (const [unit, unitMs] of DURATION_UNITS) {
    const count = Math.floor(rest / unitMs);
    rest -= count * unitMs;
    if (count > 0) parts.push(`${count}${unit}`);
  }
  return parts.join("") || "0s";
}
