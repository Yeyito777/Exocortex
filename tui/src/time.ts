/**
 * Timing helpers for UI refresh scheduling.
 */

/**
 * Return the delay until the next whole elapsed-second boundary.
 *
 * Example: if a stream started 1.25s ago, this returns 750ms so the next
 * render lands on the 2s transition instead of "1 second from now".
 */
export function msUntilNextElapsedSecond(startedAt: number, now = Date.now()): number {
  const elapsed = Math.max(0, now - startedAt);
  const remainder = elapsed % 1000;
  return remainder === 0 ? 1000 : 1000 - remainder;
}
