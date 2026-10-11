/**
 * Delay before the TUI's next daemon reconnect attempt after a failed one.
 *
 * A local attempt is a socket existence check plus connect, so retry briskly
 * for the first few seconds: a graceful daemon restart is usually back within
 * one or two seconds, and a fixed one-second step added up to a full second of
 * perceived downtime. SSH attempts spawn a process each time; keep them slow.
 */
export const FAST_LOCAL_RECONNECT_MS = 50;
export const FAST_LOCAL_RECONNECT_ATTEMPTS = 100;
export const SLOW_RECONNECT_MS = 1000;

export function reconnectDelayMs(failedAttempts: number, remote: boolean): number {
  if (!remote && failedAttempts < FAST_LOCAL_RECONNECT_ATTEMPTS) return FAST_LOCAL_RECONNECT_MS;
  return SLOW_RECONNECT_MS;
}
