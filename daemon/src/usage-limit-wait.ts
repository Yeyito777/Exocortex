/** Usage refusals are scheduling events, not terminal turn failures. */
import { createAbortError } from "./abort";
import { STEER_PREEMPTION_REASON, StreamPreemptedError, type RetryableStreamAbortController } from "./watchdog-retry";

export function isUsageLimitError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  // A Claude turn's API credits ran out: wait for another key or a subscription like any limit.
  if (error.name === "ApiCreditExhaustedError") return true;
  return /you['’]ve hit your .*limit|usage.limit.reached|usage limit|rate.limit|API error[: ]*\(?429\b|HTTP 429/i.test(error.message);
}

/** Claude's daily reset hint includes its timezone, not necessarily the daemon's. */
export function claudeDailyReset(message: string, now = Date.now()): number | null {
  const match = /\bresets (\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(message);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const wanted = (hour % 12 + (match[3].toLowerCase() === "pm" ? 12 : 0)) * 60 + minute;
  try {
    const format = new Intl.DateTimeFormat("en-GB", { timeZone: match[4], hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    // Enumerating UTC minutes also handles DST gaps and repeated local hours.
    for (let at = Math.floor(now / 60_000) * 60_000 + 60_000; at <= now + 26 * 3_600_000; at += 60_000) {
      const [h, m] = format.format(at).split(":").map(Number);
      if (h * 60 + m === wanted) return at;
    }
  } catch { /* An unknown timezone is an unknown reset, not a turn failure. */ }
  return null;
}

export interface UsageAvailability {
  ready: boolean;
  resetAt: number | null;
}

/** The live messages array and callbacks belong to the caller, as with outage recovery. */
export async function runWithUsageLimitWait<T>(
  controller: RetryableStreamAbortController,
  operation: () => Promise<T>,
  availability: () => UsageAvailability,
  hooks: { start(resetAt: number | null): void; end(): void },
  options: { probeMs?: number; retryFloorMs?: number; shouldRetry?: (error: unknown) => boolean } = {},
): Promise<T> {
  const probeMs = options.probeMs ?? 30_000;
  const retryFloorMs = options.retryFloorMs ?? 1_000;
  let lastAttempt = 0;
  let refused = false;
  // One shown wait per stretch of waiting, not one per probe: restarting it
  // would reset its "waiting since" time and flicker the status every probe.
  let waiting = false;
  const endWait = () => {
    if (!waiting) return;
    waiting = false;
    hooks.end();
  };
  try {
    while (true) {
      if (controller.signal.aborted) throw createAbortError();
      const state = availability();
      const cooldown = refused ? Math.max(0, lastAttempt + retryFloorMs - Date.now()) : 0;
      if (!state.ready || cooldown > 0) {
        if (!waiting) {
          waiting = true;
          hooks.start(state.resetAt);
        }
        const slot = new AbortController();
        const abort = () => slot.abort(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
        controller.setAttempt(slot, true);
        try {
          const untilReset = state.resetAt == null ? probeMs : Math.max(retryFloorMs, state.resetAt - Date.now());
          await new Promise<void>((resolve, reject) => {
            if (slot.signal.aborted) { reject(createAbortError()); return; }
            const timer = setTimeout(() => {
              slot.signal.removeEventListener("abort", cancel);
              resolve();
            }, cooldown || Math.min(probeMs, untilReset));
            const cancel = () => { clearTimeout(timer); reject(createAbortError()); };
            slot.signal.addEventListener("abort", cancel, { once: true });
          });
        } catch (error) {
          if (!controller.signal.aborted && slot.signal.reason === STEER_PREEMPTION_REASON) throw new StreamPreemptedError();
          throw error;
        } finally {
          controller.clearAttempt(slot);
          controller.signal.removeEventListener("abort", abort);
        }
        continue;
      }
      endWait();
      lastAttempt = Date.now();
      try {
        return await operation();
      } catch (error) {
        if (controller.signal.aborted || !(options.shouldRetry ?? isUsageLimitError)(error)) throw error;
        refused = true;
      }
    }
  } finally {
    endWait();
  }
}
