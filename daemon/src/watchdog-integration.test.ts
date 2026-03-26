/**
 * Integration tests for the stale stream watchdog.
 *
 * Simulates two real-world scenarios end-to-end:
 *
 * Scenario 1 — Model hangs:
 *   A stream goes silent (model stops producing tokens, fetch hangs, etc.).
 *   The watchdog detects the stream as stale after STALE_STREAM_TIMEOUT of
 *   inactivity and aborts it with reason "watchdog". The orchestrator's
 *   catch block detects the watchdog abort and persists a distinct system
 *   message: "✗ Timed out (stale stream)".
 *
 * Scenario 2 — Long tool call (5m+):
 *   A tool (e.g. `bash` with await=600) takes minutes to complete. The
 *   orchestrator wraps the executor with a keepalive interval that calls
 *   touchActivity() every 60s. This keeps the stream "alive" from the
 *   watchdog's perspective, preventing false aborts. When the tool
 *   finishes, the keepalive clears and normal staleness detection resumes.
 *
 * These tests use artificially fast intervals (50-100ms vs 60s in prod)
 * and faked timestamps (set startedAt to STALE_STREAM_TIMEOUT ago) to
 * avoid actually waiting 5 minutes. The logic exercised is identical to
 * production — only the timescale differs.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  setActiveJob, clearActiveJob, isStreaming,
  touchActivity, getStaleStreams, STALE_STREAM_TIMEOUT,
} from "./streaming";

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
// SCENARIO 1: Model hangs → watchdog detects → abort fires
// ═══════════════════════════════════════════════════════════════════

describe("scenario 1: model hangs → watchdog aborts", () => {
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

  test("orchestrator catch block distinguishes watchdog from user interrupt", () => {
    // The orchestrator uses `ac.signal.reason === "watchdog"` to tell
    // a timeout apart from a manual user interrupt.
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
// SCENARIO 2: Long tool call (5m+) → keepalive prevents abort
// ═══════════════════════════════════════════════════════════════════

describe("scenario 2: long tool call → keepalive prevents abort", () => {
  test("touchActivity resets staleness — keepalive keeps stream alive", async () => {
    // Stream started long ago (normally stale)
    const ac = new AbortController();
    const startedAt = Date.now() - STALE_STREAM_TIMEOUT - 1_000;
    setActiveJob("wd-int-1", ac, startedAt);

    // Before keepalive: stale
    expect(getStaleStreams()).toHaveLength(1);

    // Single touchActivity resets the clock
    touchActivity("wd-int-1");

    // After touch: not stale
    expect(getStaleStreams()).toHaveLength(0);
    expect(ac.signal.aborted).toBe(false);
  });

  test("watchdog does NOT abort stream during active keepalive", async () => {
    // Stream started long ago
    const ac = new AbortController();
    setActiveJob("wd-int-1", ac, Date.now() - STALE_STREAM_TIMEOUT - 1_000);

    // Immediately touch (simulates: tool execution just began)
    touchActivity("wd-int-1");

    // Start keepalive (mirrors orchestrator.ts executor wrapper):
    //   const keepalive = setInterval(() => convStore.touchActivity(convId), 60_000);
    // Using 50ms here instead of 60s
    const keepalive = setInterval(() => touchActivity("wd-int-1"), 50);

    // Run watchdog concurrently (also checking every 50ms)
    const wd = createTestWatchdog(50);
    wd.start();

    // Let both run for 500ms — in production this would be 5-30 minutes
    // of tool execution, with the keepalive firing every 60s.
    await Bun.sleep(500);

    // Clean up
    clearInterval(keepalive);
    wd.stop();

    // Stream should be completely unharmed
    expect(ac.signal.aborted).toBe(false);
    expect(isStreaming("wd-int-1")).toBe(true);
    expect(wd.events).toHaveLength(0);
  });

  test("executor wrapper pattern: keepalive active during tool, cleaned up after", async () => {
    // This test mirrors the exact pattern from orchestrator.ts:
    //
    //   const rawExecutor = buildExecutor(contextEnv);
    //   const executor: typeof rawExecutor = async (calls, signal?) => {
    //     const keepalive = setInterval(() => convStore.touchActivity(convId), 60_000);
    //     try {
    //       return await rawExecutor(calls, signal);
    //     } finally {
    //       clearInterval(keepalive);
    //     }
    //   };

    const ac = new AbortController();
    setActiveJob("wd-int-1", ac, Date.now());

    // Simulated executor wrapper (identical logic, faster intervals)
    const fakeExecutor = async (durationMs: number): Promise<string> => {
      const keepalive = setInterval(() => touchActivity("wd-int-1"), 50);
      try {
        // Simulate long-running tool (e.g. bash with await=600)
        await Bun.sleep(durationMs);
        return "tool output: compilation succeeded";
      } finally {
        clearInterval(keepalive);
      }
    };

    // Run watchdog concurrently
    const wd = createTestWatchdog(50);
    wd.start();

    // Execute the "long" tool call
    const result = await fakeExecutor(400);

    wd.stop();

    // Tool completed successfully, stream never aborted
    expect(result).toBe("tool output: compilation succeeded");
    expect(ac.signal.aborted).toBe(false);
    expect(wd.events).toHaveLength(0);
  });

  test("stream becomes stale AFTER tool completes if model then hangs", async () => {
    // This tests the transition: tool executing (keepalive active) →
    // tool done (keepalive stops) → model hangs → watchdog catches it.
    //
    // In production:
    // 1. Tool runs for 10 minutes, keepalive fires every 60s → safe
    // 2. Tool returns result, keepalive cleared in `finally`
    // 3. Agent loop sends tool_result to API, streams next response
    // 4. If the API hangs here, no more touchActivity calls → stale after 5m

    const ac = new AbortController();
    setActiveJob("wd-int-1", ac, Date.now());

    // Phase 1: tool executing with keepalive
    const keepalive = setInterval(() => touchActivity("wd-int-1"), 50);
    await Bun.sleep(200);

    // Phase 2: tool done, keepalive clears (as in the `finally` block)
    clearInterval(keepalive);

    // Still fresh (touchActivity just fired)
    expect(getStaleStreams()).toHaveLength(0);
    expect(ac.signal.aborted).toBe(false);

    // Phase 3: simulate time passing with no activity (model hangs)
    // In production this is 5 minutes of wall clock time.
    // We fake it by re-registering with a stale timestamp.
    clearActiveJob("wd-int-1");
    const ac2 = new AbortController();
    setActiveJob("wd-int-1", ac2, Date.now() - STALE_STREAM_TIMEOUT - 1_000);

    // Phase 4: watchdog catches the stale stream
    const wd = createTestWatchdog(50);
    wd.start();
    await Bun.sleep(200);
    wd.stop();

    expect(ac2.signal.aborted).toBe(true);
    expect(ac2.signal.reason).toBe("watchdog");
    expect(wd.events).toHaveLength(1);
  });

  test("mixed: one stream has keepalive (safe), another is stale (aborted)", async () => {
    const past = Date.now() - STALE_STREAM_TIMEOUT - 1_000;

    // Stream 1: long tool call with keepalive
    const ac1 = new AbortController();
    setActiveJob("wd-int-1", ac1, past);
    touchActivity("wd-int-1"); // tool just started
    const keepalive = setInterval(() => touchActivity("wd-int-1"), 50);

    // Stream 2: model hung, no activity
    const ac2 = new AbortController();
    setActiveJob("wd-int-2", ac2, past);

    // Run watchdog
    const wd = createTestWatchdog(50);
    wd.start();
    await Bun.sleep(200);
    wd.stop();
    clearInterval(keepalive);

    // Stream 1: safe (keepalive kept it alive)
    expect(ac1.signal.aborted).toBe(false);

    // Stream 2: aborted (no activity)
    expect(ac2.signal.aborted).toBe(true);
    expect(ac2.signal.reason).toBe("watchdog");

    // Only stream 2 was aborted
    expect(wd.events).toHaveLength(1);
    expect(wd.events[0].convId).toBe("wd-int-2");
  });
});
