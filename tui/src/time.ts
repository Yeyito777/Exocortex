/**
 * Time helpers for UI refresh scheduling and timestamp display.
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

/** Format time remaining as whole hours and minutes, rounding up to avoid understating it. */
export function formatHoursMinutesUntil(dueAt: number, now = Date.now()): string {
  const totalMinutes = Math.max(0, Math.ceil((dueAt - now) / 60_000));
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/** Return the delay until a rounded-up hours/minutes countdown can change. */
export function msUntilHoursMinutesUpdate(dueAt: number, now = Date.now()): number | null {
  const remainingMs = dueAt - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const remainder = remainingMs % 60_000;
  return remainder === 0 ? 60_000 : remainder;
}

/** Format a timestamp for display in system notices and metadata. */
export function formatTimestamp(timestamp: number, locale = "en-US"): string {
  return new Date(timestamp).toLocaleString(locale);
}
