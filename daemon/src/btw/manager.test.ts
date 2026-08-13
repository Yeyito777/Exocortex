import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { appendBtwQueryInstructions, BTW_READ_ONLY_TOOLS, BtwSessionManager } from ".";
import * as convStore from "../conversations";
import type { ApiMessage, ConversationBtw } from "../messages";
import type { Event } from "../protocol";
import type { ConnectedClient, DaemonServer } from "../server";
import { loadConversationBtwState, saveConversationBtwState } from "../persistence";
import { appendToStreamingBlock, clearActiveJob, clearCurrentStreamingBlocks, initStreamingState, pushStreamingBlock, setActiveJob } from "../streaming";
import { buildExecutor, getToolDefs } from "../tools/registry";
import { buildConversationRequestSurface } from "../conversation-request-surface";
import { ensureConversationWorkspace } from "../workspace-service";

type RunAgentLoop = typeof import("../agent").runAgentLoop;

function testClient(id: string, subscriptions: string[] = []): ConnectedClient {
  return {
    id,
    socket: new EventEmitter() as ConnectedClient["socket"],
    subscriptions: new Set(subscriptions),
    buffer: "",
    capabilities: new Set<"history-pagination">(),
  };
}

function testServer(clients: ConnectedClient[], events: Map<string, Event[]>): DaemonServer {
  const sendTo = (client: ConnectedClient, event: Event) => {
    const received = events.get(client.id) ?? [];
    received.push(event);
    events.set(client.id, received);
    return 0;
  };
  return {
    sendTo,
    sendToSubscribers(convId: string, event: Event) {
      for (const client of clients) {
        if (client.subscriptions.has(convId)) sendTo(client, event);
      }
    },
  } as unknown as DaemonServer;
}

function cloneStates(states: ReadonlyMap<string, ConversationBtw>): Map<string, ConversationBtw> {
  return new Map([...states].map(([convId, btw]) => [convId, { ...btw }]));
}

function emptyPersistenceState() {
  return { btws: new Map<string, ConversationBtw>(), seenSessionIds: new Map<string, Set<string>>() };
}

function clonePersistenceState(state: ReturnType<typeof emptyPersistenceState>) {
  return {
    btws: cloneStates(state.btws),
    seenSessionIds: new Map([...state.seenSessionIds].map(([convId, ids]) => [convId, new Set(ids)])),
  };
}

describe("BTW read-only tool boundary", () => {
  test("puts the executor restriction after the user query", () => {
    const content = appendBtwQueryInstructions("answer this", ["read", "write", "bash"]);
    expect(content).toStartWith("answer this\n\n[BTW aside]");
    expect(content).toContain("executors are disabled for this aside: write, bash");
    expect(content).toContain("Only these read-only tools may run if needed: read");
  });

  test("executor rejects a mutating tool even if a provider fabricates the call", async () => {
    const executor = buildExecutor(undefined, BTW_READ_ONLY_TOOLS);
    const [result] = await executor([{
      id: "forbidden-write",
      name: "write",
      input: { file_path: "/tmp/btw-must-not-write", content: "nope" },
    }]);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Tool unavailable in this session: write");
  });
});

describe("BTW persistence", () => {
  test("round-trips conversation-owned panels and removes the sidecar when empty", () => {
    const btw: ConversationBtw = {
      sessionId: "persisted-session",
      query: "persist this",
      provider: "openai",
      model: "gpt-5.6-sol",
      startedAt: 10,
      endedAt: 20,
      phase: "complete",
      text: "durable answer",
      status: "Complete",
    };
    try {
      saveConversationBtwState({
        btws: new Map([["persisted-conv", btw]]),
        seenSessionIds: new Map([["persisted-conv", new Set(["persisted-session", "closed-session"])]]),
      });
      const loaded = loadConversationBtwState();
      expect(loaded.btws).toEqual(new Map([["persisted-conv", btw]]));
      expect(loaded.seenSessionIds).toEqual(new Map([["persisted-conv", new Set(["persisted-session", "closed-session"])]]));

      saveConversationBtwState(emptyPersistenceState());
      expect(loadConversationBtwState()).toEqual(emptyPersistenceState());
    } finally {
      saveConversationBtwState(emptyPersistenceState());
    }
  });
});

describe("conversation-owned BTW sessions", () => {
  test("freezes context, broadcasts and persists by conversation, survives client disconnect, and closes explicitly", async () => {
    const convId = `test-btw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conv = convStore.create(convId, "deepseek", "deepseek-v4-pro", "BTW source", "high", true);
    conv.messages.push({ role: "user", content: "frozen source text", metadata: null });
    const sourceAbort = new AbortController();
    setActiveJob(convId, sourceAbort, 100);
    initStreamingState(convId);
    appendToStreamingBlock(convId, "thinking", "unfinished source reasoning");
    appendToStreamingBlock(convId, "text", "unfinished source assistant output");

    // The requester need not already subscribe; it still receives the full BTW
    // stream directly while subscribed peers receive the broadcast.
    const owner = testClient("btw-owner");
    const peer = testClient("btw-peer", [convId]);
    const events = new Map<string, Event[]>();
    const server = testServer([owner, peer], events);

    type CapturedRun = {
      messages: Parameters<RunAgentLoop>[0];
      provider: Parameters<RunAgentLoop>[1];
      model: Parameters<RunAgentLoop>[2];
      options: NonNullable<Parameters<RunAgentLoop>[4]>;
    };
    let captured: CapturedRun | null = null;
    const fakeRunAgentLoop = ((messages, provider, model, callbacks, options) => {
      if (!options) throw new Error("BTW must pass agent options");
      captured = { messages, provider, model, options };
      callbacks.onBlockStart("thinking");
      callbacks.onThinkingChunk("I should inspect the frozen context.");
      callbacks.onToolCall({
        type: "tool_call",
        toolCallId: "read-1",
        toolName: "read",
        input: { file_path: "README.md" },
        summary: "README.md",
      });
      callbacks.onToolResult({
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        output: "project notes",
        isError: false,
      });
      callbacks.onBlockStart("text");
      callbacks.onTextChunk("partial answer");
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }) as RunAgentLoop;

    let persisted = new Map<string, ConversationBtw>();
    let settledCount = 0;
    const manager = new BtwSessionManager(server, {
      onHeaders() {},
      onComplete() { settledCount += 1; },
    }, {
      runAgentLoop: fakeRunAgentLoop,
      hasConfiguredCredentials: () => true,
      loadConversationBtwState: emptyPersistenceState,
      saveConversationBtwState: state => { persisted = cloneStates(state.btws); },
    });

    try {
      manager.start(owner, {
        type: "btw_query",
        sessionId: "session-1",
        convId,
        query: "answer from the snapshot",
        startedAt: 123,
      });

      expect(captured).not.toBeNull();
      const run = captured as unknown as CapturedRun;
      expect(run.provider).toBe("deepseek");
      expect(run.model).toBe("deepseek-v4-pro");
      expect(run.options.effort).toBe("high");
      expect(run.options.serviceTier).toBe("fast");
      // BTW branches through the source conversation's stable cache identity and
      // current context window instead of creating a cache-cold pseudo-session.
      expect(run.options.promptCacheKey).toBe(convId);
      expect(run.options.getCodexWindowId?.()).toBe(`${convId}:0`);
      expect(run.options.codexTurnId).toBe(`${convId}:btw:session-1`);
      expect(run.options.turnSession).toBeUndefined();
      const sourceSurface = buildConversationRequestSurface(conv, {
        conversationId: convId,
        workingDirectory: ensureConversationWorkspace(convId),
        conversationInstructions: convStore.getEffectiveSystemInstructions(convId) || undefined,
        subagentMaxDepth: conv.subagentMaxDepth ?? null,
      });
      expect(run.options.system).toBe(sourceSurface.system);
      const advertisedToolNames = (run.options.tools as Array<{ name: string }>).map(tool => tool.name);
      // The model sees the source conversation's ordinary tool surface so its
      // cache-sensitive request shape remains identical.
      expect(run.options.tools).toEqual(sourceSurface.tools);
      expect(advertisedToolNames).toEqual(getToolDefs(undefined, convId).map(tool => tool.name));
      expect(advertisedToolNames).toContain("write");
      expect(run.messages.at(-1)).toEqual({
        role: "user",
        content: appendBtwQueryInstructions("answer from the snapshot", advertisedToolNames),
      });
      expect(run.messages.at(-2)).toEqual({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "[In-progress assistant reasoning summary at BTW snapshot]\nunfinished source reasoning",
          },
          { type: "text", text: "unfinished source assistant output" },
        ],
      });

      // Durable and in-progress model input are both deep snapshots, not aliases
      // of source state that may keep changing after BTW starts.
      conv.messages[0].content = "source changed after BTW started";
      appendToStreamingBlock(convId, "text", " leaked later chunk");
      expect(run.messages[0].content).toBe("frozen source text");
      expect(JSON.stringify(run.messages)).not.toContain("leaked later chunk");
      const [forbiddenResult] = await run.options.executor!([{
        id: "forbidden-write",
        name: "write",
        input: { file_path: "/tmp/btw-must-not-write", content: "nope" },
      }]);
      expect(forbiddenResult).toMatchObject({
        toolName: "write",
        isError: true,
        output: "Tool unavailable in this session: write",
      });
      expect(events.get(owner.id)?.some(event => event.type === "btw_text_chunk"
        && event.convId === convId && event.text === "partial answer")).toBe(true);
      expect(events.get(peer.id)?.some(event => event.type === "btw_text_chunk"
        && event.convId === convId && event.text === "partial answer")).toBe(true);
      expect(manager.getSnapshot(convId)?.text).toBe("partial answer");
      expect(manager.getSnapshot(convId)?.blocks).toEqual([
        { type: "thinking", text: "I should inspect the frozen context." },
        { type: "tool_call", toolCallId: "read-1", toolName: "read", input: { file_path: "README.md" }, summary: "README.md" },
        { type: "tool_result", toolCallId: "read-1", toolName: "read", output: "project notes", isError: false },
        { type: "text", text: "partial answer" },
      ]);
      expect(events.get(owner.id)?.some(event => event.type === "btw_thinking_chunk"
        && event.text === "I should inspect the frozen context.")).toBe(true);
      expect(events.get(owner.id)?.some(event => event.type === "btw_tool_call"
        && event.toolName === "read" && event.summary === "README.md")).toBe(true);
      expect(events.get(owner.id)?.some(event => event.type === "btw_status"
        && event.status.startsWith("Using "))).toBe(false);
      expect(manager.hasRunningProvider("deepseek")).toBe(true);

      // The owner socket disappearing does not own or interrupt conversation work.
      owner.socket.emit("close");
      expect(run.options.signal?.aborted).toBe(false);
      expect(manager.getSnapshot(convId)?.sessionId).toBe("session-1");

      await new Promise(resolve => setTimeout(resolve, 120));
      expect(persisted.get(convId)?.text).toBe("partial answer");
      expect(persisted.get(convId)?.blocks?.some(block => block.type === "thinking")).toBe(true);

      // Any client viewing the conversation can close its retained panel.
      expect(manager.close(peer, convId, "session-1")).toBe("closed");
      expect(run.options.signal?.aborted).toBe(true);
      expect(sourceAbort.signal.aborted).toBe(false);
      expect(manager.getSnapshot(convId)).toBeNull();
      expect(persisted.has(convId)).toBe(false);
      expect(events.get(peer.id)?.at(-1)).toEqual({ type: "btw_closed", convId, sessionId: "session-1" });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(manager.hasRunningProvider("deepseek")).toBe(false);
      expect(settledCount).toBe(1);
      expect(events.get(peer.id)?.some(event => event.type === "btw_error")).toBe(false);
    } finally {
      manager.dispose();
      clearActiveJob(convId);
      clearCurrentStreamingBlocks(convId);
      convStore.remove(convId);
    }
  });

  test("freezes a source tool call still in progress as structurally complete replay", async () => {
    const convId = `test-btw-live-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conv = convStore.create(convId, "openai", "gpt-5.6-sol", "live tool source", "high", false);
    conv.messages.push({ role: "user", content: "inspect the project", metadata: null });
    const sourceAbort = new AbortController();
    setActiveJob(convId, sourceAbort, 100);
    initStreamingState(convId);
    pushStreamingBlock(convId, {
      type: "tool_call",
      toolCallId: "source-read",
      toolName: "read",
      input: { file_path: "README.md" },
      summary: "README.md",
    });

    let capturedMessages: Parameters<RunAgentLoop>[0] | null = null;
    let capturedOptions: NonNullable<Parameters<RunAgentLoop>[4]> | null = null;
    const fakeRunAgentLoop = ((messages, _provider, _model, _callbacks, options) => {
      capturedMessages = structuredClone(messages);
      capturedOptions = options ?? null;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }) as RunAgentLoop;
    const client = testClient("btw-live-tool");
    const manager = new BtwSessionManager(testServer([client], new Map()), { onHeaders() {}, onComplete() {} }, {
      runAgentLoop: fakeRunAgentLoop,
      hasConfiguredCredentials: () => true,
      loadConversationBtwState: emptyPersistenceState,
      saveConversationBtwState() {},
    });

    try {
      manager.start(client, {
        type: "btw_query",
        sessionId: "live-tool-session",
        convId,
        query: "what is the source assistant doing?",
        startedAt: 123,
      });

      const replay = capturedMessages as unknown as ApiMessage[];
      const runOptions = capturedOptions as unknown as NonNullable<Parameters<RunAgentLoop>[4]>;
      const advertisedToolNames = (runOptions.tools as Array<{ name: string }>).map(tool => tool.name);
      expect(replay).toEqual([
        { role: "user", content: "inspect the project", metadata: null, providerData: undefined, contextTokens: undefined, contextCheckpoint: undefined },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "source-read", name: "read", input: { file_path: "README.md" } }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "source-read",
            content: "[Source tool call was still in progress when the BTW snapshot was taken; no result was available.]",
            is_error: true,
          }],
        },
        {
          role: "user",
          content: appendBtwQueryInstructions("what is the source assistant doing?", advertisedToolNames),
        },
      ]);
      expect(runOptions.promptCacheKey).toBe(convId);
      expect(runOptions.getCodexWindowId?.()).toBe(`${convId}:0`);

      // A result arriving after invocation belongs to the moving source turn, not
      // the frozen BTW branch.
      pushStreamingBlock(convId, {
        type: "tool_result",
        toolCallId: "source-read",
        toolName: "read",
        output: "late README contents",
        isError: false,
      });
      expect(JSON.stringify(replay)).not.toContain("late README contents");

      expect(manager.close(client, convId, "live-tool-session")).toBe("closed");
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      manager.dispose();
      clearActiveJob(convId);
      clearCurrentStreamingBlocks(convId);
      convStore.remove(convId);
    }
  });

  test("completes a durably suspended source tool call before the BTW query", async () => {
    const convId = `test-btw-suspended-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const conv = convStore.create(convId, "openai", "gpt-5.6-sol", "suspended tool source", "high", false);
    conv.messages.push(
      { role: "user", content: "monitor the run", metadata: null },
      {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "sleep-call",
          name: "chrono",
          input: { action: "sleep", duration: "10m" },
        }],
        metadata: null,
      },
    );

    let capturedMessages: Parameters<RunAgentLoop>[0] | null = null;
    let capturedOptions: NonNullable<Parameters<RunAgentLoop>[4]> | null = null;
    const fakeRunAgentLoop = ((messages, _provider, _model, _callbacks, options) => {
      capturedMessages = structuredClone(messages);
      capturedOptions = options ?? null;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }) as RunAgentLoop;
    const client = testClient("btw-suspended-tool");
    const manager = new BtwSessionManager(testServer([client], new Map()), { onHeaders() {}, onComplete() {} }, {
      runAgentLoop: fakeRunAgentLoop,
      hasConfiguredCredentials: () => true,
      loadConversationBtwState: emptyPersistenceState,
      saveConversationBtwState() {},
    });

    try {
      manager.start(client, {
        type: "btw_query",
        sessionId: "suspended-tool-session",
        convId,
        query: "what is the current state?",
        startedAt: 123,
      });

      const replay = capturedMessages as unknown as ApiMessage[];
      const runOptions = capturedOptions as unknown as NonNullable<Parameters<RunAgentLoop>[4]>;
      const advertisedToolNames = (runOptions.tools as Array<{ name: string }>).map(tool => tool.name);
      expect(replay).toEqual([
        { role: "user", content: "monitor the run", metadata: null, providerData: undefined, contextTokens: undefined, contextCheckpoint: undefined },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "sleep-call", name: "chrono", input: { action: "sleep", duration: "10m" } }],
          metadata: null,
          providerData: undefined,
          contextTokens: undefined,
          contextCheckpoint: undefined,
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "sleep-call",
            content: "[Source tool call was still in progress when the BTW snapshot was taken; no result was available.]",
            is_error: true,
          }],
        },
        {
          role: "user",
          content: appendBtwQueryInstructions("what is the current state?", advertisedToolNames),
        },
      ]);

      expect(manager.close(client, convId, "suspended-tool-session")).toBe("closed");
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      manager.dispose();
      convStore.remove(convId);
    }
  });

  test("keeps independent sessions in separate conversations", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const firstId = `test-btw-first-${suffix}`;
    const secondId = `test-btw-second-${suffix}`;
    convStore.create(firstId, "deepseek", "deepseek-v4-pro", "first", "high", false);
    convStore.create(secondId, "deepseek", "deepseek-v4-pro", "second", "high", false);
    const client = testClient("btw-multi", [firstId, secondId]);
    const server = testServer([client], new Map());
    const signals = new Map<string, AbortSignal>();
    const fakeRunAgentLoop = ((messages, _provider, _model, _callbacks, options) => {
      const query = String(messages.at(-1)?.content ?? "").split("\n\n[BTW aside]")[0];
      if (!options?.signal) throw new Error("missing BTW abort signal");
      signals.set(query, options.signal);
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }) as RunAgentLoop;
    const manager = new BtwSessionManager(server, { onHeaders() {}, onComplete() {} }, {
      runAgentLoop: fakeRunAgentLoop,
      hasConfiguredCredentials: () => true,
      loadConversationBtwState: emptyPersistenceState,
      saveConversationBtwState() {},
    });

    try {
      manager.start(client, { type: "btw_query", sessionId: "first-session", convId: firstId, query: "first query", startedAt: 1 });
      manager.start(client, { type: "btw_query", sessionId: "second-session", convId: secondId, query: "second query", startedAt: 2 });

      expect(manager.getSnapshot(firstId)?.query).toBe("first query");
      expect(manager.getSnapshot(secondId)?.query).toBe("second query");
      expect(manager.close(client, firstId, "first-session")).toBe("closed");
      expect(signals.get("first query")?.aborted).toBe(true);
      expect(signals.get("second query")?.aborted).toBe(false);
      expect(manager.getSnapshot(secondId)?.sessionId).toBe("second-session");
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      manager.dispose();
      convStore.remove(firstId);
      convStore.remove(secondId);
    }
  });

  test("deduplicates a replayed start and catches up its unsubscribed requester", async () => {
    const convId = `test-btw-replay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    convStore.create(convId, "deepseek", "deepseek-v4-pro", "replay", "high", false);
    const original = testClient("btw-original");
    const reconnected = testClient("btw-reconnected");
    const events = new Map<string, Event[]>();
    let runCount = 0;
    let emitChunk: ((text: string) => void) | null = null;
    const fakeRunAgentLoop = ((_messages, _provider, _model, callbacks, options) => {
      runCount += 1;
      emitChunk = callbacks.onTextChunk;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }) as RunAgentLoop;
    const manager = new BtwSessionManager(testServer([original, reconnected], events), { onHeaders() {}, onComplete() {} }, {
      runAgentLoop: fakeRunAgentLoop,
      hasConfiguredCredentials: () => true,
      loadConversationBtwState: emptyPersistenceState,
      saveConversationBtwState() {},
    });
    const command = { type: "btw_query" as const, sessionId: "stable-session", convId, query: "once", startedAt: 1 };

    try {
      manager.start(original, command);
      manager.start(reconnected, command);
      expect(runCount).toBe(1);
      expect(events.get(reconnected.id)?.at(-1)).toMatchObject({
        type: "btw_snapshot",
        convId,
        btw: { sessionId: "stable-session" },
      });

      (emitChunk as unknown as (text: string) => void)("after reconnect");
      expect(events.get(reconnected.id)?.at(-1)).toEqual({
        type: "btw_text_chunk",
        convId,
        sessionId: "stable-session",
        text: "after reconnect",
      });

      expect(manager.close(reconnected, convId, "stable-session")).toBe("closed");
      // A duplicate close is acknowledged so the replaying client can settle it.
      expect(manager.close(reconnected, convId, "stable-session")).toBe("already_closed");
      expect(events.get(reconnected.id)?.at(-1)).toEqual({ type: "btw_closed", convId, sessionId: "stable-session" });

      const newer = { ...command, sessionId: "newer-session", query: "newer", startedAt: 2 };
      manager.start(reconnected, newer);
      expect(runCount).toBe(2);
      manager.start(original, command);
      expect(runCount).toBe(2);
      expect(manager.getSnapshot(convId)?.sessionId).toBe("newer-session");
      expect(events.get(original.id)?.at(-1)).toMatchObject({
        type: "btw_snapshot",
        btw: { sessionId: "newer-session" },
      });

      expect(manager.close(reconnected, convId, "newer-session")).toBe("closed");
      convStore.remove(convId);
      expect(convStore.undoDelete()?.type).toBe("conversation");
      manager.start(original, command);
      expect(runCount).toBe(2);
      expect(manager.getSnapshot(convId)).toBeNull();
      expect(events.get(original.id)?.at(-1)).toEqual({ type: "btw_snapshot", convId, btw: null });
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      manager.dispose();
      convStore.remove(convId);
    }
  });

  test("does not acknowledge or abort a close until its removal is durable", async () => {
    const convId = `test-btw-close-persist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    convStore.create(convId, "deepseek", "deepseek-v4-pro", "durable close", "high", false);
    const client = testClient("btw-close-persist");
    const events = new Map<string, Event[]>();
    let signal: AbortSignal | null = null;
    let failEmptySave = true;
    const fakeRunAgentLoop = ((_messages, _provider, _model, _callbacks, options) => {
      signal = options?.signal ?? null;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }) as RunAgentLoop;
    const manager = new BtwSessionManager(testServer([client], events), { onHeaders() {}, onComplete() {} }, {
      runAgentLoop: fakeRunAgentLoop,
      hasConfiguredCredentials: () => true,
      loadConversationBtwState: emptyPersistenceState,
      saveConversationBtwState: state => {
        if (state.btws.size === 0 && failEmptySave) throw new Error("disk unavailable");
      },
    });

    try {
      manager.start(client, { type: "btw_query", sessionId: "durable-session", convId, query: "persist", startedAt: 1 });
      events.set(client.id, []);
      expect(manager.close(client, convId, "durable-session")).toBe("failed");
      expect(manager.getSnapshot(convId)?.sessionId).toBe("durable-session");
      expect((signal as unknown as AbortSignal).aborted).toBe(false);
      expect(events.get(client.id)?.some(event => event.type === "btw_closed")).toBe(false);
      expect(events.get(client.id)?.some(event => event.type === "btw_snapshot")).toBe(true);

      failEmptySave = false;
      expect(manager.close(client, convId, "durable-session")).toBe("closed");
      expect((signal as unknown as AbortSignal).aborted).toBe(true);
      expect(manager.getSnapshot(convId)).toBeNull();

      events.set(client.id, []);
      failEmptySave = true;
      expect(manager.close(client, convId, "unseen-session")).toBe("failed");
      expect(events.get(client.id)?.some(event => event.type === "btw_mutation_settled")).toBe(false);
      expect(events.get(client.id)?.some(event => event.type === "btw_snapshot")).toBe(true);
      failEmptySave = false;
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      manager.dispose();
      convStore.remove(convId);
    }
  });

  test("retains accepted-session receipts across manager restarts", async () => {
    const convId = `test-btw-receipt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    convStore.create(convId, "deepseek", "deepseek-v4-pro", "receipt", "high", false);
    const client = testClient("btw-receipt");
    const command = { type: "btw_query" as const, sessionId: "accepted-once", convId, query: "once", startedAt: 1 };
    let persisted = emptyPersistenceState();
    let firstRuns = 0;
    const hangingRun = ((_messages, _provider, _model, _callbacks, options) => {
      firstRuns += 1;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }) as RunAgentLoop;
    const first = new BtwSessionManager(testServer([client], new Map()), { onHeaders() {}, onComplete() {} }, {
      runAgentLoop: hangingRun,
      hasConfiguredCredentials: () => true,
      loadConversationBtwState: emptyPersistenceState,
      saveConversationBtwState: state => { persisted = clonePersistenceState(state); },
    });

    try {
      first.start(client, command);
      expect(firstRuns).toBe(1);
      expect(first.close(client, convId, command.sessionId)).toBe("closed");
      first.dispose();
      await new Promise(resolve => setTimeout(resolve, 0));

      let replayRuns = 0;
      const events = new Map<string, Event[]>();
      const restarted = new BtwSessionManager(testServer([client], events), { onHeaders() {}, onComplete() {} }, {
        runAgentLoop: (() => { replayRuns += 1; return Promise.resolve({}); }) as unknown as RunAgentLoop,
        hasConfiguredCredentials: () => true,
        loadConversationBtwState: () => clonePersistenceState(persisted),
        saveConversationBtwState: state => { persisted = clonePersistenceState(state); },
      });
      try {
        restarted.start(client, command);
        expect(replayRuns).toBe(0);
        expect(restarted.getSnapshot(convId)).toBeNull();
        expect(events.get(client.id)?.at(-1)).toEqual({ type: "btw_snapshot", convId, btw: null });
      } finally {
        restarted.dispose();
      }
    } finally {
      first.dispose();
      convStore.remove(convId);
    }
  });

  test("retains persisted panels before conversations load and recovers running work as an error", () => {
    const complete: ConversationBtw = {
      sessionId: "complete-session",
      query: "complete query",
      provider: "openai",
      model: "gpt-5.6-sol",
      startedAt: 10,
      endedAt: 20,
      phase: "complete",
      text: "complete answer",
      status: "Complete",
    };
    const interrupted: ConversationBtw = {
      sessionId: "running-session",
      query: "running query",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      startedAt: 30,
      endedAt: null,
      phase: "running",
      text: "durable partial answer",
      status: "Answering…",
    };
    const client = testClient("btw-recovery", ["complete-conv"]);
    const events = new Map<string, Event[]>();
    let saved = new Map<string, ConversationBtw>();
    const manager = new BtwSessionManager(testServer([client], events), { onHeaders() {}, onComplete() {} }, {
      loadConversationBtwState: () => ({
        btws: new Map([
          ["complete-conv", complete],
          ["running-conv", interrupted],
        ]),
        seenSessionIds: new Map(),
      }),
      saveConversationBtwState: state => { saved = cloneStates(state.btws); },
    });

    try {
      expect(manager.getSnapshot("complete-conv")).toEqual({
        ...complete,
        blocks: [{ type: "text", text: "complete answer" }],
      });
      expect(manager.getSnapshot("running-conv")).toMatchObject({
        sessionId: "running-session",
        phase: "error",
        text: "durable partial answer",
        blocks: [{ type: "text", text: "durable partial answer" }],
        status: "Interrupted by daemon restart.",
        endedAt: expect.any(Number),
      });
      expect(saved.get("running-conv")?.phase).toBe("error");

      manager.sendSnapshot(client, "complete-conv");
      expect(events.get(client.id)?.at(-1)).toEqual({
        type: "btw_snapshot",
        convId: "complete-conv",
        btw: { ...complete, blocks: [{ type: "text", text: "complete answer" }] },
      });
      manager.sendSnapshot(client, "missing-conv");
      expect(events.get(client.id)?.at(-1)).toEqual({
        type: "btw_snapshot",
        convId: "missing-conv",
        btw: null,
      });

      expect(manager.close(client, "complete-conv", "complete-session")).toBe("closed");
      expect(saved.has("complete-conv")).toBe(false);
      expect(saved.has("running-conv")).toBe(true);
    } finally {
      manager.dispose();
    }
  });
});
