/**
 * Abort/cancellation helpers shared across daemon modules.
 */

/** Construct a standard AbortError across runtimes. */
export function createAbortError(message = "Aborted"): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException(message, "AbortError");
  }
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

/**
 * Best-effort detection for abort-like failures from fetch/streams.
 *
 * Prefer checking `signal.aborted` when available. This helper exists for
 * runtime/provider inconsistencies where the thrown error shape varies.
 */
export function isAbortLikeError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  return /\babort(?:ed|ing)?\b/i.test(err.message);
}

export const DAEMON_RESTART_TOOL_INTERRUPTED_MESSAGE =
  "Tool interrupted because the Exocortex daemon restarted. The tool call may have partially or fully completed before interruption; inspect current state and continue from there.";

/** Format the tool-result payload for cooperative tool cancellation. */
export function formatToolAbortMessage(signal: AbortSignal | undefined, elapsedSeconds: string): string {
  if (signal?.reason === "watchdog") {
    return `Watchdog timed out after ${elapsedSeconds}s (stream was inactive too long).`;
  }
  if (signal?.reason === "daemon-restart") {
    return DAEMON_RESTART_TOOL_INTERRUPTED_MESSAGE;
  }
  return `User interrupted after ${elapsedSeconds}s of execution.`;
}
