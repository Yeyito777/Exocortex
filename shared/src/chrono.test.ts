import { describe, expect, test } from "bun:test";
import { CHRONO_WHAT_MAX_CHARS, chronoCallLine, chronoCallLineText, chronoWhat, formatChronoProgress, formatChronoSpan, inlineLongSleepStartedAt, LONG_CHRONO_SLEEP_THRESHOLD_MS, msUntilChronoProgressChange, queuedInputEndsChronoSleep } from "./chrono";
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

describe("queued input during a Chrono sleep or wait", () => {
  const short = sleep("chrono:sleep:s", 0, 60_000);
  const longWait = sleep("chrono:wait:w", 0, LONG_CHRONO_SLEEP_THRESHOLD_MS + 1, "wait");
  const person = (timing: "next-turn" | "message-end") => ({ timing });
  const automated = (timing: "next-turn" | "message-end") => ({ timing, automation: { kind: "chrono_wake" } });

  test("a person's next-turn input ends any sleep or wait; their message-end input waits for the turn", () => {
    for (const task of [short, longWait]) {
      expect(queuedInputEndsChronoSleep({ streaming: true, tasks: [task] }, person("next-turn"))).toBe(true);
      expect(queuedInputEndsChronoSleep({ streaming: true, tasks: [task] }, person("message-end"))).toBe(false);
    }
  });

  test("automated input ends only a long one, whatever its timing", () => {
    for (const timing of ["next-turn", "message-end"] as const) {
      expect(queuedInputEndsChronoSleep({ streaming: true, tasks: [longWait] }, automated(timing))).toBe(true);
      expect(queuedInputEndsChronoSleep({ streaming: true, tasks: [short] }, automated(timing))).toBe(false);
    }
  });

  test("a turn not in a sleep, or not streaming, takes nothing at once", () => {
    expect(queuedInputEndsChronoSleep({ streaming: true, tasks: [{ id: "bash:1", kind: "background", title: "build", startedAt: 0 }] }, person("next-turn"))).toBe(false);
    expect(queuedInputEndsChronoSleep({ streaming: false, tasks: [longWait] }, person("next-turn"))).toBe(false);
  });
});

describe("Chrono call lines", () => {
  const id = "1794036663304-sr0sel";

  test("what is kept on one line, cut when long, and dropped when it only repeats the target", () => {
    expect(chronoWhat({ what: "  arm A\n price-move   research agent " })).toBe("arm A price-move research agent");
    expect(chronoWhat({ what: "x".repeat(200) })).toBe(`${"x".repeat(CHRONO_WHAT_MAX_CHARS - 1)}…`);
    for (const what of [undefined, 42, "", "  ", id, `task ${id}`, `waiting on ${id}`, "the subagent", "pm5-batch-x"]) {
      expect(chronoWhat({ task_id: what === "pm5-batch-x" ? "unit:pm5-batch-x" : id, what })).toBeNull();
    }
    expect(chronoWhat({ task_id: id, what: `agent ${id} for arm A` })).toBe(`agent ${id} for arm A`);
  });

  test("spans show their two largest units", () => {
    expect(formatChronoSpan(45 * 60_000)).toBe("45m");
    expect(formatChronoSpan(2.5 * 3_600_000)).toBe("2h 30m");
    expect(formatChronoSpan(3_600_000 + 20_000)).toBe("1h");
    expect(formatChronoSpan(80_000)).toBe("1m 20s");
    expect(formatChronoSpan(30_000)).toBe("30s");
    expect(formatChronoSpan(86_400_000 + 7_200_000)).toBe("1d 2h");
    expect(formatChronoSpan(59_000, "m")).toBe("0m");
    expect(formatChronoSpan(12.9 * 60_000, "m")).toBe("12m");
  });

  test("progress counts whole minutes, or seconds when short, and says when it next changes", () => {
    const startedAt = 1_000_000;
    const long = { startedAt, dueAt: startedAt + 45 * 60_000 };
    expect(formatChronoProgress({ ...long, now: startedAt + 12 * 60_000 + 59_000 })).toBe("12m of 45m");
    expect(formatChronoProgress({ ...long, now: startedAt + 50 * 60_000 })).toBe("45m of 45m");
    expect(msUntilChronoProgressChange({ ...long, now: startedAt + 12 * 60_000 + 59_000 })).toBe(1_000);
    expect(msUntilChronoProgressChange({ ...long, now: startedAt })).toBe(60_000);
    expect(msUntilChronoProgressChange({ ...long, now: long.dueAt })).toBeNull();
    const short = { startedAt, dueAt: startedAt + 90_000 };
    expect(formatChronoProgress({ ...short, now: startedAt + 12_400 })).toBe("12s of 1m 30s");
    expect(msUntilChronoProgressChange({ ...short, now: startedAt + 12_400 })).toBe(600);
    expect(msUntilChronoProgressChange({ ...short, now: short.dueAt - 300 })).toBe(300);
  });

  test("waits and sleeps read as what they wait on, falling back to the resolved subject, unit, then id", () => {
    const wait = { action: "wait", task_id: id, max_wait: "45m" };
    expect(chronoCallLine({ ...wait, what: "arm A research" })).toEqual({ head: "wait: ", what: "arm A research", meta: "up to 45m" });
    expect(chronoCallLine({ ...wait, what: id }, { subject: "arm A research" })?.what).toBe("arm A research");
    expect(chronoCallLine(wait)?.what).toBe(id);
    expect(chronoCallLine({ ...wait, task_id: "unit:pm5-batch-x" })?.what).toBe("pm5-batch-x");
    const progress = { startedAt: 0, dueAt: 45 * 60_000, now: 12 * 60_000 };
    expect(chronoCallLine({ ...wait, what: "arm A research" }, { progress }))
      .toEqual({ head: "waiting on ", what: "arm A research", meta: "12m of 45m" });

    const sleep = { action: "sleep", duration: "5m" };
    expect(chronoCallLineText(chronoCallLine({ ...sleep, what: "letting the replay warm up" })!)).toBe("sleep: letting the replay warm up · 5m");
    expect(chronoCallLineText(chronoCallLine(sleep)!)).toBe("sleep: 5m");
    expect(chronoCallLineText(chronoCallLine(sleep, { progress: { startedAt: 0, dueAt: 300_000, now: 120_000 } })!)).toBe("sleeping · 2m of 5m");
    expect(chronoCallLine({ action: "wake" })).toBeNull();
  });
});
