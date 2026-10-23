import type { CompletedConversationTask } from "../conversation-activity";

/** Shared result contract for connected and suspended Chrono waits. */
export function completedChronoWaitOutput(completed: CompletedConversationTask): string {
  return JSON.stringify({
    task_id: completed.id, status: completed.status, title: completed.title,
    ended_at: completed.endedAt,
    ...(completed.exitCode !== undefined ? { exit_code: completed.exitCode } : {}),
    ...(completed.signal !== undefined ? { signal: completed.signal } : {}),
    ...(completed.outputPath ? { output_path: completed.outputPath } : {}),
    ...(completed.failure ? { failure: completed.failure } : {}),
  }, null, 2);
}

const MAX_WAKE_TITLE_LENGTH = 120;

/** Result of a sleep that one of its conversation's own background tasks ended, connected or suspended. */
export function backgroundTaskWakeText(
  elapsed: string,
  requested: string,
  task: Pick<CompletedConversationTask, "id" | "title" | "exitCode" | "signal">,
): string {
  const title = task.title.length > MAX_WAKE_TITLE_LENGTH ? `${task.title.slice(0, MAX_WAKE_TITLE_LENGTH - 1)}…` : task.title;
  const how = task.signal ? ` (signal ${task.signal})` : typeof task.exitCode === "number" ? ` (exit code ${task.exitCode})` : "";
  return `Sleep ended after ${elapsed} because background task ${task.id} finished${how}: ${title} (requested ${requested}).`;
}
