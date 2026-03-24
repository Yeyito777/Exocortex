/**
 * Stale stream watchdog for exocortexd.
 *
 * Periodically scans active streams and aborts any that have been
 * inactive for longer than STALE_STREAM_TIMEOUT. This catches all
 * failure modes where a stream's promise silently hangs — network
 * partitions, stalled fetch() calls, tool execution hangs, Bun
 * runtime edge cases, etc.
 *
 * The abort fires the AbortController, which propagates through the
 * agent loop → orchestrator catch block → finally block, triggering
 * normal cleanup (persist partial content, drain queued messages).
 */

import { getStaleStreams, STALE_STREAM_TIMEOUT } from "./streaming";
import { log } from "./log";

/** How often the watchdog checks for stale streams. */
const CHECK_INTERVAL = 60_000; // 1 minute

let timer: ReturnType<typeof setInterval> | null = null;

export function startWatchdog(): void {
  if (timer) return;
  timer = setInterval(() => {
    const stale = getStaleStreams();
    for (const [convId, ac, inactiveMs] of stale) {
      const inactiveSec = Math.round(inactiveMs / 1000);
      log("warn", `watchdog: aborting stale stream for ${convId} (inactive ${inactiveSec}s, threshold ${STALE_STREAM_TIMEOUT / 1000}s)`);
      ac.abort();
    }
  }, CHECK_INTERVAL);
  // Don't keep the process alive just for the watchdog
  timer.unref();
  log("info", `watchdog: started (check every ${CHECK_INTERVAL / 1000}s, stale threshold ${STALE_STREAM_TIMEOUT / 1000}s)`);
}

export function stopWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
