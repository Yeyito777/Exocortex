/**
 * Integration tests for the stale stream watchdog.
 *
 * Simulates two real-world scenarios end-to-end:
 *
 * Scenario 1 — Model hangs:
 *   A stream goes silent (model stops producing tokens, fetch hangs, etc.).
 *   The watchdog detects the stream as stale after STALE_STREAM_TIMEOUT and
 *   interrupts the current provider attempt. Production turns route that
 *   interruption through the eight-retry stale-stream wrapper; plain active-job
 *   controllers retain the terminal watchdog-abort fallback tested below.
 *
 * Scenario 2 — Long tool call (5m+):
 *   A tool (e.g. `bash` with await=600) takes minutes to complete. The
 *   orchestrator pauses staleness tracking before tool execution and
 *   resumes it after. The watchdog ignores paused streams entirely —
 *   tools can run for hours. When the tool finishes, resumeActivity()
 *   resets the clock and normal staleness detection resumes.
 *
 * These tests use artificially fast intervals (50-100ms vs 60s in prod)
 * and faked timestamps (set startedAt to STALE_STREAM_TIMEOUT ago) to
 * avoid actually waiting 5 minutes. The logic exercised is identical to
 * production — only the timescale differs.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  setActiveJob, clearActiveJob, isStreaming,
  touchActivity, pauseActivity, resumeActivity,
  getStaleStreams, STALE_STREAM_TIMEOUT,
} from "./streaming";
import { RetryableStreamAbortController, runWithStaleStreamRetries } from "./watchdog-retry";

// ── Fast watchdog for testing ─────────────────────────────────────
// Mirrors the real watchdog (watchdog.ts) but with configurable check
// intervals and an event log so tests can inspect what happened.

interface WatchdogEvent {
  convId: string;
  inactiveMs: number;
  timestamp: number;
}

function createTestWatchdog(checkMs: number) {
  let timer: ReturnType<typeof setInterval> | null = null;
  const events: WatchdogEvent[] = [];

  return {
    start() {
      timer = setInterval(() => {
        for (const [convId, ac, inactiveMs] of getStaleStreams()) {
          // Skip already-aborted controllers — in production the
          // orchestrator's finally block calls clearActiveJob() almost
          // immediately after abort, so the stream disappears from
          // activeJobs before the next watchdog tick. In tests with
          // fast intervals and no orchestrator, the stream lingers.
          if (ac.signal.aborted) continue;
          ac.abort("watchdog");
          events.push({ convId, inactiveMs, timestamp: Date.now() });
        }
      }, checkMs);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    get events() { return events; },
  };
}

// ── Helpers ────────────────────────────────────────────────────────

const TEST_IDS = ["wd-int-1", "wd-int-2"];

beforeEach(() => { for (const id of TEST_IDS) clearActiveJob(id); });
afterEach(() => { for (const id of TEST_IDS) clearActiveJob(id); });

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 1: Model hangs → watchdog detects → retry or terminal fallback
// ═══════════════════════════════════════════════════════════════════

describe("scenario 1: model hangs → watchdog recovery and fallback", () => {
  test("production controller turns the watchdog abort into a provider retry", async () => {
    const ac = new RetryableStreamAbortController();
    setActiveJob("wd-int-1", ac, Date.now() - STALE_STREAM_TIMEOUT - 1_000);
    let calls = 0;
    let startedFirstAttempt!: () => void;
    const firstAttemptStarted = new Promise<void>((resolve) => { startedFirstAttempt = resolve; });

    const resultPromise = runWithStaleStreamRetries(
      ac,
      { onText: () => {}, onThinking: () => {}, onRetry: () => touchActivity("wd-int-1") },
      (signal) => {
        calls += 1;
        if (calls > 1) return Promise.resolve("recovered");
        startedFirstAttempt();
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          }, { once: true });
        });
      },
      { retryDelayMs: () => 0 },
    );

    await firstAttemptStarted;
    const stale = getStaleStreams();
    expect(stale).toHaveLength(1);
    stale[0][1].abort("watchdog");

    await expect(resultPromise).resolves.toBe("recovered");
    expect(calls).toBe(2);
    expect(ac.signal.aborted).toBe(false);
    expect(getStaleStreams()).toHaveLength(0);
  });

  test("watchdog detects stale stream and fires abort", async () => {
    // Simulate: stream started STALE_STREAM_TIMEOUT + 1s ago, zero activity since.
    // This is what happens when the model or network silently hangs.
    const ac = new AbortController();
    const startedAt = Date.now() - STALE_STREAM_TIMEOUT - 1_000;
    setActiveJob("wd-int-1", ac, startedAt);

    // Pre-condition: the stream is registered and stale
    expect(isStreaming("wd-int-1")).toBe(true);
    expect(getStaleStreams()).toHaveLength(1);
    expect(ac.signal.aborted).toBe(false);

    // Start a fast watchdog (checks every 50ms instead of 60s)
    const wd = createTestWatchdog(50);
    wd.start();

    // Give it a few cycles to detect and abort
    await Bun.sleep(200);
    wd.stop();

    // The watchdog should have aborted the stream with reason "watchdog"
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBe("watchdog");

    // Exactly one abort event should be logged
    expect(wd.events).toHaveLength(1);
    expect(wd.events[0].convId).toBe("wd-int-1");
    expect(wd.events[0].inactiveMs).toBeGreaterThanOrEqual(STALE_STREAM_TIMEOUT);
  });

  test("abort propagates to a hung promise (simulates stalled fetch)", async () => {
    // In production, streamMessage() awaits fetch() which awaits the SSE
    // reader. If the network partitions, that promise hangs forever.
    // The watchdog's abort propagates through the AbortController signal.
    const ac = new AbortController();
    setActiveJob("wd-int-1", ac, Date.now() - STALE_STREAM_TIMEOUT - 1_000);

    // Simulate a fetch-like promise that blocks until the signal fires
    const hungFetch = new Promise<never>((_, reject) => {
      ac.signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      });
    });

    // Watchdog aborts it
    const stale = getStaleStreams();
    stale[0][1].abort("watchdog");

    // The hung promise rejects — this is how the agent loop unblocks
    await expect(hungFetch).rejects.toThrow("The operation was aborted");
    expect(ac.signal.aborted).toBe(true);
  });

  test("terminal fallback distinguishes watchdog from user interrupt", () => {
    // Outside a retryable provider attempt, the orchestrator uses
    // `ac.signal.reason === "watchdog"` to tell a timeout apart from a manual
    // user interrupt.
    //
    // This test exercises the exact logic from orchestrator.ts:
    //   const isAbort = ac.signal.aborted;
    //   const isWatchdog = isAbort && ac.signal.reason === "watchdog";

    // Case A: watchdog abort
    const acWatchdog = new AbortController();
    acWatchdog.abort("watchdog");
    expect(acWatchdog.signal.aborted).toBe(true);
    expect(acWatchdog.signal.reason).toBe("watchdog");

    const isWatchdog = acWatchdog.signal.aborted && acWatchdog.signal.reason === "watchdog";
    expect(isWatchdog).toBe(true);

    // This is the system message that gets persisted:
    expect(isWatchdog ? "✗ Timed out (stale stream)" : "✗ Interrupted")
      .toBe("✗ Timed out (stale stream)");

    // Case B: user interrupt (no reason, or reason is undefined)
    const acUser = new AbortController();
    acUser.abort();
    expect(acUser.signal.aborted).toBe(true);

    const isUserWatchdog = acUser.signal.aborted && acUser.signal.reason === "watchdog";
    expect(isUserWatchdog).toBe(false);
  });

  test("fresh stream is not aborted (watchdog only catches stale ones)", async () => {
    // A stream that just started should never be aborted, even with
    // the watchdog running aggressively.
    const ac = new AbortController();
    setActiveJob("wd-int-1", ac, Date.now()); // just now

    const wd = createTestWatchdog(50);
    wd.start();
    await Bun.sleep(300);
    wd.stop();

    expect(ac.signal.aborted).toBe(false);
    expect(wd.events).toHaveLength(0);
  });

  test("multiple stale streams are all aborted in one sweep", async () => {
    const past = Date.now() - STALE_STREAM_TIMEOUT - 1_000;
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    setActiveJob("wd-int-1", ac1, past);
    setActiveJob("wd-int-2", ac2, past);

    const wd = createTestWatchdog(50);
    wd.start();
    await Bun.sleep(200);
    wd.stop();

    expect(ac1.signal.aborted).toBe(true);
    expect(ac1.signal.reason).toBe("watchdog");
    expect(ac2.signal.aborted).toBe(true);
    expect(ac2.signal.reason).toBe("watchdog");

    const abortedIds = wd.events.map(e => e.convId).sort();
    expect(abortedIds).toEqual(["wd-int-1", "wd-int-2"]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO 2: Long tool call → pause/resume makes watchdog ignore it
// ═══════════════════════════════════════════════════════════════════

describe("scenario 2: long tool call → paused stream is invisible to watchdog", () => {
  test("pauseActivity makes a stale stream invisible to getStaleStreams", () => {
    const ac = new AbortController();
    const past = Date.now() - STALE_STREAM_TIMEOUT - 1_000;
    setActiveJob("wd-int-1", ac, past);

    // Stale before pause
    expect(getStaleStreams()).toHaveLength(1);

    // Pause — stream disappears from stale list
    pauseActivity("wd-int-1");
    expect(getStaleStreams()).toHaveLength(0);
  });

  test("resumeActivity restores tracking with a fresh clock", () => {
    const ac = new AbortController();
    const past = Date.now() - STALE_STREAM_TIMEOUT - 1_000;
    setActiveJob("wd-int-1", ac, past);

    pauseActivity("wd-int-1");
    expect(getStaleStreams()).toHaveLength(0);

    // Resume resets the activity timestamp — stream is fresh, not stale
    resumeActivity("wd-int-1");
    expect(getStaleStreams()).toHaveLength(0);
  });

  test("watchdog does NOT abort a paused stream (tool executing for hours)", async () => {
    // Stream started long ago — would be stale without pause
    const ac = new AbortController();
    const past = Date.now() - STALE_STREAM_TIMEOUT - 1_000;
    setActiveJob("wd-int-1", ac, past);

    // Pause (tool execution begins)
    pauseActivity("wd-int-1");

    // Run watchdog aggressively
    const wd = createTestWatchdog(50);
    wd.start();
    await Bun.sleep(500);
    wd.stop();

    // Stream untouched — watchdog skipped it entirely
    expect(ac.signal.aborted).toBe(false);
    expect(wd.events).toHaveLength(0);
  });

  test("executor wrapper pattern: pause during tool, resume after", async () => {
    // Mirrors the exact pattern from orchestrator.ts:
    //
    //   const executor: typeof rawExecutor = async (calls, signal?) => {
    //     convStore.pauseActivity(convId);
    //     try {
    //       return await rawExecutor(calls, signal);
    //     } finally {
    //       convStore.resumeActivity(convId);
    //     }
    //   };

    const ac = new AbortController();
    setActiveJob("wd-int-1", ac, Date.now());

    const fakeExecutor = async (durationMs: number): Promise<string> => {
      pauseActivity("wd-int-1");
      try {
        await Bun.sleep(durationMs);
        return "tool output: compilation succeeded";
      } finally {
        resumeActivity("wd-int-1");
      }
    };

    // Run watchdog concurrently
    const wd = createTestWatchdog(50);
    wd.start();

    const result = await fakeExecutor(400);

    wd.stop();

    expect(result).toBe("tool output: compilation succeeded");
    expect(ac.signal.aborted).toBe(false);
    expect(wd.events).toHaveLength(0);
  });

  test("stream becomes stale AFTER tool completes if model then hangs", async () => {
    // Tool executing (paused) → tool done (resumed) → model hangs → caught
    const ac = new AbortController();
    setActiveJob("wd-int-1", ac, Date.now());

    // Phase 1: tool executing — paused
    pauseActivity("wd-int-1");
    await Bun.sleep(200);

    // Phase 2: tool done — resumed (clock reset)
    resumeActivity("wd-int-1");
    expect(getStaleStreams()).toHaveLength(0);

    // Phase 3: model hangs — simulate elapsed time
    clearActiveJob("wd-int-1");
    const ac2 = new AbortController();
    setActiveJob("wd-int-1", ac2, Date.now() - STALE_STREAM_TIMEOUT - 1_000);

    // Phase 4: watchdog catches it
    const wd = createTestWatchdog(50);
    wd.start();
    await Bun.sleep(200);
    wd.stop();

    expect(ac2.signal.aborted).toBe(true);
    expect(ac2.signal.reason).toBe("watchdog");
    expect(wd.events).toHaveLength(1);
  });

  test("mixed: one stream paused (tool running), another stale (model hung)", async () => {
    const past = Date.now() - STALE_STREAM_TIMEOUT - 1_000;

    // Stream 1: tool executing (paused)
    const ac1 = new AbortController();
    setActiveJob("wd-int-1", ac1, past);
    pauseActivity("wd-int-1");

    // Stream 2: model hung (not paused)
    const ac2 = new AbortController();
    setActiveJob("wd-int-2", ac2, past);

    // Run watchdog
    const wd = createTestWatchdog(50);
    wd.start();
    await Bun.sleep(200);
    wd.stop();

    // Stream 1: safe (paused — watchdog ignored it)
    expect(ac1.signal.aborted).toBe(false);

    // Stream 2: aborted (stale, not paused)
    expect(ac2.signal.aborted).toBe(true);
    expect(ac2.signal.reason).toBe("watchdog");

    expect(wd.events).toHaveLength(1);
    expect(wd.events[0].convId).toBe("wd-int-2");
  });
});
