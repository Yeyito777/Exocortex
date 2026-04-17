import { beforeEach, describe, expect, mock, test } from "bun:test";
import { create, get, remove } from "./conversations";
import { clearActiveJob, initStreamingState, replaceCurrentStreamingBlocks, setActiveJob } from "./streaming";

const orchestrateSendMessage = mock(async () => {});
const orchestrateReplayConversation = mock(async () => {});

mock.module("./orchestrator", () => ({
  orchestrateSendMessage,
  orchestrateReplayConversation,
}));

const { createHandler } = await import("./handler");

const IDS: string[] = [];

function mkId(suffix: string): string {
  const id = `handler-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  return id;
}

describe("handler replay_conversation", () => {
  beforeEach(() => {
    orchestrateSendMessage.mockClear();
    orchestrateReplayConversation.mockClear();
    for (const id of IDS.splice(0)) {
      clearActiveJob(id);
      remove(id);
    }
  });

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
    );
    expect(orchestrateSendMessage).not.toHaveBeenCalled();
  });
});

describe("handler load_conversation late-join streaming snapshots", () => {
  beforeEach(() => {
    orchestrateSendMessage.mockClear();
    orchestrateReplayConversation.mockClear();
    for (const id of IDS.splice(0)) {
      clearActiveJob(id);
      remove(id);
    }
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
  });

  test("still sends streaming_started while the live reply is genuinely in flight", async () => {
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
  });
});
