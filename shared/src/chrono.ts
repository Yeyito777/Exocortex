import type { ConversationSummary, ConversationTaskSummary } from "./messages";

/**
 * Chrono sleeps and waits longer than this suspend the model turn: a native
 * provider turn ends and resumes by replay, while a Claude Code turn, which
 * Exocortex cannot suspend, stays open inside the call. Either way the turn is
 * sleeping rather than working.
 */
export const LONG_CHRONO_SLEEP_THRESHOLD_MS = 5 * 60 * 1_000;

/** Whether a Chrono task is the conversation's own turn sleeping or waiting. */
export function isTurnChronoSleep(task: ConversationTaskSummary): boolean {
  return task.kind === "chrono" && (task.chronoMode === "sleep" || (
    task.chronoMode === "wait" && task.id.startsWith("chrono:wait:")
  ));
}

/**
 * Start of the Chrono sleeps or waits past the suspension threshold that a
 * still streaming turn is blocked in, or null.
 *
 * Claude Code runs these inside the call because Exocortex cannot suspend its
 * turn, so the conversation keeps streaming while it is really sleeping.
 */
export function inlineLongSleepStartedAt(
  conversation: Pick<ConversationSummary, "streaming" | "tasks">,
): number | null {
  if (!conversation.streaming) return null;
  let startedAt: number | null = null;
  for (const task of conversation.tasks ?? []) {
    if (!isTurnChronoSleep(task) || task.dueAt === undefined
        || task.dueAt - task.startedAt <= LONG_CHRONO_SLEEP_THRESHOLD_MS) continue;
    startedAt = Math.min(startedAt ?? task.startedAt, task.startedAt);
  }
  return startedAt;
}
