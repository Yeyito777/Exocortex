import { describe, expect, test } from "bun:test";
import { GOAL_COMMAND } from "./goal";
import { createInitialState } from "../state";

describe("/goal command", () => {
  test("preserves the objective without interpreting ordinary words as flags", () => {
    expect(GOAL_COMMAND.handler("/goal finish  the task", createInitialState())).toEqual({
      type: "goal", action: "set", objective: "finish  the task",
    });
  });
  test("supports an optional time limit", () => {
    expect(GOAL_COMMAND.handler("/goal max-time 9h2m1s finish it", createInitialState())).toEqual({
      type: "goal", action: "set", objective: "finish it", maxTimeMs: ((9 * 60 + 2) * 60 + 1) * 1_000,
    });
    expect(GOAL_COMMAND.handler("/goal max-time 2d finish it", createInitialState())).toEqual({
      type: "goal", action: "set", objective: "finish it", maxTimeMs: 2 * 86_400_000,
    });
    expect(GOAL_COMMAND.handler("/goal max-timeout handling", createInitialState())).toEqual({
      type: "goal", action: "set", objective: "max-timeout handling",
    });
  });
  test("rejects invalid limits and removed flags instead of silently setting a goal", () => {
    for (const text of ["max-time 0m finish", "max-time nope finish", "max-time 2h", "max-time", "--max-turns 10 finish", "--max-turns=2 finish", "--unpausable finish", "unpausable/uncompletable finish", "completable=false finish"]) {
      const state = createInitialState();
      expect(GOAL_COMMAND.handler(`/goal ${text}`, state)).toEqual({ type: "handled" });
      expect(state.messages.length).toBe(1);
    }
  });
  test("provides distinct lifecycle and clear actions", () => {
    expect(GOAL_COMMAND.handler("/goal", createInitialState())).toEqual({ type: "goal", action: "show" });
    for (const action of ["pause", "resume", "complete", "clear"] as const) {
      expect(GOAL_COMMAND.handler(`/goal ${action}`, createInitialState())).toEqual({ type: "goal", action });
    }
    expect(GOAL_COMMAND.args?.map(arg => arg.name)).toContain("clear");
    expect(GOAL_COMMAND.args?.map(arg => arg.name)).not.toContain("uncompletable");
  });
});
