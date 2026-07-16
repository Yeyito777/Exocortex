import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { clearConversationDefaults, saveConversationDefaults } from "@exocortex/shared/config";
import { consumeGoalContinuationAfterStream, create, deleteFolder, ensureTopLevelFolder, findTopLevelFolderByName, get, getQueuedMessageById, getQueuedMessages, getSummary, listQueuedMessages, pushGlobalIdleQueuedMessage, remove, removeQueuedMessageById, replaceStreamingDisplayMessages, setGoal, updateGoalStatus } from "./conversations";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID, defaultEffortForModelId } from "./messages";
import { appendToStreamingBlock, clearActiveJob, clearCurrentStreamingBlocks, initStreamingState, replaceCurrentStreamingBlocks, setActiveJob } from "./streaming";
import { beginPendingSubagentNotification, listPendingSubagentNotifications, removePendingSubagentNotificationsForConversation } from "./subagent-notifications";
import { getDaemonShutdownMode, resetDaemonShutdownModeForTest } from "./daemon-lifecycle";
import { invalidateCredentialsCache } from "./auth";
import { clearProviderAuth, saveProviderAuth } from "./store";
import { resetExternalNotificationsForTest } from "./external-notifications";

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
const orchestrateCompactConversation = mock(async () => makeAssistantOutcome());
const orchestrateGoalContinuation = mock(async () => {});

mock.module("./orchestrator", () => ({
  orchestrateSendMessage,
  orchestrateReplayConversation,
  orchestrateCompactConversation,
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

describe("handler daemon-owned queue", () => {
  afterEach(cleanupIds);

  test("starts an ordinary queued message even when the conversation was already idle", async () => {
    const id = mkId("queue-idle");
    create(id, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]);
    const server = {
      sendTo: mock(() => {}), broadcast: mock(() => {}), sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}), subscribe: mock(() => {}), unsubscribe: mock(() => {}), hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);
    const callsBefore = orchestrateSendMessage.mock.calls.length;

    await handle({} as never, { type: "queue_message", queueId: "idle-dispatch", convId: id, text: "run me", timing: "message-end" });
    await new Promise(resolve => setTimeout(resolve, 180));

    expect(orchestrateSendMessage.mock.calls.length).toBe(callsBefore + 1);
    const lastCall = orchestrateSendMessage.mock.calls.at(-1) as unknown as unknown[];
    expect(lastCall[4]).toBe("run me");
    expect(lastCall[8]).toEqual(expect.objectContaining({ queueEntryId: "idle-dispatch" }));
    removeQueuedMessageById("idle-dispatch");
  });

  test("waits in the daemon for a targeted conversation to become idle", async () => {
    const targetId = mkId("queue-target");
    const dependencyId = mkId("queue-dependency");
    create(targetId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]);
    create(dependencyId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]);
    setActiveJob(dependencyId, new AbortController(), Date.now());
    const server = {
      sendTo: mock(() => {}), broadcast: mock(() => {}), sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}), subscribe: mock(() => {}), unsubscribe: mock(() => {}), hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);
    const callsBefore = orchestrateSendMessage.mock.calls.length;

    await handle({} as never, {
      type: "queue_message",
      queueId: "targeted-idle",
      convId: targetId,
      text: "after dependency",
      timing: "message-end",
      source: "global-idle",
      target: "conversation",
      waitTarget: { type: "conversation", convId: dependencyId, label: "Dependency" },
    });
    await new Promise(resolve => setTimeout(resolve, 170));
    expect(orchestrateSendMessage.mock.calls.length).toBe(callsBefore);

    clearActiveJob(dependencyId);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(orchestrateSendMessage.mock.calls.length).toBe(callsBefore + 1);
    expect((orchestrateSendMessage.mock.calls.at(-1) as unknown as unknown[])[4]).toBe("after dependency");
    removeQueuedMessageById("targeted-idle");
  });

  test("keeps the global-idle FIFO blocked until the accepted head turn finishes", async () => {
    const firstId = mkId("queue-global-first");
    const secondId = mkId("queue-global-second");
    create(firstId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]);
    create(secondId, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]);
    const server = {
      sendTo: mock(() => {}), broadcast: mock(() => {}), sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}), subscribe: mock(() => {}), unsubscribe: mock(() => {}), hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);
    const callsBefore = orchestrateSendMessage.mock.calls.length;
    let finishFirst!: (outcome: ReturnType<typeof makeAssistantOutcome>) => void;
    orchestrateSendMessage.mockImplementationOnce(() => new Promise((resolve) => {
      finishFirst = resolve;
    }));

    await handle({} as never, {
      type: "queue_message",
      queueId: "global-fifo-first",
      convId: firstId,
      text: "first global turn",
      timing: "message-end",
      source: "global-idle",
      target: "conversation",
    });
    await handle({} as never, {
      type: "queue_message",
      queueId: "global-fifo-second",
      convId: secondId,
      text: "second global turn",
      timing: "message-end",
      source: "global-idle",
      target: "conversation",
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(orchestrateSendMessage.mock.calls.length).toBe(callsBefore + 1);
    expect((orchestrateSendMessage.mock.calls.at(-1) as unknown as unknown[])[4]).toBe("first global turn");

    // Real orchestration removes the durable entry immediately after accepting
    // its user message, while the assistant turn is still in flight.
    removeQueuedMessageById("global-fifo-first");
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(orchestrateSendMessage.mock.calls.length).toBe(callsBefore + 1);

    finishFirst(makeAssistantOutcome());
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(orchestrateSendMessage.mock.calls.length).toBe(callsBefore + 2);
    expect((orchestrateSendMessage.mock.calls.at(-1) as unknown as unknown[])[4]).toBe("second global turn");
    removeQueuedMessageById("global-fifo-second");
  });

  test("atomically creates queued draft conversations and broadcasts the shared queue", async () => {
    const id = `${Date.now()}-abc123`;
    IDS.push(id);
    const sent: Array<Record<string, unknown>> = [];
    const broadcasts: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock((event: Record<string, unknown>) => { broadcasts.push(event); }),
      sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, {
      type: "queue_message",
      queueId: "shared-queue-id",
      convId: id,
      text: "start after idle",
      timing: "message-end",
      source: "global-idle",
      target: "new-conversation",
      provider: "openai",
      model: DEFAULT_MODEL_BY_PROVIDER.openai,
      effort: "medium",
      fastMode: false,
      waitTarget: { type: "global" },
    });

    expect(get(id)).not.toBeNull();
    expect(getQueuedMessageById("shared-queue-id")).toEqual(expect.objectContaining({
      convId: id,
      text: "start after idle",
      source: "global-idle",
      target: "new-conversation",
    }));
    expect(sent.some(event => event.type === "conversation_created" && event.convId === id)).toBe(true);
    expect(broadcasts.some(event => event.type === "queue_updated"
      && (event.messages as Array<{ id: string }>).some(message => message.id === "shared-queue-id"))).toBe(true);
    removeQueuedMessageById("shared-queue-id");
  });

  test("reconstructs a draft if the daemon restarts after queue persistence but before conversation creation", async () => {
    const id = `${Date.now()}-def456`;
    IDS.push(id);
    const server = {
      sendTo: mock(() => {}), broadcast: mock(() => {}), sendToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}), subscribe: mock(() => {}), unsubscribe: mock(() => {}), hasSubscribers: mock(() => false),
    };
    createHandler(server as never);
    pushGlobalIdleQueuedMessage(id, "recover draft", undefined, {
      id: "recover-draft-id",
      target: "new-conversation",
      provider: DEFAULT_PROVIDER_ID,
      model: DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID],
      effort: "medium",
      fastMode: false,
    });

    await new Promise(resolve => setTimeout(resolve, 180));

    expect(get(id)).toEqual(expect.objectContaining({ id, provider: DEFAULT_PROVIDER_ID }));
    expect(getQueuedMessageById("recover-draft-id")).not.toBeUndefined();
    removeQueuedMessageById("recover-draft-id");
  });

  test("bootstraps another client with the same authoritative queue snapshot", async () => {
    const id = mkId("queue-bootstrap");
    create(id, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID]);
    setActiveJob(id, new AbortController(), Date.now());
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

    await handle({} as never, { type: "queue_message", queueId: "bootstrap-id", convId: id, text: "later", timing: "next-turn" });
    sent.length = 0;
    await handle({} as never, { type: "list_conversations" });

    const snapshot = sent.find(event => event.type === "queue_updated");
    expect((snapshot?.messages as Array<Record<string, unknown>>).some(message =>
      message.id === "bootstrap-id" && message.convId === id && message.text === "later",
    )).toBe(true);
    expect(listQueuedMessages().some(message => message.id === "bootstrap-id")).toBe(true);
  });
});

describe("handler external notification routing", () => {
  afterEach(() => {
    resetExternalNotificationsForTest();
    cleanupIds();
  });

  test("registers, subscribes, durably queues, and deduplicates wake notifications", async () => {
    resetExternalNotificationsForTest();
    const id = mkId("external-wake");
    create(id, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "External target");
    setActiveJob(id, new AbortController(), Date.now());
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendHistoryUpdatedToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);

    await handle({} as never, {
      type: "register_external_notification_source",
      reqId: "source",
      toolName: "discord",
      source: { id: "account:paramount:notifications", label: "Paramount · DMs and @mentions" },
    });
    await handle({} as never, {
      type: "subscribe_external_notification",
      reqId: "subscribe",
      toolName: "discord",
      sourceId: "account:paramount:notifications",
      convId: id,
      delivery: "wake",
    });
    await handle({} as never, {
      type: "publish_external_notification",
      reqId: "publish-1",
      toolName: "discord",
      sourceId: "account:paramount:notifications",
      eventId: "discord-message-1",
      text: "DM from Fede: hello",
    });
    await handle({} as never, {
      type: "publish_external_notification",
      reqId: "publish-duplicate",
      toolName: "discord",
      sourceId: "account:paramount:notifications",
      eventId: "discord-message-1",
      text: "DM from Fede: hello",
    });

    const queued = getQueuedMessages(id);
    expect(queued).toHaveLength(1);
    expect(queued[0].text).toContain("untrusted external content");
    expect(queued[0].text).toContain("DM from Fede: hello");
    expect(sent.find(event => event.reqId === "publish-1")).toEqual(expect.objectContaining({
      type: "external_notification_publish_result",
      deliveries: [expect.objectContaining({ status: "queued", convId: id })],
    }));
    expect(sent.find(event => event.reqId === "publish-duplicate")).toEqual(expect.objectContaining({
      deliveries: [expect.objectContaining({ status: "duplicate", convId: id })],
    }));
    removeQueuedMessageById(queued[0].id);
  });

  test("records inbox notifications without starting a model turn", async () => {
    resetExternalNotificationsForTest();
    const id = mkId("external-inbox");
    create(id, DEFAULT_PROVIDER_ID, DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID], "Inbox target");
    const sent: Array<Record<string, unknown>> = [];
    const server = {
      sendTo: mock((_client: unknown, event: Record<string, unknown>) => { sent.push(event); }),
      broadcast: mock(() => {}),
      sendToSubscribers: mock(() => {}),
      sendHistoryUpdatedToSubscribers: mock(() => {}),
      sendToSubscribersExcept: mock(() => {}),
      subscribe: mock(() => {}),
      unsubscribe: mock(() => {}),
      hasSubscribers: mock(() => false),
    };
    const handle = createHandler(server as never);
    const callsBefore = orchestrateSendMessage.mock.calls.length;

    await handle({} as never, {
      type: "subscribe_external_notification",
      toolName: "whatsapp",
      sourceId: "incoming-messages",
      sourceLabel: "Incoming WhatsApp messages",
      convId: id,
      delivery: "inbox",
    });
    await handle({} as never, {
      type: "publish_external_notification",
      reqId: "inbox-publish",
      toolName: "whatsapp",
      sourceId: "incoming-messages",
      eventId: "wa-message-1",
      text: "Message from Mom: hi",
    });

    expect(orchestrateSendMessage.mock.calls.length).toBe(callsBefore);
    expect(get(id)?.messages.at(-1)).toEqual(expect.objectContaining({
      role: "user",
      content: expect.stringContaining("Message from Mom: hi"),
      metadata: expect.objectContaining({ system: true, kind: "external_notification" }),
    }));
    expect(sent.find(event => event.reqId === "inbox-publish")).toEqual(expect.objectContaining({
      deliveries: [expect.objectContaining({ status: "inbox", convId: id })],
    }));
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

describe("handler background task notifications", () => {
  beforeEach(() => {
    orchestrateSendMessage.mockClear();
    orchestrateReplayConversation.mockClear();
    orchestrateGoalContinuation.mockClear();
    cleanupIds();
  });
  afterEach(cleanupIds);

  test("queues a completion for the next turn when its conversation is still streaming", async () => {
    const convId = mkId("background-completion");
    create(convId, "openai", "gpt-5.4", "parent");
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

    await handle({} as never, {
      type: "send_message",
      reqId: "req-background-completion",
      convId,
      text: "start work",
      startedAt: 123,
    });
    const callbacks = (orchestrateSendMessage.mock.calls as unknown[][])[0]?.[6] as {
      onBackgroundTaskComplete?: (completion: {
        taskId: string;
        toolName: string;
        title: string;
        startedAt: number;
        endedAt: number;
        exitCode: number | null;
        signal: string | null;
        outputPath?: string;
      }) => void;
    };
    expect(callbacks.onBackgroundTaskComplete).toBeFunction();

    setActiveJob(convId, new AbortController(), Date.now());
    callbacks.onBackgroundTaskComplete?.({
      taskId: "bash:1234",
      toolName: "bash",
      title: "bun test tui",
      startedAt: 1_000,
      endedAt: 2_500,
      exitCode: 0,
      signal: null,
      outputPath: "/tmp/bash-output.tmp",
    });

    expect(orchestrateSendMessage).toHaveBeenCalledTimes(1);
    expect(getQueuedMessages(convId)).toEqual([
      expect.objectContaining({
        timing: "next-turn",
        text: expect.stringContaining("[notification] Background task completed: bash:1234"),
      }),
    ]);
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

describe("handler compact_conversation", () => {
  beforeEach(() => {
    orchestrateCompactConversation.mockClear();
  });

  test("dispatches manual compaction requests to the compaction orchestrator", async () => {
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
      type: "compact_conversation",
      reqId: "req-compact",
      convId: "conv-1",
      startedAt: 123_456,
    });

    expect(orchestrateCompactConversation).toHaveBeenCalledTimes(1);
    expect(orchestrateCompactConversation).toHaveBeenCalledWith(
      server,
      client,
      "req-compact",
      "conv-1",
      123_456,
      expect.objectContaining({
        onHeaders: expect.any(Function),
        onComplete: expect.any(Function),
      }),
    );
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

  test("opens with five turns and serves older turns before the returned cursor", async () => {
    const convId = mkId("paged-history");
    create(convId, "openai", "gpt-5.4");
    const conv = get(convId)!;
    for (let turn = 1; turn <= 7; turn++) {
      conv.messages.push({ role: "user", content: `u${turn}`, metadata: null });
      conv.messages.push({ role: "assistant", content: `a${turn}`, metadata: null });
    }

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
    const client = { capabilities: new Set<string>() };

    await handle(client as never, { type: "load_conversation", convId, turns: 5 });

    expect(sent[0]).toMatchObject({
      type: "conversation_loaded",
      historyStartIndex: 4,
      historyStartUserIndex: 2,
      historyTotalEntries: 14,
      hasOlderHistory: true,
    });
    expect((sent[0].entries as Array<{ type: string; text?: string }>)
      .filter((entry) => entry.type === "user").map((entry) => entry.text))
      .toEqual(["u3", "u4", "u5", "u6", "u7"]);

    sent.length = 0;
    await handle(client as never, {
      type: "load_conversation_history",
      convId,
      beforeEntryIndex: 4,
      turns: 2,
    });

    expect(sent[0]).toMatchObject({
      type: "conversation_history_loaded",
      historyStartIndex: 0,
      historyStartUserIndex: 0,
      historyEndIndex: 4,
      historyTotalEntries: 14,
      hasOlderHistory: false,
    });
    expect((sent[0].entries as Array<{ type: string; text?: string }>)
      .filter((entry) => entry.type === "user").map((entry) => entry.text))
      .toEqual(["u1", "u2"]);

    sent.length = 0;
    const legacyClient = { capabilities: new Set<string>() };
    await handle(legacyClient as never, { type: "load_conversation", convId });
    expect((sent[0].entries as Array<{ type: string; text?: string }>)
      .filter((entry) => entry.type === "user")).toHaveLength(7);
    expect(sent[0]).not.toHaveProperty("historyStartIndex");
  });

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

  test("defers tool-result bodies until the client explicitly loads them", async () => {
    const convId = mkId("compact-tool-results");
    create(convId, "openai", "gpt-5.4");
    const conv = get(convId)!;
    conv.messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "pwd" } }],
      metadata: null,
    }, {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: "large result body", is_error: false }],
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

    await handle({ capabilities: new Set<string>() } as never, { type: "load_conversation", convId, turns: 5 });

    expect(sent[0]).toMatchObject({
      type: "conversation_loaded",
      toolOutputsIncluded: false,
      entries: [{
        type: "ai",
        blocks: [
          { type: "tool_call", toolCallId: "call-1" },
          { type: "tool_result", toolCallId: "call-1", output: "" },
        ],
      }],
    });
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
