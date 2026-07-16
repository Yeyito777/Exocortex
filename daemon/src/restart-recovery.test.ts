import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { clearActiveJob, consumeGoalContinuationAfterStream, create, get, getQueuedMessages, getSummary, pushQueuedMessage, remove, requestGoalContinuationAfterStream, setActiveJob, setGoal, updateGoalStatus } from "./conversations";
import { DEFAULT_EFFORT } from "./messages";

const orchestrateReplayConversation = mock(async () => ({ ok: true }));
const orchestrateGoalContinuation = mock(async () => ({ ok: true }));
const orchestrateSendMessage = mock(async () => ({
  ok: true,
  blocks: [{ type: "text" as const, text: "recovered" }],
  tokens: 1,
  durationMs: 1,
  endedAt: Date.now(),
}));

mock.module("./orchestrator", () => ({
  orchestrateReplayConversation,
  orchestrateGoalContinuation,
  orchestrateSendMessage,
}));

import {
  activeGoalRestartPath,
  clearActiveGoalRestartMarker,
  clearInterruptedStreamIds,
  hasActiveGoalRestartMarker,
  prepareCatchableShutdownForReplay,
  prepareCatchableShutdownWithoutReplay,
  recoverActiveGoals,
  recoverInterruptedStreams,
  interruptedStreamsPath,
  readInterruptedStreamIds,
  writeActiveGoalRestartMarker,
  writeInterruptedStreamIds,
} from "./restart-recovery";
import {
  beginPendingSubagentNotification,
  listPendingSubagentNotifications,
  registerSubagentNotificationRuntime,
  resetPendingSubagentNotificationsForTest,
} from "./subagent-notifications";
import { resetConversationActivityForTest } from "./conversation-activity";

const IDS: string[] = [];

beforeEach(() => {
  resetPendingSubagentNotificationsForTest();
  resetConversationActivityForTest();
});

afterEach(() => {
  clearInterruptedStreamIds();
  clearActiveGoalRestartMarker();
  orchestrateReplayConversation.mockClear();
  orchestrateGoalContinuation.mockClear();
  orchestrateSendMessage.mockClear();
  resetPendingSubagentNotificationsForTest();
  resetConversationActivityForTest();
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

  test("catchable shutdown aborts maintenance jobs without scheduling an assistant replay", async () => {
    const convId = makeConversation("maintenance");
    const ac = new AbortController();
    setActiveJob(convId, ac, Date.now(), false);

    setTimeout(() => clearActiveJob(convId), 5);
    const result = await prepareCatchableShutdownForReplay(1_000);

    expect(result.convIds).toEqual([]);
    expect(result.stillStreaming).toEqual([]);
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBe("daemon-restart");
    expect(readInterruptedStreamIds()).toEqual([]);
  });

  test("explicit stop aborts active work while preserving queued user intent", async () => {
    const parentConvId = makeConversation("stop-parent");
    const childConvId = makeConversation("stop-child");
    const ac = new AbortController();
    setActiveJob(childConvId, ac, Date.now());
    pushQueuedMessage(childConvId, "do not run after start", "next-turn", undefined, 0);
    requestGoalContinuationAfterStream(childConvId);
    beginPendingSubagentNotification(
      { convId: parentConvId },
      childConvId,
      "do not recover me",
      444_555,
      0,
    );
    writeInterruptedStreamIds([childConvId]);
    writeActiveGoalRestartMarker();

    setTimeout(() => clearActiveJob(childConvId), 5);
    const result = await prepareCatchableShutdownWithoutReplay(1_000);

    expect(result.convIds).toEqual([childConvId]);
    expect(result.stillStreaming).toEqual([]);
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBe("daemon-stop");
    expect(readInterruptedStreamIds()).toEqual([]);
    expect(hasActiveGoalRestartMarker()).toBe(false);
    expect(listPendingSubagentNotifications()).toEqual([]);
    expect(getQueuedMessages(childConvId)).toEqual([
      expect.objectContaining({
        convId: childConvId,
        text: "do not run after start",
        timing: "next-turn",
        source: "daemon",
      }),
    ]);
    expect(consumeGoalContinuationAfterStream(childConvId)).toBe(false);
  });

  test("restores a persisted subagent task even if restart happened before its user message was appended", async () => {
    const parentConvId = makeConversation("subagent-parent");
    const childConvId = makeConversation("subagent-child");
    beginPendingSubagentNotification(
      { convId: parentConvId },
      childConvId,
      "durable child task",
      987_654,
      2,
    );
    const server = makeServer();
    const complete = mock(() => {});
    registerSubagentNotificationRuntime(server as object, {
      begin: beginPendingSubagentNotification,
      complete,
      deliverReady: () => {},
    });

    const scheduled = recoverInterruptedStreams(server);
    expect(getSummary(parentConvId)?.tasks).toEqual([
      { id: childConvId, kind: "subagent", title: "subagent-child", startedAt: 987_654 },
    ]);
    await Promise.resolve();

    expect(scheduled).toContain(childConvId);
    expect(orchestrateSendMessage).toHaveBeenCalledWith(
      server,
      null,
      undefined,
      childConvId,
      "durable child task",
      987_654,
      expect.any(Object),
      undefined,
      { subagentMaxDepth: 2 },
    );
    expect(orchestrateReplayConversation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      childConvId,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(complete).toHaveBeenCalledWith(childConvId, expect.objectContaining({ ok: true }));
  });

  test("replays an in-progress persisted subagent and retains its parent completion callback", async () => {
    const parentConvId = makeConversation("replay-subagent-parent");
    const childConvId = makeConversation("replay-subagent-child");
    const childStartedAt = 123_987;
    beginPendingSubagentNotification(
      { convId: parentConvId },
      childConvId,
      "continue after restart",
      childStartedAt,
      1,
    );
    get(childConvId)!.messages.push({
      role: "user",
      content: "continue after restart",
      metadata: { startedAt: childStartedAt, endedAt: childStartedAt, model: "gpt-5.5", tokens: 0 },
    });
    const server = makeServer();
    const complete = mock(() => {});
    registerSubagentNotificationRuntime(server as object, {
      begin: beginPendingSubagentNotification,
      complete,
      deliverReady: () => {},
    });

    const scheduled = recoverInterruptedStreams(server);
    await Promise.resolve();

    expect(scheduled).toContain(childConvId);
    expect(orchestrateReplayConversation).toHaveBeenCalledWith(
      server,
      null,
      undefined,
      childConvId,
      expect.any(Number),
      expect.any(Object),
      { subagentMaxDepth: 1 },
    );
    expect(orchestrateSendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      childConvId,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(complete).toHaveBeenCalledWith(childConvId, expect.objectContaining({ ok: true }));
  });

  test("does not replay a child whose completed answer beat the sidecar settlement during a crash", () => {
    const parentConvId = makeConversation("settlement-race-parent");
    const childConvId = makeConversation("settlement-race-child");
    const childStartedAt = 222_333;
    beginPendingSubagentNotification(
      { convId: parentConvId },
      childConvId,
      "answer before crash",
      childStartedAt,
      0,
    );
    get(childConvId)!.messages.push(
      {
        role: "user",
        content: "answer before crash",
        metadata: { startedAt: childStartedAt, endedAt: childStartedAt, model: "gpt-5.5", tokens: 0 },
      },
      {
        role: "assistant",
        content: "already durable",
        metadata: { startedAt: childStartedAt, endedAt: childStartedAt + 1, model: "gpt-5.5", tokens: 1 },
      },
    );
    writeInterruptedStreamIds([childConvId]);

    const scheduled = recoverInterruptedStreams(makeServer());

    expect(scheduled).not.toContain(childConvId);
    expect(orchestrateReplayConversation).not.toHaveBeenCalled();
    expect(orchestrateSendMessage).not.toHaveBeenCalled();
    expect(listPendingSubagentNotifications({ childConvId })).toEqual([
      expect.objectContaining({ state: "ready", text: expect.stringContaining("already durable") }),
    ]);
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
