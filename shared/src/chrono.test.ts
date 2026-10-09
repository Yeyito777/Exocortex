import { describe, expect, test } from "bun:test";
import { inlineLongSleepStartedAt, LONG_CHRONO_SLEEP_THRESHOLD_MS } from "./chrono";
import type { ConversationTaskSummary } from "./messages";

const sleep = (id: string, startedAt: number, durationMs: number, chronoMode: "sleep" | "wait" = "sleep"): ConversationTaskSummary => ({
  id, kind: "chrono", title: "Sleeping", startedAt, dueAt: startedAt + durationMs, chronoMode,
});

describe("inline long Chrono sleeps", () => {
  test("only a streaming turn sleeping past the threshold counts", () => {
    const long = sleep("chrono:sleep:a", 1_000, LONG_CHRONO_SLEEP_THRESHOLD_MS + 1);
    expect(inlineLongSleepStartedAt({ streaming: true, tasks: [long] })).toBe(1_000);
    expect(inlineLongSleepStartedAt({ streaming: false, tasks: [long] })).toBeNull();
    expect(inlineLongSleepStartedAt({ streaming: true, tasks: [sleep("chrono:sleep:b", 1_000, LONG_CHRONO_SLEEP_THRESHOLD_MS)] })).toBeNull();
    expect(inlineLongSleepStartedAt({ streaming: true, tasks: [
      { id: "chrono:wake", kind: "chrono", title: "Wake", startedAt: 0, dueAt: 3_600_000, chronoMode: "wake" },
      { id: "bash:1", kind: "background", title: "build", startedAt: 0 },
    ] })).toBeNull();
  });

  test("overlapping sleeps and waits are one stretch from the earliest start", () => {
    expect(inlineLongSleepStartedAt({ streaming: true, tasks: [
      sleep("chrono:sleep:later", 9_000, 20 * 60_000),
      sleep("chrono:wait:earlier", 4_000, 20 * 60_000, "wait"),
    ] })).toBe(4_000);
  });
});
