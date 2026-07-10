import type { BackgroundTaskCompletion } from "./tools/types";

function cap(text: string, maxChars: number): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function buildBackgroundTaskNotificationText(completion: BackgroundTaskCompletion): string {
  const succeeded = completion.exitCode === 0 && !completion.signal && !completion.failure;
  const status = completion.failure
    ? completion.failure
    : completion.signal
      ? `terminated by ${completion.signal}`
      : completion.exitCode === null
        ? "finished with unknown status"
        : completion.exitCode === 0
          ? "exited successfully"
          : `exited with code ${completion.exitCode}`;
  const output = completion.outputPath
    ? [
        `Output: ${completion.outputPath}`,
        "Use the read tool to inspect the full output.",
      ]
    : [
        `Output: unavailable${completion.outputError ? ` (${cap(completion.outputError, 240)})` : ""}`,
      ];

  return [
    `[notification] Background task ${succeeded ? "completed" : "failed"}: ${completion.taskId}`,
    `Command: ${cap(completion.title, 500)}`,
    `Status: ${cap(status, 240)}`,
    `Duration: ${formatDuration(completion.endedAt - completion.startedAt)}`,
    ...output,
  ].join("\n");
}
