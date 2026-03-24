/**
 * Tests for the stale stream watchdog.
 *
 * Exercises the activity tracking and stale detection in streaming.ts,
 * and verifies the watchdog aborts stale streams.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  setActiveJob, clearActiveJob, isStreaming,
  touchActivity, getStaleStreams, STALE_STREAM_TIMEOUT,
} from "./streaming";

// Helper: create an AbortController, register it as an active job, return it
function startFakeStream(convId: string, startedAt = Date.now()): AbortController {
  const ac = new AbortController();
  setActiveJob(convId, ac, startedAt);
  return ac;
}

beforeEach(() => {
  // Clean up any leftover state between tests
  for (const id of ["test-1", "test-2", "test-3"]) {
    clearActiveJob(id);
  }
});

describe("touchActivity + getStaleStreams", () => {
  test("fresh stream is not stale", () => {
    startFakeStream("test-1");
    expect(getStaleStreams()).toHaveLength(0);
    clearActiveJob("test-1");
  });

  test("stream started long ago without activity is stale", () => {
    const past = Date.now() - STALE_STREAM_TIMEOUT - 1000;
    startFakeStream("test-1", past);

    const stale = getStaleStreams();
    expect(stale).toHaveLength(1);
    expect(stale[0][0]).toBe("test-1");
    expect(stale[0][2]).toBeGreaterThanOrEqual(STALE_STREAM_TIMEOUT);
    clearActiveJob("test-1");
  });

  test("touchActivity resets the staleness clock", () => {
    const past = Date.now() - STALE_STREAM_TIMEOUT - 1000;
    startFakeStream("test-1", past);
    expect(getStaleStreams()).toHaveLength(1);

    // Touch it — should no longer be stale
    touchActivity("test-1");
    expect(getStaleStreams()).toHaveLength(0);
    clearActiveJob("test-1");
  });

  test("touchActivity is a no-op for non-streaming conversations", () => {
    // Should not throw or create phantom entries
    touchActivity("nonexistent");
    expect(getStaleStreams()).toHaveLength(0);
  });

  test("multiple streams, only stale ones returned", () => {
    const past = Date.now() - STALE_STREAM_TIMEOUT - 1000;
    startFakeStream("test-1", past);      // stale
    startFakeStream("test-2");            // fresh
    startFakeStream("test-3", past);      // stale

    const stale = getStaleStreams();
    expect(stale).toHaveLength(2);
    const ids = stale.map(s => s[0]).sort();
    expect(ids).toEqual(["test-1", "test-3"]);

    clearActiveJob("test-1");
    clearActiveJob("test-2");
    clearActiveJob("test-3");
  });

  test("clearActiveJob removes activity tracking", () => {
    const past = Date.now() - STALE_STREAM_TIMEOUT - 1000;
    startFakeStream("test-1", past);
    expect(getStaleStreams()).toHaveLength(1);

    clearActiveJob("test-1");
    expect(getStaleStreams()).toHaveLength(0);
    expect(isStreaming("test-1")).toBe(false);
  });

  test("aborting a stale stream's controller works", () => {
    const past = Date.now() - STALE_STREAM_TIMEOUT - 1000;
    const ac = startFakeStream("test-1", past);

    const stale = getStaleStreams();
    expect(stale).toHaveLength(1);

    // Simulate what the watchdog does
    stale[0][1].abort();
    expect(ac.signal.aborted).toBe(true);

    clearActiveJob("test-1");
  });
});
