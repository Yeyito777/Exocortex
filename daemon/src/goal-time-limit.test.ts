import { afterEach, describe, expect, test } from "bun:test";
import { create, get, remove, requestGoalContinuationAfterStream, consumeGoalContinuationAfterStream, setGoal, updateGoalStatus } from "./conversations";
import { clearActiveJob, setActiveJob } from "./streaming";
import { scheduleActiveGoalTimeLimits, scheduleGoalTimeLimit } from "./goal-time-limit";

const IDS: string[] = [];

function makeConversation(suffix: string): string {
  const id = `goal-time-limit-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  create(id, "anthropic", "claude-opus-5-5");
  return id;
}

function server(events: Array<Record<string, unknown>> = []) {
  return {
    sendTo() {}, broadcast() {},
    sendToSubscribers: (_convId: string, event: Record<string, unknown>) => { events.push(event); },
    sendToSubscribersExcept() {},
    hasSubscribers: () => false,
    hasLegacyHistorySubscribers: () => false,
    sendHistoryUpdatedToSubscribers() {},
  } as never;
}

afterEach(() => {
  for (const id of IDS.splice(0)) {
    clearActiveJob(id);
    remove(id);
  }
});

describe("goal time limit", () => {
  test("stops goal work like pause once the active time is used up", () => {
    const convId = makeConversation("expired");
    setGoal(convId, "ship it", { maxTimeMs: 60_000 });
    get(convId)!.goal!.activeSince = Date.now() - 60_000;
    const controller = new AbortController();
    setActiveJob(convId, controller, Date.now());
    requestGoalContinuationAfterStream(convId);
    const events: Array<Record<string, unknown>> = [];

    scheduleGoalTimeLimit(server(events), convId);

    expect(controller.signal.aborted).toBe(true);
    expect(consumeGoalContinuationAfterStream(convId)).toBe(false);
    expect(get(convId)?.goal).toMatchObject({
      status: "blocked",
      reason: "Time limit of 1m reached. Set the goal again with a larger max-time to continue.",
    });
    expect(get(convId)?.goal?.activeSince).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({
      type: "goal_updated", convId, message: "Goal time limit reached.",
      goal: expect.objectContaining({ status: "blocked" }),
    }));
  });

  test("fires when the remaining active time runs out", async () => {
    const convId = makeConversation("timer");
    setGoal(convId, "ship it", { maxTimeMs: 40 });
    const controller = new AbortController();
    setActiveJob(convId, controller, Date.now());

    scheduleGoalTimeLimit(server(), convId);
    expect(get(convId)?.goal?.status).toBe("active");
    await new Promise(resolve => setTimeout(resolve, 120));

    expect(get(convId)?.goal?.status).toBe("blocked");
    expect(controller.signal.aborted).toBe(true);
  });

  test("leaves goals alone that are stopped, unlimited, or replaced before the timer fires", async () => {
    const paused = makeConversation("paused");
    setGoal(paused, "wait", { maxTimeMs: 40 });
    scheduleGoalTimeLimit(server(), paused);
    updateGoalStatus(paused, "paused", { reason: "Paused by user." });

    const unlimited = makeConversation("unlimited");
    setGoal(unlimited, "no limit");
    get(unlimited)!.goal!.activeSince = Date.now() - 86_400_000;

    const replaced = makeConversation("replaced");
    setGoal(replaced, "old", { maxTimeMs: 40 });
    scheduleGoalTimeLimit(server(), replaced);
    setGoal(replaced, "new", { maxTimeMs: 3_600_000 });
    scheduleGoalTimeLimit(server(), replaced);

    scheduleActiveGoalTimeLimits(server());
    await new Promise(resolve => setTimeout(resolve, 120));

    expect(get(paused)?.goal?.status).toBe("paused");
    expect(get(unlimited)?.goal?.status).toBe("active");
    expect(get(replaced)?.goal).toMatchObject({ objective: "new", status: "active" });
  });
});
