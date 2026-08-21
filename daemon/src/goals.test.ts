import { afterEach, describe, expect, test } from "bun:test";
import { create, get, remove } from "./conversations";
import { DEFAULT_EFFORT } from "./messages";
import {
  applyGoalControllerAction,
  applyUserGoalAction,
  goalCanComplete,
  goalCanPause,
  goalPermissionFlagSuffix,
  setGoal,
} from "./goals";
import { goal as goalTool } from "./tools/goal";

const IDS: string[] = [];

function makeConversation(suffix: string): string {
  const id = `goals-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  create(id, "openai", "gpt-5.5", suffix, DEFAULT_EFFORT, false, null);
  expect(get(id)).toBeTruthy();
  return id;
}

afterEach(() => {
  for (const id of IDS.splice(0)) remove(id);
});

describe("goal tool schema", () => {
  test("ordinary conversations can only set goals", () => {
    expect(goalTool.inputSchema).toMatchObject({
      properties: {
        objective: { type: "string" },
        pausable: { type: "boolean" },
        completable: { type: "boolean" },
      },
      required: ["objective"],
    });
    expect((goalTool.inputSchema.properties as Record<string, unknown>).action).toBeUndefined();
    expect((goalTool.inputSchema.properties as Record<string, unknown>).reason).toBeUndefined();
  });

  test("summarizes disabled controller permissions as CLI-style flags", () => {
    expect(goalTool.summarize({
      objective: "Continue assisting the user until instructed otherwise.",
      pausable: false,
      completable: false,
    })).toEqual({
      label: "Goal",
      detail: "set: Continue assisting the user until instructed otherwise. --unpausable --uncompletable",
    });
  });
});

describe("goal permissions", () => {
  test("defaults allow controller pause and complete", () => {
    const convId = makeConversation("defaults");
    const result = setGoal(convId, "finish everything");

    expect(result.ok).toBe(true);
    expect(result.goal).toMatchObject({ pausable: true, completable: true });
    expect(result.message).toBe("Goal set: finish everything");
    expect(goalCanPause(result.goal)).toBe(true);
    expect(goalCanComplete(result.goal)).toBe(true);
  });

  test("completable=false forces pausable=false", () => {
    const convId = makeConversation("no-complete");
    const result = setGoal(convId, "keep going", { pausable: true, completable: false });

    expect(result.ok).toBe(true);
    expect(result.goal).toMatchObject({ pausable: false, completable: false });
    expect(result.message).toBe("Goal set: keep going --unpausable --uncompletable");
    expect(goalCanPause(result.goal)).toBe(false);
    expect(goalCanComplete(result.goal)).toBe(false);
  });

  test("controller cannot pause or complete when the corresponding permission is disabled", () => {
    const pauseLockedId = makeConversation("pause-locked");
    setGoal(pauseLockedId, "do not pause", { pausable: false });

    expect(applyGoalControllerAction(pauseLockedId, "pause", "need input")).toMatchObject({
      ok: false,
      message: "This goal cannot be paused.",
    });
    expect(applyGoalControllerAction(pauseLockedId, "complete", "done")).toMatchObject({
      ok: true,
      goal: null,
    });

    const completeLockedId = makeConversation("complete-locked");
    setGoal(completeLockedId, "do not complete", { completable: false });
    expect(applyGoalControllerAction(completeLockedId, "pause", "blocked")).toMatchObject({
      ok: false,
      message: "This goal cannot be paused.",
    });
    expect(applyGoalControllerAction(completeLockedId, "complete", "done")).toMatchObject({
      ok: false,
      message: "This goal cannot be completed.",
    });
  });

  test("controller pause records its source and reason", () => {
    const convId = makeConversation("controller-pause");
    setGoal(convId, "wait when blocked");

    const result = applyGoalControllerAction(convId, "pause", "Choose a deployment region.");

    expect(result).toMatchObject({
      ok: true,
      message: "Goal paused: Choose a deployment region.",
      goal: {
        status: "paused",
        pausedBy: "controller",
        pauseReason: "Choose a deployment region.",
      },
    });
  });

  test("user actions override AI permissions and mark manual pauses", () => {
    const convId = makeConversation("user-override");
    setGoal(convId, "user remains in control", { completable: false });

    expect(applyUserGoalAction(get(convId)!, "pause")).toMatchObject({
      ok: true,
      goal: expect.objectContaining({ status: "paused", pausedBy: "user" }),
    });
    expect(applyUserGoalAction(get(convId)!, "resume")).toMatchObject({
      ok: true,
      goal: expect.objectContaining({ status: "active" }),
    });
    expect(get(convId)?.goal).not.toHaveProperty("pausedBy");
    expect(applyUserGoalAction(get(convId)!, "complete")).toMatchObject({ ok: true, goal: null });
  });

  test("controller completion clears the goal", () => {
    const convId = makeConversation("complete-clears");
    setGoal(convId, "finish and disappear");

    const result = applyGoalControllerAction(convId, "complete", "All checks pass.");

    expect(result).toMatchObject({ ok: true, message: "Goal complete: All checks pass.", goal: null });
    expect(get(convId)?.goal).toBeNull();
  });

  test("formats disabled permissions as CLI-style flags", () => {
    expect(goalPermissionFlagSuffix({ pausable: true, completable: true })).toBe("");
    expect(goalPermissionFlagSuffix({ pausable: false, completable: true })).toBe(" --unpausable");
    expect(goalPermissionFlagSuffix({ pausable: false, completable: false })).toBe(" --unpausable --uncompletable");
  });
});
