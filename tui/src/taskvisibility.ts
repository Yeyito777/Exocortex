import type { ConversationTaskSummary } from "./messages";

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
