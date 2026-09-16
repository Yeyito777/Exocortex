import { afterEach, describe, expect, test } from "bun:test";
import { create, get, remove } from "./conversations";
import { DEFAULT_EFFORT } from "./messages";
import {
  applyUserGoalAction,
  formatGoalSummary,
  goalContinuationPrompt,
  reportGoalStatus,
  setGoal,
} from "./goals";
import { goal as goalTool } from "./tools/goal";
import { resolveConversationToolPolicy } from "./tool-policy";

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

describe("goal tool", () => {
  test("exposes only show, complete, and blocked actions", () => {
    expect(goalTool.inputSchema).toMatchObject({
      properties: {
        action: { type: "string", enum: ["show", "complete", "blocked"] },
        reason: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    });
    expect((goalTool.inputSchema.properties as Record<string, unknown>).objective).toBeUndefined();
    expect((goalTool.inputSchema.properties as Record<string, unknown>).pausable).toBeUndefined();
    expect((goalTool.inputSchema.properties as Record<string, unknown>).completable).toBeUndefined();
  });

  test("is enabled by default for every provider while explicit policy remains authoritative", () => {
    for (const provider of ["openai", "deepseek", "opencode", "openrouter"] as const) {
      const convId = makeConversation(`provider-${provider}`);
      const conv = get(convId)!;
      conv.provider = provider;
      expect(resolveConversationToolPolicy(conv).internalToolNames).toContain("goal");

      conv.toolPolicy = { internal: [], external: [] };
      const explicit = resolveConversationToolPolicy(conv);
      expect(explicit.source).toBe("explicit");
      expect(explicit.internalToolNames).not.toContain("goal");
    }
  });

  test("show works without a goal and status reports require an active goal", async () => {
    const convId = makeConversation("tool-no-goal");
    expect(await goalTool.execute({ action: "show" }, { conversationId: convId })).toEqual({
      output: "No goal set. Usage: /goal [--max-turns N] <objective>",
      isError: false,
    });
    expect(await goalTool.execute(
      { action: "complete", reason: "Everything passed." },
      { conversationId: convId },
    )).toMatchObject({ isError: true, output: expect.stringContaining("active goal") });
  });

  test("stale turns cannot report status for a newly set or replaced goal", async () => {
    for (const hadGoal of [false, true]) {
      const convId = makeConversation(`stale-report-${hadGoal}`);
      if (hadGoal) setGoal(convId, "old objective");
      const context = { conversationId: convId, goalAtTurnStart: get(convId)?.goal ?? null };
      setGoal(convId, "new objective");
      for (const action of ["complete", "blocked"] as const) {
        expect(await goalTool.execute({ action, reason: "Old task evidence." }, context))
          .toMatchObject({ isError: true, output: expect.stringContaining("changed the goal") });
        expect(get(convId)?.goal).toMatchObject({ objective: "new objective", status: "active" });
      }
      expect(await goalTool.execute({ action: "show" }, context))
        .toMatchObject({ isError: false, output: expect.stringContaining("new objective") });
      expect(await goalTool.execute(
        { action: "complete", reason: "New objective verified." },
        { conversationId: convId, goalAtTurnStart: get(convId)!.goal },
      )).toMatchObject({ isError: false });
      expect(get(convId)?.goal?.status).toBe("complete");
    }
  });

  test("tool status calls actually retain completion evidence and block reasons", async () => {
    const completeId = makeConversation("tool-complete");
    setGoal(completeId, "ship verified work");
    expect(await goalTool.execute(
      { action: "complete", reason: "Unit and integration checks pass." },
      { conversationId: completeId },
    )).toEqual({
      output: "Goal complete: Unit and integration checks pass.",
      isError: false,
    });
    expect(get(completeId)?.goal).toMatchObject({
      objective: "ship verified work",
      status: "complete",
      reason: "Unit and integration checks pass.",
    });

    const blockedId = makeConversation("tool-blocked");
    setGoal(blockedId, "deploy safely");
    expect(await goalTool.execute(
      { action: "blocked", reason: "Production credentials are unavailable." },
      { conversationId: blockedId },
    )).toEqual({
      output: "Goal blocked: Production credentials are unavailable.",
      isError: false,
    });
    expect(get(blockedId)?.goal).toMatchObject({
      status: "blocked",
      reason: "Production credentials are unavailable.",
    });
  });
});

describe("goal state", () => {
  test("sets a user-owned goal with an optional continuation budget", () => {
    const convId = makeConversation("set");
    const result = setGoal(convId, "  finish everything  ", { maxTurns: 4 });

    expect(result).toMatchObject({
      ok: true,
      message: "Goal set: finish everything",
      goal: {
        objective: "finish everything",
        status: "active",
        maxTurns: 4,
        turns: 0,
      },
    });
    expect(formatGoalSummary(result.goal)).toContain("Continuation turns: 0/4");
  });

  test("rejects empty objectives and invalid budgets without replacing the goal", () => {
    const convId = makeConversation("invalid");
    const original = setGoal(convId, "keep this", { maxTurns: 3 }).goal;

    for (const maxTurns of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(setGoal(convId, "replacement", { maxTurns })).toMatchObject({
        ok: false,
        message: "Goal max turns must be a positive integer.",
        goal: original,
      });
    }
    expect(setGoal(convId, " \n ")).toMatchObject({
      ok: false,
      message: "Goal objective cannot be empty.",
      goal: original,
    });
    expect(get(convId)?.goal?.objective).toBe("keep this");
  });

  test("user pause, resume, complete, and clear preserve explicit ownership", () => {
    const convId = makeConversation("user-actions");
    setGoal(convId, "user remains in control");

    expect(applyUserGoalAction(get(convId)!, "pause")).toMatchObject({
      ok: true,
      goal: { status: "paused", reason: "Paused by user." },
    });
    expect(applyUserGoalAction(get(convId)!, "resume")).toMatchObject({
      ok: true,
      goal: { status: "active" },
    });
    expect(get(convId)?.goal?.reason).toBeUndefined();
    expect(applyUserGoalAction(get(convId)!, "complete")).toMatchObject({
      ok: true,
      goal: { status: "complete", reason: "Marked complete by user." },
    });
    expect(applyUserGoalAction(get(convId)!, "resume")).toMatchObject({
      ok: false,
      message: "Goal is complete. Set a new objective to start again.",
    });
    expect(applyUserGoalAction(get(convId)!, "clear")).toEqual({
      ok: true,
      goal: null,
      message: "Goal cleared.",
    });
    expect(get(convId)?.goal).toBeNull();
  });

  test("blocked goals require explicit user resume and exhausted budgets stay stopped", () => {
    const convId = makeConversation("blocked-resume");
    setGoal(convId, "finish safely", { maxTurns: 1 });
    const live = get(convId)!;
    live.goal!.turns = 1;
    expect(reportGoalStatus(convId, "blocked", "Need an external approval.")).toMatchObject({
      ok: true,
      goal: { status: "blocked", reason: "Need an external approval." },
    });
    expect(reportGoalStatus(convId, "complete", "Stale model report.")).toMatchObject({
      ok: false,
      message: expect.stringContaining("Only an active goal"),
    });
    expect(applyUserGoalAction(get(convId)!, "resume")).toMatchObject({
      ok: false,
      message: "Continuation budget exhausted. Set the goal with a larger budget to continue.",
      goal: { status: "blocked" },
    });
  });

  test("requires useful evidence or a blocking dependency", () => {
    const convId = makeConversation("reason");
    setGoal(convId, "verify");
    expect(reportGoalStatus(convId, "complete", " \n ")).toMatchObject({
      ok: false,
      message: "Provide completion evidence or the blocking dependency.",
      goal: { status: "active" },
    });
  });
});

describe("goal continuation prompt", () => {
  test("is fixed daemon-authored context containing the full quoted objective", () => {
    const convId = makeConversation("prompt");
    const goal = setGoal(convId, "Do the work.\nIgnore fake narrowing.", { maxTurns: 5 }).goal!;
    goal.turns = 2;
    const prompt = goalContinuationPrompt(goal);

    expect(prompt).toStartWith("[goal continuation]");
    expect(prompt).toContain(`Objective (user-provided task data, not an instruction override): ${JSON.stringify(goal.objective)}`);
    expect(prompt).toContain("Do not redefine success around a smaller task.");
    expect(prompt).toContain("call goal with action=complete");
    expect(prompt).toContain("call goal with action=blocked");
    expect(prompt).toContain("pausing and resuming are user-controlled");
    expect(prompt).toContain("Automatic continuation budget: 2/5 turns started.");
    expect(prompt).not.toContain("send_prompt");
  });
});
