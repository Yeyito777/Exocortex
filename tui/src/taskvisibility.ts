import type { ConversationSummary, ConversationTaskSummary } from "./messages";

/** Return the durable sleep that currently suspends a conversation, if any. */
export function deferredChronoSleepTask(
  conversation: Pick<ConversationSummary, "streaming" | "tasks">,
): ConversationTaskSummary | null {
  if (conversation.streaming) return null;
  return conversation.tasks?.find(
    task => task.kind === "chrono" && task.chronoMode === "sleep",
  ) ?? null;
}

/**
 * Whether a conversation still owns an active model turn.
 *
 * Long Chrono sleeps deliberately close the provider websocket and suspend the
 * turn, so `streaming` becomes false even though the turn has not completed.
 * This is useful for attention/unread behavior; rendering should distinguish a
 * durable sleep from connected streaming rather than giving both a blue dot.
 */
export function hasInProgressModelWork(
  conversation: Pick<ConversationSummary, "streaming" | "tasks">,
): boolean {
  return conversation.streaming || conversation.tasks?.some(
    task => task.kind === "chrono" && task.chronoMode === "sleep",
  ) === true;
}

/**
 * Whether an active task should contribute to conversation activity UI.
 *
 * A Chrono `wait` is the current turn waiting on another task already shown in
 * the UI, so rendering both rows (and counting both badges) is redundant.
 */
export function shouldDisplayConversationTask(
  task: Pick<ConversationTaskSummary, "kind" | "chronoMode">,
): boolean {
  return task.kind !== "chrono" || task.chronoMode !== "wait";
}
