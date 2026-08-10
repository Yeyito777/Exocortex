import type { ConversationSummary, ConversationTaskSummary } from "./messages";

/**
 * Whether a conversation should retain the blue in-progress indicator.
 *
 * Long Chrono sleeps deliberately close the provider websocket and suspend the
 * turn, so `streaming` becomes false. The sleep is still active model work and
 * should remain visually indistinguishable from a short, connected sleep.
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
