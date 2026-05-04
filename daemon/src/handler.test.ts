import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { create, get, remove, replaceStreamingDisplayMessages } from "./conversations";
import { DEFAULT_EFFORT, DEFAULT_MODEL_BY_PROVIDER, DEFAULT_PROVIDER_ID } from "./messages";
import { appendToStreamingBlock, clearActiveJob, clearCurrentStreamingBlocks, initStreamingState, replaceCurrentStreamingBlocks, setActiveJob } from "./streaming";

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

function cleanupIds(): void {
  for (const id of IDS.splice(0)) {
    clearActiveJob(id);
    remove(id);
  }
}

describe("handler new_conversation defaults", () => {
  beforeEach(() => {
    orchestrateSendMessage.mockClear();
    orchestrateReplayConversation.mockClear();
    cleanupIds();
  });
  afterEach(cleanupIds);

  test("uses OpenAI GPT-5.5 high effort when the client omits model settings", async () => {
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
      effort: DEFAULT_EFFORT,
      fastMode: false,
    });

    const convId = created?.convId as string | undefined;
    expect(convId).toBeTruthy();
    if (convId) {
      IDS.push(convId);
      expect(get(convId)).toMatchObject({
        provider: DEFAULT_PROVIDER_ID,
        model: DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER_ID],
        effort: DEFAULT_EFFORT,
        fastMode: false,
      });
    }
  });
});

describe("handler replay_conversation", () => {
  beforeEach(() => {
    orchestrateSendMessage.mockClear();
    orchestrateReplayConversation.mockClear();
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
    );
    expect(orchestrateSendMessage).not.toHaveBeenCalled();
  });
});

describe("handler load_conversation late-join streaming snapshots", () => {
  beforeEach(() => {
    orchestrateSendMessage.mockClear();
    orchestrateReplayConversation.mockClear();
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
