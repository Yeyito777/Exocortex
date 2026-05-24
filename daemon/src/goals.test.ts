import { afterEach, describe, expect, test } from "bun:test";
import { create, get, remove } from "./conversations";
import { DEFAULT_EFFORT } from "./messages";
import {
  applyModelGoalAction,
  goalCanComplete,
  goalCanPause,
  goalContinuationSystemPrompt,
  goalContinuationUserMessage,
  goalPermissionFlagSuffix,
  GOAL_CONTINUATION_NO_PAUSE_PROMPT,
  GOAL_CONTINUATION_PROMPT,
  GOAL_CONTINUATION_WORK_ONLY_PREFIX,
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
  test("exposes pausable and completable set parameters", () => {
    expect(goalTool.inputSchema).toMatchObject({
      properties: {
        pausable: { type: "boolean" },
        completable: { type: "boolean" },
      },
    });
  });

  test("summarizes disabled permissions as CLI-style flags", () => {
    expect(goalTool.summarize({
      action: "set",
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
  test("defaults allow pause and complete", () => {
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

  test("model cannot pause or complete a goal when the corresponding permission is disabled", () => {
    const pauseLockedId = makeConversation("pause-locked");
    setGoal(pauseLockedId, "do not pause", { pausable: false });

    expect(applyModelGoalAction(pauseLockedId, "pause")).toMatchObject({
      ok: false,
      message: "This goal cannot be paused.",
    });
    expect(applyModelGoalAction(pauseLockedId, "complete")).toMatchObject({ ok: true });

    const completeLockedId = makeConversation("complete-locked");
    setGoal(completeLockedId, "do not complete", { completable: false });

    expect(applyModelGoalAction(completeLockedId, "pause")).toMatchObject({
      ok: false,
      message: "This goal cannot be paused.",
    });
    expect(applyModelGoalAction(completeLockedId, "complete")).toMatchObject({
      ok: false,
      message: "This goal cannot be completed.",
    });
  });

  test("formats disabled permissions as CLI-style flags", () => {
    expect(goalPermissionFlagSuffix({ pausable: true, completable: true })).toBe("");
    expect(goalPermissionFlagSuffix({ pausable: false, completable: true })).toBe(" --unpausable");
    expect(goalPermissionFlagSuffix({ pausable: false, completable: false })).toBe(" --unpausable --uncompletable");
  });
});

describe("goal continuation messages", () => {
  test("uses the pause-or-complete prompt when both actions are allowed", () => {
    const convId = makeConversation("continue-default");
    const result = setGoal(convId, "ship the thing");

    expect(goalContinuationSystemPrompt(result.goal!)).toBe(GOAL_CONTINUATION_PROMPT);
    expect(goalContinuationUserMessage(result.goal!)).toBe("Continue the active /goal objective now: ship the thing");
  });

  test("omits pause references when only completion is allowed", () => {
    const convId = makeConversation("continue-no-pause");
    const result = setGoal(convId, "ship the thing", { pausable: false });

    expect(goalContinuationSystemPrompt(result.goal!)).toBe(GOAL_CONTINUATION_NO_PAUSE_PROMPT);
    expect(goalContinuationSystemPrompt(result.goal!)).not.toContain("pause");
    expect(goalContinuationUserMessage(result.goal!)).toBe("Continue the active /goal objective now: ship the thing");
  });

  test("uses only the work-only continuation message when pause and complete are disabled", () => {
    const convId = makeConversation("continue-work-only");
    const result = setGoal(convId, "ship the thing", { completable: false });

    expect(goalContinuationSystemPrompt(result.goal!)).toBeNull();
    expect(goalContinuationUserMessage(result.goal!)).toBe(`${GOAL_CONTINUATION_WORK_ONLY_PREFIX}ship the thing`);
  });
});
