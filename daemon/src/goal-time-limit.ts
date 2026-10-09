/**
 * Enforces a goal's max-time. When its active time runs out the goal is
 * blocked and its work stops like /goal pause: the current turn is aborted,
 * pending continuations and Chrono sleeps are cancelled.
 *
 * Only users activate goals (set/resume), so callers reschedule after those
 * and once at startup. A timer that fires for a goal that is no longer active
 * does nothing.
 */

import { goalRemainingMs } from "@exocortex/shared/goals";
import * as convStore from "./conversations";
import { cancelDeferredChronoSleep } from "./chrono-service";
import { broadcastConversationHistoryUpdated, broadcastConversationUpdated } from "./conversation-events";
import { goalTimeLimitReason, updateGoalStatus } from "./goals";
import { log } from "./log";
import type { DaemonServer } from "./server";

/** setTimeout cannot wait ~25 days; longer limits re-check daily. */
const MAX_TIMER_MS = 24 * 60 * 60_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function currentGoal(convId: string) {
  return convStore.getCached(convId)?.goal ?? convStore.getIndexedSummary(convId)?.goal ?? null;
}

/** (Re)schedule the time limit of a conversation's active goal, stopping it now if already used up. */
export function scheduleGoalTimeLimit(server: DaemonServer, convId: string): void {
  clearTimeout(timers.get(convId));
  timers.delete(convId);
  const goal = currentGoal(convId);
  const remaining = goal?.status === "active" ? goalRemainingMs(goal) : null;
  if (remaining == null) return;
  if (remaining === 0) {
    stopTimedOutGoal(server, convId);
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(convId);
    scheduleGoalTimeLimit(server, convId);
  }, Math.min(remaining, MAX_TIMER_MS));
  timer.unref?.();
  timers.set(convId, timer);
}

/** Startup: schedule every active goal's time limit, stopping goals that ran out while the daemon was down. */
export function scheduleActiveGoalTimeLimits(server: DaemonServer): void {
  for (const summary of convStore.listSummaries()) {
    if (summary.goal?.status === "active" && summary.goal.maxTimeMs != null) scheduleGoalTimeLimit(server, summary.id);
  }
}

function stopTimedOutGoal(server: DaemonServer, convId: string): void {
  const goal = currentGoal(convId);
  if (!goal) return;
  const result = updateGoalStatus(convId, "blocked", "Goal time limit reached.", goalTimeLimitReason(goal));
  convStore.clearGoalContinuationAfterStream(convId);
  convStore.clearStreamHandoff(convId);
  if (cancelDeferredChronoSleep(convId)) broadcastConversationHistoryUpdated(server, convId);
  convStore.getActiveJob(convId)?.abort("goal-state-changed");
  server.sendToSubscribers(convId, { type: "goal_updated", convId, goal: result.goal, message: result.message });
  broadcastConversationUpdated(server, convId);
  log("info", `goal-time-limit: stopped goal for ${convId} after ${goal.maxTimeMs}ms of active time`);
}
