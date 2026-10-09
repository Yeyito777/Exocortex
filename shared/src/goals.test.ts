import { describe, expect, test } from "bun:test";
import { applyGoalStatus, formatGoalDuration, goalActiveMs, goalRemainingMs, normalizeConversationGoal, parseGoalDuration } from "./goals";
import type { ConversationGoal } from "./messages";

const base: ConversationGoal = {
  objective: "Ship the change", status: "active", createdAt: 1, updatedAt: 2, turns: 4,
};

describe("goal persistence compatibility", () => {
  test("migrates controller pauses to blocked without mutating the saved input", () => {
    const old: ConversationGoal = { ...base, status: "paused", pausedBy: "controller", pauseReason: "Need credentials.", pausable: false, completable: false };
    expect(normalizeConversationGoal(old)).toEqual({ ...base, status: "blocked", reason: "Need credentials." });
    expect(old.pausedBy).toBe("controller");
  });
  test("retains manual pause, completion, time limit, and evidence", () => {
    for (const status of ["paused", "complete"] as const) {
      const goal = { ...base, status, maxTimeMs: 60_000, activeMs: 5_000, reason: "Current evidence." };
      expect(normalizeConversationGoal(goal)).toEqual(goal);
    }
    expect(normalizeConversationGoal(null)).toBeNull();
  });
  test("drops the removed turn budget", () => {
    expect(normalizeConversationGoal({ ...base, maxTurns: 10 })).toEqual(base);
  });
});

describe("goal time limits", () => {
  test("parses compact durations", () => {
    expect(parseGoalDuration("9h2m1s")).toBe(((9 * 60 + 2) * 60 + 1) * 1_000);
    expect(parseGoalDuration("8h3m")).toBe((8 * 60 + 3) * 60_000);
    expect(parseGoalDuration("1h")).toBe(3_600_000);
    expect(parseGoalDuration("5m")).toBe(300_000);
    expect(parseGoalDuration("2d")).toBe(2 * 86_400_000);
    expect(parseGoalDuration("1d12h")).toBe(36 * 3_600_000);
    expect(parseGoalDuration("90s")).toBe(90_000);
    for (const text of ["", "0m", "0h0m", "5", "m", "1m2h", "1h 2m", "1.5h", "-1h", "1w", "1h1h"]) {
      expect(parseGoalDuration(text)).toBeNull();
    }
  });
  test("formats durations in the same style", () => {
    expect(formatGoalDuration(((9 * 60 + 2) * 60 + 1) * 1_000)).toBe("9h2m1s");
    expect(formatGoalDuration(2 * 86_400_000 + 3_600_000)).toBe("2d1h");
    expect(formatGoalDuration(999)).toBe("0s");
    expect(formatGoalDuration(-5)).toBe("0s");
  });
  test("counts only active periods", () => {
    const goal: ConversationGoal = { ...base, maxTimeMs: 10_000, activeMs: 0, activeSince: 1_000 };
    expect(goalActiveMs(goal, 4_000)).toBe(3_000);
    applyGoalStatus(goal, "paused", "Paused by user.", 4_000);
    expect(goal).toMatchObject({ status: "paused", activeMs: 3_000, reason: "Paused by user.", updatedAt: 4_000 });
    expect(goal.activeSince).toBeUndefined();
    expect(goalRemainingMs(goal, 100_000)).toBe(7_000);
    applyGoalStatus(goal, "active", undefined, 50_000);
    expect(goal).toMatchObject({ status: "active", activeSince: 50_000, emptyTurns: 0 });
    expect(goal.reason).toBeUndefined();
    applyGoalStatus(goal, "active", undefined, 51_000);
    expect(goal.activeSince).toBe(50_000);
    expect(goalRemainingMs(goal, 58_000)).toBe(0);
    expect(goalRemainingMs({ ...base }, 58_000)).toBeNull();
  });
});
