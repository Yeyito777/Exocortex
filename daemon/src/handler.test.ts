import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { clearConversationDefaults, saveConversationDefaults } from "@exocortex/shared/config";
import { consumeGoalContinuationAfterStream, create, deleteFolder, ensureTopLevelFolder, findTopLevelFolderByName, get, getQueuedMessages, getSummary, remove, replaceStreamingDisplayMessages, setGoal, updateGoalStatus } from "./conversations";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID, defaultEffortForModelId } from "./messages";
import { appendToStreamingBlock, clearActiveJob, clearCurrentStreamingBlocks, initStreamingState, replaceCurrentStreamingBlocks, setActiveJob } from "./streaming";
import { beginPendingSubagentNotification, listPendingSubagentNotifications, removePendingSubagentNotificationsForConversation } from "./subagent-notifications";
import { getDaemonShutdownMode, resetDaemonShutdownModeForTest } from "./daemon-lifecycle";
import { invalidateCredentialsCache } from "./auth";
import { clearProviderAuth, saveProviderAuth } from "./store";

interface TestAssistantOutcome {
  ok: boolean;
  blocks: never[];
  tokens: number;
  durationMs: number;
  endedAt: number;
  error?: string;
  aborted?: boolean;
  watchdog?: boolean;
}

const makeAssistantOutcome = (overrides: Partial<TestAssistantOutcome> = {}): TestAssistantOutcome => ({
  ok: true,
  blocks: [],
  tokens: 0,
  durationMs: 0,
  endedAt: Date.now(),
  ...overrides,
});

const orchestrateSendMessage = mock(async () => makeAssistantOutcome());
const orchestrateReplayConversation = mock(async () => makeAssistantOutcome());
const orchestrateGoalContinuation = mock(async () => {});

mock.module("./orchestrator", () => ({
  orchestrateSendMessage,
  orchestrateReplayConversation,
  orchestrateGoalContinuation,
}));

const { createHandler } = await import("./handler");

const IDS: string[] = [];

function mkId(suffix: string): string {
  const id = `handler-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  return id;
}

function cleanupIds(): void {
  resetDaemonShutdownModeForTest();
  for (const id of IDS.splice(0)) {
    clearActiveJob(id);
    removePendingSubagentNotificationsForConversation(id);
    remove(id);
  }
  const subagentsFolder = findTopLevelFolderByName("subagents");
  if (subagentsFolder) deleteFolder(subagentsFolder.id);
}

describe("handler shutdown preparation", () => {
  afterEach(cleanupIds);

  test("records the service wrapper's shutdown mode before acknowledging it", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "prepare_shutdown", reqId: "prepare-stop", mode: "stop" });

    expect(getDaemonShutdownMode()).toBe("stop");
    expect(sent).toContainEqual({ type: "ack", reqId: "prepare-stop" });
  });
});

describe("handler OpenAI reauthentication", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearProviderAuth("openai");
    invalidateCredentialsCache("openai");
    cleanupIds();
  });

  test("allows plain login while an OpenAI conversation is streaming", async () => {
    saveProviderAuth("openai", {
      tokens: {
        accessToken: "valid-access-token",
        refreshToken: "valid-refresh-token",
        expiresAt: Date.now() + 60 * 60_000,
        scopes: [],
        subscriptionType: "pro",
        rateLimitTier: null,
      },
      profile: {
        accountUuid: "acct_one",
        email: "one@example.com",
        displayName: null,
        organizationUuid: null,
        organizationName: null,
        organizationType: null,
        organizationRole: null,
        workspaceRole: null,
      },
      updatedAt: new Date().toISOString(),
      source: "oauth",
      authMode: null,
      accountId: "acct_one",
      idToken: null,
    });
    invalidateCredentialsCache("openai");
    globalThis.fetch = mock(() => Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch;

    const convId = mkId("streaming-reauth");
    create(convId, "openai", "gpt-5.4", "streaming");
    setActiveJob(convId, new AbortController(), Date.now());
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "login", reqId: "req-streaming-login", provider: "openai" });
    for (let attempt = 0; attempt < 50 && !sent.some((event) => event.type === "auth_status" && typeof event.message === "string" && event.message.startsWith("Already authenticated")); attempt++) {
      await Bun.sleep(10);
    }

    expect(sent).toContainEqual({ type: "ack", reqId: "req-streaming-login" });
    expect(sent).toContainEqual(expect.objectContaining({
      type: "auth_status",
      reqId: "req-streaming-login",
      message: "Already authenticated as one@example.com",
    }));
    expect(sent).not.toContainEqual(expect.objectContaining({
      message: "Cannot change OpenAI accounts while an OpenAI conversation is streaming.",
    }));
  });
});

describe("handler new_conversation defaults", () => {
  beforeEach(() => {
    orchestrateSendMessage.mockClear();
    orchestrateReplayConversation.mockClear();
    orchestrateGoalContinuation.mockClear();
    clearConversationDefaults();
    cleanupIds();
  });
  afterEach(() => {
    clearConversationDefaults();
    cleanupIds();
  });

  test("uses OpenAI GPT-5.6 Sol medium effort when the client omits model settings", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "new_conversation", reqId: "req-defaults" });

    const created = sent.find((event) => event.type === "conversation_created");
    expect(created).toMatchObject({
      type: "conversation_created",
      reqId: "req-defaults",
      provider: DEFAULT_PROVIDER_ID,
      model: DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID],
      effort: defaultEffortForModelId(DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]),
      fastMode: false,
    });

    const convId = created?.convId as string | undefined;
    expect(convId).toBeTruthy();
    if (convId) {
      IDS.push(convId);
      expect(get(convId)).toMatchObject({
        provider: DEFAULT_PROVIDER_ID,
        model: DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID],
        effort: defaultEffortForModelId(DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]),
        fastMode: false,
      });
    }
  });

  test("uses configured conversation defaults when the client omits model settings", async () => {
    saveConversationDefaults({ provider: "openai", model: "gpt-5.4", effort: "high", fastMode: true });
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "new_conversation", reqId: "req-configured-defaults" });

    const created = sent.find((event) => event.type === "conversation_created");
    expect(created).toMatchObject({
      type: "conversation_created",
      reqId: "req-configured-defaults",
      provider: "openai",
      model: "gpt-5.4",
      effort: "high",
      fastMode: true,
    });

    const convId = created?.convId as string | undefined;
    expect(convId).toBeTruthy();
    if (convId) {
      IDS.push(convId);
      expect(get(convId)).toMatchObject({
        provider: "openai",
        model: "gpt-5.4",
        effort: "high",
        fastMode: true,
      });
    }
  });

  test("explicit provider/model overrides configured defaults", async () => {
    saveConversationDefaults({ provider: "openai", model: "gpt-5.4", effort: "high", fastMode: true });
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "new_conversation", reqId: "req-explicit", provider: "deepseek", model: "deepseek-v4-pro" });

    const created = sent.find((event) => event.type === "conversation_created");
    expect(created).toMatchObject({
      type: "conversation_created",
      reqId: "req-explicit",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      effort: "high",
      fastMode: false,
    });
  });

  test("an explicit OpenAI model infers OpenAI even when the saved default provider differs", async () => {
    saveConversationDefaults({ provider: "deepseek", model: "deepseek-v4-pro", effort: "max", fastMode: false });
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "new_conversation", reqId: "req-model-infer", model: "gpt-5.4" });

    const created = sent.find((event) => event.type === "conversation_created");
    expect(created).toMatchObject({
      type: "conversation_created",
      reqId: "req-model-infer",
      provider: "openai",
      model: "gpt-5.4",
      fastMode: false,
    });
  });

  test("honors a client-supplied conversation id", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);
    const convId = `${Date.now()}-abc123`;
    IDS.push(convId);

    await handle({} as never, { type: "new_conversation", reqId: "req-client-id", convId });

    expect(sent).toContainEqual(expect.objectContaining({
      type: "conversation_created",
      reqId: "req-client-id",
      convId,
    }));
    expect(get(convId)?.id).toBe(convId);
  });

  test("rejects unsafe client-supplied conversation ids", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "new_conversation", reqId: "req-bad-id", convId: "../bad" });

    expect(sent).toContainEqual(expect.objectContaining({
      type: "error",
      reqId: "req-bad-id",
      convId: "../bad",
      message: "Invalid or duplicate client-supplied conversation id",
    }));
  });
});

describe("handler subagent folder placement", () => {
  beforeEach(() => {
    orchestrateSendMessage.mockClear();
    orchestrateReplayConversation.mockClear();
    orchestrateGoalContinuation.mockClear();
    cleanupIds();
  });
  afterEach(cleanupIds);

  test("places newly-created subagent conversations in the subagents folder", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "new_conversation", reqId: "req-new-subagent", subagent: true });

    const created = sent.find((event) => event.type === "conversation_created");
    const convId = created?.convId as string | undefined;
    expect(convId).toBeTruthy();
    if (convId) IDS.push(convId);

    const subagentsFolder = findTopLevelFolderByName("subagents");
    expect(subagentsFolder).toBeTruthy();
    expect(convId ? getSummary(convId)?.folderId : null).toBe(subagentsFolder?.id);
    expect(server.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "conversation_moved" }));
  });

  test("does not re-home existing conversations on detached parent-notifying sends", async () => {
    const parentId = mkId("parent-notify-target");
    const childId = mkId("existing-detached-child");
    create(parentId, "openai", "gpt-5.4", "parent");
    create(childId, "openai", "gpt-5.4", "existing child");
    const subagentsFolder = ensureTopLevelFolder("subagents");
    expect(subagentsFolder).toBeTruthy();
    expect(getSummary(childId)?.folderId ?? null).toBeNull();
    setActiveJob(parentId, new AbortController(), Date.now());

    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);
    let finishChild!: (outcome: ReturnType<typeof makeAssistantOutcome>) => void;
    orchestrateSendMessage.mockImplementationOnce(() => new Promise((resolve) => {
      finishChild = resolve;
    }));

    await handle({} as never, {
      type: "send_message",
      reqId: "req-existing-detached",
      convId: childId,
      text: "continue this existing conversation",
      startedAt: 123,
      detached: true,
      notifyParent: { convId: parentId },
    });

    expect(sent).toContainEqual(expect.objectContaining({ type: "ack", reqId: "req-existing-detached", convId: childId }));
    expect(getSummary(childId)?.folderId ?? null).toBeNull();
    expect(getSummary(parentId)?.subagentCount).toBe(1);
    expect(getSummary(parentId)?.tasks).toEqual([
      { id: childId, kind: "subagent", title: "existing child", startedAt: 123 },
    ]);
    expect(server.broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: "conversation_updated",
      summary: expect.objectContaining({
        id: parentId,
        subagentCount: 1,
        tasks: [{ id: childId, kind: "subagent", title: "existing child", startedAt: 123 }],
      }),
    }));
    expect(server.broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "conversation_moved" }));

    finishChild(makeAssistantOutcome());
    await Promise.resolve();
    expect(getSummary(parentId)?.subagentCount).toBe(0);
    expect(getSummary(parentId)?.tasks).toEqual([]);
  });

  test("does not notify the parent when a detached subagent is deliberately aborted", async () => {
    const parentId = mkId("aborted-parent");
    const childId = mkId("aborted-child");
    create(parentId, "openai", "gpt-5.4", "parent");
    create(childId, "openai", "gpt-5.4", "child");

    const server = {
      sendTo: mock(() => {}),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);
    let finishChild!: (outcome: ReturnType<typeof makeAssistantOutcome>) => void;
    orchestrateSendMessage.mockImplementationOnce(() => new Promise((resolve) => {
      finishChild = resolve;
    }));

    await handle({} as never, {
      type: "send_message",
      reqId: "req-aborted-child",
      convId: childId,
      text: "cancel this task",
      startedAt: 123,
      detached: true,
      notifyParent: { convId: parentId },
    });
    expect(orchestrateSendMessage).toHaveBeenCalledTimes(1);

    finishChild(makeAssistantOutcome({ ok: false, error: "✗ Interrupted", aborted: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(getSummary(parentId)?.subagentCount).toBe(0);
    expect(orchestrateSendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("handler replay_conversation", () => {
  beforeEach(() => {
    orchestrateSendMessage.mockClear();
    orchestrateReplayConversation.mockClear();
    orchestrateGoalContinuation.mockClear();
    cleanupIds();
  });
  afterEach(cleanupIds);

  test("dispatches replay requests to the replay orchestrator", async () => {
    const server = {
      sendTo: mock(() => {}),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);
    const client = {} as never;

    await handle(client, {
      type: "replay_conversation",
      reqId: "req-1",
      convId: "conv-1",
      startedAt: 123_456,
    });

    expect(orchestrateReplayConversation).toHaveBeenCalledTimes(1);
    expect(orchestrateReplayConversation).toHaveBeenCalledWith(
      server,
      client,
      "req-1",
      "conv-1",
      123_456,
      expect.objectContaining({
        onHeaders: expect.any(Function),
        onComplete: expect.any(Function),
      }),
      { subagentMaxDepth: null },
    );
    expect(orchestrateSendMessage).not.toHaveBeenCalled();
  });

  test("manual replay preserves and completes a pre-restart parent notification", async () => {
    const parentId = mkId("manual-replay-parent");
    const childId = mkId("manual-replay-child");
    create(parentId, "openai", "gpt-5.4", "parent");
    create(childId, "openai", "gpt-5.4", "child");
    const childStartedAt = 654_321;
    get(childId)!.messages.push({
      role: "user",
      content: "finish after restart",
      metadata: { startedAt: childStartedAt, endedAt: childStartedAt, model: "gpt-5.4", tokens: 0 },
    });
    const pending = beginPendingSubagentNotification(
      { convId: parentId },
      childId,
      "finish after restart",
      childStartedAt,
      0,
    );
    setActiveJob(parentId, new AbortController(), Date.now());

    const server = {
      sendTo: mock(() => {}),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);
    orchestrateReplayConversation.mockResolvedValueOnce(makeAssistantOutcome());

    await handle({} as never, {
      type: "replay_conversation",
      reqId: "req-manual-subagent-replay",
      convId: childId,
      startedAt: Date.now(),
    });

    expect(orchestrateReplayConversation).toHaveBeenCalledWith(
      server,
      expect.anything(),
      "req-manual-subagent-replay",
      childId,
      expect.any(Number),
      expect.any(Object),
      { subagentMaxDepth: 0 },
    );
    expect(listPendingSubagentNotifications({ childConvId: childId })).toEqual([
      expect.objectContaining({ id: pending.id, state: "ready" }),
    ]);
    expect(getQueuedMessages(parentId)).toEqual([
      expect.objectContaining({
        subagentNotificationId: pending.id,
        text: expect.stringContaining(`exo:${childId}`),
      }),
    ]);
  });
});

describe("handler set_goal resume", () => {
  beforeEach(() => {
    orchestrateSendMessage.mockClear();
    orchestrateReplayConversation.mockClear();
    orchestrateGoalContinuation.mockClear();
    cleanupIds();
  });
  afterEach(cleanupIds);

  test("resumes a paused goal immediately when the conversation is idle", async () => {
    const convId = mkId("resume-idle");
    create(convId, "openai", "gpt-5.4");
    setGoal(convId, "finish the refactor");
    updateGoalStatus(convId, "paused");

    const subscriberEvents: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock(() => {}),
      broadcast: mock(() => {}),
      sendToSubscribers: mock((_convId: string, event: Record<string, unknown>) => { subscriberEvents.push(event); }),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "set_goal", reqId: "req-resume", convId, action: "resume" });

    expect(get(convId)?.goal).toMatchObject({ objective: "finish the refactor", status: "active" });
    expect(subscriberEvents).toContainEqual(expect.objectContaining({
      type: "goal_updated",
      reqId: "req-resume",
      convId,
      message: "Goal resumed.",
      goal: expect.objectContaining({ status: "active" }),
    }));
    expect(orchestrateGoalContinuation).toHaveBeenCalledTimes(1);
    expect(orchestrateGoalContinuation).toHaveBeenCalledWith(
      server,
      convId,
      expect.objectContaining({
        onHeaders: expect.any(Function),
        onComplete: expect.any(Function),
      }),
      { subagentMaxDepth: null },
    );
  });

  test("resumes a paused goal while streaming without starting a second stream", async () => {
    const convId = mkId("resume-streaming");
    create(convId, "openai", "gpt-5.4");
    setGoal(convId, "finish the refactor");
    updateGoalStatus(convId, "paused");
    setActiveJob(convId, new AbortController(), Date.now());

    const sent: Array<Record<string, unknown>> = [];
    const subscriberEvents: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock((_convId: string, event: Record<string, unknown>) => { subscriberEvents.push(event); }),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "set_goal", reqId: "req-resume-streaming", convId, action: "resume" });

    expect(sent).not.toContainEqual(expect.objectContaining({ type: "error" }));
    expect(get(convId)?.goal).toMatchObject({ objective: "finish the refactor", status: "active" });
    expect(subscriberEvents).toContainEqual(expect.objectContaining({
      type: "goal_updated",
      reqId: "req-resume-streaming",
      convId,
      message: "Goal resumed.",
      goal: expect.objectContaining({ status: "active" }),
    }));
    expect(consumeGoalContinuationAfterStream(convId)).toBe(true);
    expect(orchestrateGoalContinuation).not.toHaveBeenCalled();
  });

  test("completing a goal clears it and returns a null goal update", async () => {
    const convId = mkId("complete-clears");
    create(convId, "openai", "gpt-5.4");
    setGoal(convId, "finish the refactor");

    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "set_goal", reqId: "req-complete", convId, action: "complete" });

    expect(get(convId)?.goal).toBeNull();
    expect(sent).toContainEqual(expect.objectContaining({
      type: "goal_updated",
      reqId: "req-complete",
      convId,
      message: "Goal complete.",
      goal: null,
    }));
  });
});

describe("handler abort", () => {
  beforeEach(() => {
    orchestrateSendMessage.mockClear();
    orchestrateReplayConversation.mockClear();
    orchestrateGoalContinuation.mockClear();
    cleanupIds();
  });
  afterEach(cleanupIds);

  test("interrupting an active goal leaves it active for implicit resume", async () => {
    const convId = mkId("abort-active-goal");
    create(convId, "openai", "gpt-5.4");
    setGoal(convId, "finish the long task");
    const ac = new AbortController();
    setActiveJob(convId, ac, Date.now());

    const subscriberEvents: Array<Record<string, unknown>> = [];
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock((_convId: string, event: Record<string, unknown>) => { subscriberEvents.push(event); }),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "abort", reqId: "req-abort", convId });

    expect(ac.signal.aborted).toBe(true);
    expect(get(convId)?.goal).toMatchObject({ status: "active" });
    expect(subscriberEvents).not.toContainEqual(expect.objectContaining({
      type: "goal_updated",
      convId,
    }));
    expect(sent).toContainEqual(expect.objectContaining({ type: "ack", reqId: "req-abort", convId }));
  });
});

describe("handler OpenAI account mutation safety", () => {
  beforeEach(cleanupIds);
  afterEach(cleanupIds);

  test("rejects an account switch while any OpenAI conversation is streaming", async () => {
    const convId = mkId("account-streaming");
    create(convId, "openai", "gpt-5.6-sol");
    setActiveJob(convId, new AbortController(), Date.now());

    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, {
      type: "account",
      reqId: "req-account-streaming",
      provider: "openai",
      target: "other@example.com",
    });

    expect(sent).toContainEqual(expect.objectContaining({
      type: "error",
      reqId: "req-account-streaming",
      message: expect.stringContaining("while an OpenAI conversation is streaming"),
    }));
    expect(sent).not.toContainEqual(expect.objectContaining({ type: "auth_status" }));
  });
});

describe("handler load_conversation late-join streaming snapshots", () => {
  beforeEach(() => {
    orchestrateSendMessage.mockClear();
    orchestrateReplayConversation.mockClear();
    orchestrateGoalContinuation.mockClear();
    cleanupIds();
  });
  afterEach(cleanupIds);

  test("does not send streaming_started after the final assistant reply is already committed", async () => {
    const convId = mkId("finished-window");
    create(convId, "openai", "gpt-5.4");
    const conv = get(convId)!;
    conv.messages.push({ role: "user", content: "hi", metadata: null });
    conv.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "full final reply" }],
      metadata: { startedAt: 1, endedAt: 2, model: "gpt-5.4", tokens: 7 },
    });

    setActiveJob(convId, new AbortController(), 1);
    initStreamingState(convId);
    replaceCurrentStreamingBlocks(convId, [{ type: "text", text: "partial tail" }]);

    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "load_conversation", convId });

    expect(sent.map((event) => event.type)).toEqual(["conversation_loaded"]);
    expect(sent[0]).toMatchObject({
      type: "conversation_loaded",
      entries: [
        { type: "user", text: "hi" },
        {
          type: "ai",
          blocks: [{ type: "text", text: "full final reply" }],
          metadata: { startedAt: 1, endedAt: 2, model: "gpt-5.4", tokens: 7 },
        },
      ],
    });
    expect(sent[0]).not.toHaveProperty("pendingAI");
  });

  test("omits old image base64 from compact conversation load payloads", async () => {
    const convId = mkId("compact-old-images");
    create(convId, "openai", "gpt-5.4");
    const conv = get(convId)!;
    const oldImageBase64 = "a".repeat(1024);
    conv.messages.push({
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: oldImageBase64 } }],
      metadata: null,
    });
    for (let i = 0; i < 8; i++) conv.messages.push({ role: "assistant", content: `reply ${i}`, metadata: null });

    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "load_conversation", convId });

    const firstEntry = (sent[0] as { entries: Array<{ images?: Array<{ mediaType: string; base64: string; sizeBytes: number }> }> }).entries[0];
    expect(firstEntry.images?.[0]).toEqual({ mediaType: "image/png", base64: "", sizeBytes: 768 });
  });

  test("keeps recent image base64 in compact conversation load payloads", async () => {
    const convId = mkId("compact-recent-images");
    create(convId, "openai", "gpt-5.4");
    const conv = get(convId)!;
    const recentImageBase64 = "b".repeat(1024);
    conv.messages.push({ role: "assistant", content: "older reply", metadata: null });
    conv.messages.push({
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: recentImageBase64 } }],
      metadata: null,
    });

    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "load_conversation", convId });

    const userEntry = (sent[0] as { entries: Array<{ type: string; images?: Array<{ mediaType: string; base64: string; sizeBytes: number }> }> }).entries.find(entry => entry.type === "user");
    expect(userEntry?.images?.[0]).toEqual({ mediaType: "image/png", base64: recentImageBase64, sizeBytes: 768 });
  });

  test("includes the live assistant snapshot in conversation_loaded and still sends streaming_started for catch-up", async () => {
    const convId = mkId("live-window");
    create(convId, "openai", "gpt-5.4");
    const conv = get(convId)!;
    conv.messages.push({ role: "user", content: "hi", metadata: null });

    setActiveJob(convId, new AbortController(), 1);
    initStreamingState(convId);
    replaceCurrentStreamingBlocks(convId, [{ type: "text", text: "partial tail" }]);

    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "load_conversation", convId });

    expect(sent.map((event) => event.type)).toEqual(["conversation_loaded", "streaming_started"]);
    expect(sent[0]).toMatchObject({
      type: "conversation_loaded",
      pendingAI: {
        blocks: [{ type: "text", text: "partial tail" }],
        metadata: { startedAt: 1, endedAt: null, model: "gpt-5.4", tokens: 0 },
      },
    });
    expect(sent[1]).toMatchObject({
      type: "streaming_started",
      startedAt: 1,
      blocks: [{ type: "text", text: "partial tail" }],
      tokens: 0,
    });
  });

  test("late-join snapshots keep completed active-turn rounds in pendingAI even before the next tail starts", async () => {
    const convId = mkId("round-boundary");
    create(convId, "openai", "gpt-5.4");
    const conv = get(convId)!;
    conv.messages.push({ role: "user", content: "hi", metadata: null });

    setActiveJob(convId, new AbortController(), 100);
    initStreamingState(convId);
    replaceStreamingDisplayMessages(convId, [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }],
        metadata: null,
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "/tmp", is_error: false }],
        metadata: null,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done with the tool round" }],
        metadata: null,
      },
    ]);

    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "load_conversation", convId });

    expect(sent.map((event) => event.type)).toEqual(["conversation_loaded", "streaming_started"]);
    expect(sent[0]).toMatchObject({
      type: "conversation_loaded",
      entries: [{ type: "user", text: "hi" }],
      pendingAI: {
        blocks: [
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", summary: "pwd" },
          { type: "tool_result", toolCallId: "call-1", toolName: "", output: "", isError: false },
          { type: "text", text: "done with the tool round" },
        ],
        metadata: { startedAt: 100, endedAt: null, model: "gpt-5.4", tokens: 0 },
      },
    });
    expect(sent[1]).toMatchObject({
      type: "streaming_started",
      startedAt: 100,
      blocks: [
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", summary: "pwd" },
        { type: "tool_result", toolCallId: "call-1", toolName: "", output: "", isError: false },
        { type: "text", text: "done with the tool round" },
      ],
      tokens: 0,
    });
  });

  test("late-join snapshots keep text streamed after a tool-round boundary", async () => {
    const convId = mkId("post-round-text");
    create(convId, "openai", "gpt-5.4");
    const conv = get(convId)!;
    conv.messages.push({ role: "user", content: "make a game", metadata: null });

    setActiveJob(convId, new AbortController(), 100);
    initStreamingState(convId);
    replaceStreamingDisplayMessages(convId, [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "cc --version" } }],
        metadata: null,
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "cc ok", is_error: false }],
        metadata: null,
      },
    ]);
    // Mirrors orchestrator.onRoundComplete(): completed tool round is now in
    // streamingDisplayMessages and the next API round starts with fresh text.
    clearCurrentStreamingBlocks(convId);
    appendToStreamingBlock(convId, "text", "Planning an ncurses game after the compiler check.");

    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "load_conversation", convId });

    expect(sent[0]).toMatchObject({
      type: "conversation_loaded",
      pendingAI: {
        blocks: [
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", summary: "cc --version" },
          { type: "tool_result", toolCallId: "call-1", output: "", isError: false },
          { type: "text", text: "Planning an ncurses game after the compiler check." },
        ],
      },
    });
    expect(sent[1]).toMatchObject({
      type: "streaming_started",
      blocks: [
        { type: "tool_call", toolCallId: "call-1" },
        { type: "tool_result", toolCallId: "call-1" },
        { type: "text", text: "Planning an ncurses game after the compiler check." },
      ],
    });
  });

  test("includes the live replay snapshot even when persisted history already ends in assistant/system messages", async () => {
    const convId = mkId("replay-window");
    create(convId, "openai", "gpt-5.4");
    const conv = get(convId)!;
    conv.messages.push({ role: "user", content: "hi", metadata: { startedAt: 1, endedAt: 1, model: "gpt-5.4", tokens: 0 } });
    conv.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "partial old reply" }],
      metadata: { startedAt: 2, endedAt: 3, model: "gpt-5.4", tokens: 12 },
    });
    conv.messages.push({ role: "system", content: "✗ Interrupted", metadata: null });

    setActiveJob(convId, new AbortController(), 100);
    initStreamingState(convId);
    replaceStreamingDisplayMessages(convId, [{
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }],
      metadata: null,
    }]);
    replaceCurrentStreamingBlocks(convId, [{ type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "/tmp", isError: false }]);

    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, { type: "load_conversation", convId });

    expect(sent.map((event) => event.type)).toEqual(["conversation_loaded", "streaming_started"]);
    expect(sent[0]).toMatchObject({
      type: "conversation_loaded",
      entries: [
        { type: "user", text: "hi" },
        {
          type: "ai",
          blocks: [{ type: "text", text: "partial old reply" }],
          metadata: { startedAt: 2, endedAt: 3, model: "gpt-5.4", tokens: 12 },
        },
        { type: "system", text: "✗ Interrupted", color: "error" },
      ],
      pendingAI: {
        blocks: [
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", summary: "pwd" },
          { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "/tmp", isError: false },
        ],
        metadata: { startedAt: 100, endedAt: null, model: "gpt-5.4", tokens: 0 },
      },
    });
    expect(sent[1]).toMatchObject({
      type: "streaming_started",
      startedAt: 100,
      blocks: [
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", summary: "pwd" },
        { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "/tmp", isError: false },
      ],
      tokens: 0,
    });
  });

  test("repeated replay refocuses keep the latest in-progress assistant tail", async () => {
    const convId = mkId("replay-refocus");
    const otherConvId = mkId("other-conv");
    create(convId, "openai", "gpt-5.4");
    create(otherConvId, "openai", "gpt-5.4");
    const conv = get(convId)!;
    conv.messages.push({ role: "user", content: "hi", metadata: { startedAt: 1, endedAt: 1, model: "gpt-5.4", tokens: 0 } });
    conv.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "partial old reply" }],
      metadata: { startedAt: 2, endedAt: 3, model: "gpt-5.4", tokens: 12 },
    });
    conv.messages.push({ role: "system", content: "✗ Interrupted", metadata: null });

    setActiveJob(convId, new AbortController(), 100);
    initStreamingState(convId);
    replaceStreamingDisplayMessages(convId, [{
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }],
      metadata: null,
    }]);
    replaceCurrentStreamingBlocks(convId, [{ type: "text", text: "hello" }]);

    let sentNow: Array<Record<string, unknown>> = [];
    const server = {
      sendTo(_client: unknown, event: Record<string, unknown>) { sentNow.push(event); },
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    const sentA1: Array<Record<string, unknown>> = [];
    sentNow = sentA1;
    await handle({} as never, { type: "load_conversation", convId });

    const sentB: Array<Record<string, unknown>> = [];
    sentNow = sentB;
    await handle({} as never, { type: "load_conversation", convId: otherConvId });

    replaceCurrentStreamingBlocks(convId, [{ type: "text", text: "hello world" }]);

    const sentA2: Array<Record<string, unknown>> = [];
    sentNow = sentA2;
    await handle({} as never, { type: "load_conversation", convId });

    expect(sentA1.map((event) => event.type)).toEqual(["conversation_loaded", "streaming_started"]);
    expect(sentA1[0]).toMatchObject({
      type: "conversation_loaded",
      entries: [
        { type: "user", text: "hi" },
        {
          type: "ai",
          blocks: [{ type: "text", text: "partial old reply" }],
          metadata: { startedAt: 2, endedAt: 3, model: "gpt-5.4", tokens: 12 },
        },
        { type: "system", text: "✗ Interrupted", color: "error" },
      ],
      pendingAI: {
        blocks: [
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", summary: "pwd" },
          { type: "text", text: "hello" },
        ],
        metadata: { startedAt: 100, endedAt: null, model: "gpt-5.4", tokens: 0 },
      },
    });

    expect(sentB.map((event) => event.type)).toEqual(["conversation_loaded"]);

    expect(sentA2.map((event) => event.type)).toEqual(["conversation_loaded", "streaming_started"]);
    expect(sentA2[0]).toMatchObject({
      type: "conversation_loaded",
      pendingAI: {
        blocks: [
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", summary: "pwd" },
          { type: "text", text: "hello world" },
        ],
        metadata: { startedAt: 100, endedAt: null, model: "gpt-5.4", tokens: 0 },
      },
    });
    expect(sentA2[1]).toMatchObject({
      type: "streaming_started",
      startedAt: 100,
      blocks: [
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", summary: "pwd" },
        { type: "text", text: "hello world" },
      ],
      tokens: 0,
    });
  });
});
