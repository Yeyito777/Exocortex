import type { ConversationSummary, ConversationTaskSummary } from "./messages";

/** Whether a durable Chrono sleep currently suspends a conversation. */
export function isDurablySleeping(
  conversation: Pick<ConversationSummary, "streaming" | "tasks">,
): boolean {
  return !conversation.streaming && conversation.tasks?.some(
    task => task.kind === "chrono" && task.chronoMode === "sleep",
  ) === true;
}

/**
 * Whether a conversation still owns an active model turn.
 *
 * Long Chrono sleeps deliberately close the provider websocket and suspend the
 * turn, so `streaming` becomes false even though the turn has not completed.
 * This remains useful for attention and activity navigation even though the
 * sidebar renders the suspended state differently from connected streaming.
 */
export function hasInProgressModelWork(
  conversation: Pick<ConversationSummary, "streaming" | "tasks">,
): boolean {
  return conversation.streaming || isDurablySleeping(conversation);
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
