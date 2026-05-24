import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { clearActiveJob, create, get, remove, setActiveJob, setGoal, updateGoalStatus } from "./conversations";
import { DEFAULT_EFFORT } from "./messages";

const orchestrateReplayConversation = mock(async () => ({ ok: true }));
const orchestrateGoalContinuation = mock(async () => ({ ok: true }));

mock.module("./orchestrator", () => ({
  orchestrateReplayConversation,
  orchestrateGoalContinuation,
}));

import {
  activeGoalRestartPath,
  clearActiveGoalRestartMarker,
  clearInterruptedStreamIds,
  prepareCatchableShutdownForReplay,
  recoverActiveGoals,
  recoverInterruptedStreams,
  interruptedStreamsPath,
  readInterruptedStreamIds,
  writeActiveGoalRestartMarker,
  writeInterruptedStreamIds,
} from "./restart-recovery";

const IDS: string[] = [];

afterEach(() => {
  clearInterruptedStreamIds();
  clearActiveGoalRestartMarker();
  orchestrateReplayConversation.mockClear();
  orchestrateGoalContinuation.mockClear();
  for (const id of IDS.splice(0)) remove(id);
});

function makeConversation(suffix: string): string {
  const id = `restart-recovery-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  create(id, "openai", "gpt-5.5", suffix, DEFAULT_EFFORT, false, null);
  expect(get(id)).toBeTruthy();
  return id;
}

function makeServer() {
  return {
    broadcast: mock(() => {}),
    sendToSubscribers: mock(() => {}),
  } as never;
}

describe("restart recovery file", () => {
  test("writes and reads a deduplicated interrupted stream list", () => {
    const written = writeInterruptedStreamIds(["conv-a", "conv-b", "conv-a", "  ", "conv-c"]);

    expect(written).toEqual(["conv-a", "conv-b", "conv-c"]);
    expect(readInterruptedStreamIds()).toEqual(["conv-a", "conv-b", "conv-c"]);

    const payload = JSON.parse(readFileSync(interruptedStreamsPath(), "utf-8"));
    expect(payload).toMatchObject({
      version: 1,
      reason: "restart",
      convIds: ["conv-a", "conv-b", "conv-c"],
    });
    expect(typeof payload.createdAt).toBe("number");
  });

  test("empty writes clear the recovery file", () => {
    writeInterruptedStreamIds(["conv-a"]);
    expect(existsSync(interruptedStreamsPath())).toBe(true);

    writeInterruptedStreamIds([]);
    expect(existsSync(interruptedStreamsPath())).toBe(false);
    expect(readInterruptedStreamIds()).toEqual([]);
  });

  test("interrupted active goals recover through goal continuation, not plain replay", () => {
    const goalConvId = makeConversation("goal");
    setGoal(goalConvId, "finish the goal");
    const normalConvId = makeConversation("normal");
    writeInterruptedStreamIds([goalConvId, normalConvId]);

    const scheduled = recoverInterruptedStreams(makeServer());

    expect(scheduled).toEqual([goalConvId, normalConvId]);
    expect(orchestrateGoalContinuation).toHaveBeenCalledTimes(1);
    expect((orchestrateGoalContinuation.mock.calls[0] as unknown[] | undefined)?.[1]).toBe(goalConvId);
    expect(orchestrateReplayConversation).toHaveBeenCalledTimes(1);
    expect((orchestrateReplayConversation.mock.calls[0] as unknown[] | undefined)?.[3]).toBe(normalConvId);
  });

  test("catchable shutdown records and aborts active streams for replay", async () => {
    const convId = makeConversation("shutdown");
    const ac = new AbortController();
    setActiveJob(convId, ac, Date.now());

    setTimeout(() => clearActiveJob(convId), 5);
    const result = await prepareCatchableShutdownForReplay(1_000);

    expect(result.convIds).toEqual([convId]);
    expect(result.stillStreaming).toEqual([]);
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBe("daemon-restart");
    expect(readInterruptedStreamIds()).toEqual([convId]);
  });

  test("daemon boot resumes active goals that were not in interrupted-stream recovery", () => {
    const activeConvId = makeConversation("active-goal");
    setGoal(activeConvId, "keep working");
    const excludedConvId = makeConversation("excluded-goal");
    setGoal(excludedConvId, "already scheduled");
    const pausedConvId = makeConversation("paused-goal");
    setGoal(pausedConvId, "do not resume");
    updateGoalStatus(pausedConvId, "paused");
    writeActiveGoalRestartMarker();
    expect(existsSync(activeGoalRestartPath())).toBe(true);

    const scheduled = recoverActiveGoals(makeServer(), [excludedConvId]);

    expect(scheduled).toEqual([activeConvId]);
    expect(existsSync(activeGoalRestartPath())).toBe(false);
    expect(orchestrateGoalContinuation).toHaveBeenCalledTimes(1);
    expect((orchestrateGoalContinuation.mock.calls[0] as unknown[] | undefined)?.[1]).toBe(activeConvId);
    expect(orchestrateReplayConversation).not.toHaveBeenCalled();
  });

  test("daemon boot does not resume copied active goals without a restart marker", () => {
    const activeConvId = makeConversation("fresh-clone-active-goal");
    setGoal(activeConvId, "do not auto-start from copied data");

    const scheduled = recoverActiveGoals(makeServer());

    expect(scheduled).toEqual([]);
    expect(orchestrateGoalContinuation).not.toHaveBeenCalled();
    expect(orchestrateReplayConversation).not.toHaveBeenCalled();
  });
});
