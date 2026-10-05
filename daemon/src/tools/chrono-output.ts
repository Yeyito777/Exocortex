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
