import { describe, expect, test } from "bun:test";
import { normalizeConversationGoal } from "./goals";
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
  test("retains manual pause, completion, budget, and evidence", () => {
    for (const status of ["paused", "complete"] as const) {
      const goal = { ...base, status, maxTurns: 10, reason: "Current evidence." };
      expect(normalizeConversationGoal(goal)).toEqual(goal);
    }
    expect(normalizeConversationGoal(null)).toBeNull();
  });
});
