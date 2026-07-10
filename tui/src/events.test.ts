import { describe, expect, test } from "bun:test";
import { browserOpenCommand, handleEvent, type DaemonActions } from "./events";
import { buildDiskSyncAssistantDiffPayload } from "./events/disk-sync-diagnostics";
import { CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT, createPendingAI, type ConversationSummary } from "./messages";
import { createInitialState } from "./state";

const daemon: DaemonActions = {
  subscribe() {},
  unsubscribe() {},
  sendMessage() {},
  setSystemInstructions() {},
  loadToolOutputs() {},
};

describe("auth browser opener", () => {
  test("uses macOS open on Darwin", () => {
    expect(browserOpenCommand("https://example.com/auth", "darwin")).toEqual(["open", "https://example.com/auth"]);
  });

  test("uses xdg-open on Linux", () => {
    expect(browserOpenCommand("https://example.com/auth", "linux")).toEqual(["xdg-open", "https://example.com/auth"]);
  });

  test("uses cmd start on Windows", () => {
    expect(browserOpenCommand("https://example.com/auth", "win32")).toEqual(["cmd", "/c", "start", "", "https://example.com/auth"]);
  });
});

describe("context compaction status events", () => {
  test("replaces the spinner with a retained marker below completed assistant content", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.pendingAI = createPendingAI(100, state.model);
    state.pendingAI.blocks.push({ type: "text", text: "work before compaction" });

    handleEvent({
      type: "context_compaction_status",
      convId: "conv-1",
      active: true,
      startedAt: 123,
    }, state, daemon);
    expect(state.contextCompactionStartedAt).toBe(123);

    handleEvent({
      type: "context_compaction_status",
      convId: "conv-1",
      active: false,
      completedAt: 456,
    }, state, daemon);
    expect(state.contextCompactionStartedAt).toBeNull();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      blocks: [{ type: "text", text: "work before compaction" }],
    });
    expect(state.messages[1]).toMatchObject({
      role: "system",
      text: CONTEXT_COMPACTION_FINISHED_TEXT,
      metadata: {
        startedAt: 456,
        endedAt: 456,
        kind: CONTEXT_COMPACTION_FINISHED_KIND,
      },
    });
    expect(state.pendingAI?.blocks).toEqual([]);
    expect(state.suppressPendingAIMetadataStartedAt).toBe(100);

    // A same-conversation refresh can load the durable marker just before the
    // matching completion event; do not retain it twice.
    handleEvent({
      type: "context_compaction_status",
      convId: "conv-1",
      active: false,
      completedAt: 456,
    }, state, daemon);
    expect(state.messages.filter((message) => message.role === "system")).toHaveLength(1);
  });

  test("immediately locks user messages represented by a completed compaction", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({
      role: "user",
      text: "now represented",
      metadata: null,
      contextCheckpoint: { contextTokens: 123_000, editable: true },
    });

    handleEvent({
      type: "context_compaction_status",
      convId: "conv-1",
      active: false,
      completedAt: 456,
    }, state, daemon);

    expect(state.messages[0]).toMatchObject({
      role: "user",
      contextCheckpoint: { contextTokens: 123_000, editable: false },
    });
  });
});

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: "conv-1",
    provider: "openai",
    model: "gpt-5.5",
    effort: "high",
    fastMode: false,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    title: "Existing chat",
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: 1,
    ...overrides,
  };
}

describe("disk sync assistant diagnostics", () => {
  function assistantBlocks(state: ReturnType<typeof createInitialState>) {
    return state.messages.flatMap((msg) => msg.role === "assistant" ? msg.blocks : []);
  }

  test("reports when a same-conversation disk sync changes visible assistant text", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({
      role: "assistant",
      blocks: [{ type: "text", text: "local answer" }],
      metadata: null,
    });

    const payload = buildDiskSyncAssistantDiffPayload("conversation_loaded", "conv-1", state, {
      entries: [{ type: "ai", blocks: [{ type: "text", text: "disk answer" }], metadata: null }],
      pendingAI: null,
      toolOutputsIncluded: false,
    });

    expect(payload).toMatchObject({
      source: "conversation_loaded",
      convId: "conv-1",
      localVisibleBlocks: 1,
      diskVisibleBlocks: 1,
      firstDiff: {
        visibleBlockIndex: 0,
        local: { type: "text", chars: 12, preview: "local answer" },
        disk: { type: "text", chars: 11, preview: "disk answer" },
      },
    });
  });

  test("canonical same-conversation load replaces non-streaming local assistant tail", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push(
      { role: "assistant", blocks: [{ type: "text", text: "persisted answer" }], metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "new local tail" }], metadata: null },
    );

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [{ type: "ai", blocks: [{ type: "text", text: "persisted answer" }], metadata: null }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(assistantBlocks(state)).toEqual([
      { type: "text", text: "persisted answer" },
    ]);
  });

  test("preserves only the live pending assistant tail across a stale same-conversation load", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({ role: "assistant", blocks: [{ type: "text", text: "persisted answer" }], metadata: null });
    state.pendingAI = {
      role: "assistant",
      blocks: [{ type: "text", text: "new local tail" }],
      metadata: { startedAt: 2, endedAt: null, model: "gpt-5.5", tokens: 0 },
    };

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [{ type: "ai", blocks: [{ type: "text", text: "persisted answer" }], metadata: null }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(state.messages).toEqual([
      { role: "assistant", blocks: [{ type: "text", text: "persisted answer" }], metadata: null },
    ]);
    expect(state.pendingAI?.blocks).toEqual([{ type: "text", text: "new local tail" }]);
  });

  test("canonical history update replaces non-streaming local assistant tail", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({
      role: "assistant",
      blocks: [
        { type: "text", text: "persisted answer" },
        { type: "thinking", text: "still working" },
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ pwd" },
      ],
      metadata: null,
    });

    handleEvent({
      type: "history_updated",
      convId: "conv-1",
      entries: [{ type: "ai", blocks: [{ type: "text", text: "persisted answer" }], metadata: null }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(assistantBlocks(state)).toEqual([
      { type: "text", text: "persisted answer" },
    ]);
  });

  test("history update keeps the live pending assistant tail", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({ role: "assistant", blocks: [{ type: "text", text: "persisted answer" }], metadata: null });
    state.pendingAI = {
      role: "assistant",
      blocks: [
        { type: "thinking", text: "still working" },
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ pwd" },
      ],
      metadata: { startedAt: 2, endedAt: null, model: "gpt-5.5", tokens: 0 },
    };

    handleEvent({
      type: "history_updated",
      convId: "conv-1",
      entries: [{ type: "ai", blocks: [{ type: "text", text: "persisted answer" }], metadata: null }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(state.messages).toEqual([
      { role: "assistant", blocks: [{ type: "text", text: "persisted answer" }], metadata: null },
    ]);
    expect(state.pendingAI?.blocks).toEqual([
      { type: "thinking", text: "still working" },
      { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ pwd" },
    ]);
  });

  test("does not preserve local assistant content over an incompatible disk rewrite", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({
      role: "assistant",
      blocks: [
        { type: "text", text: "old local answer" },
        { type: "text", text: "old local tail" },
      ],
      metadata: null,
    });

    handleEvent({
      type: "history_updated",
      convId: "conv-1",
      entries: [{ type: "ai", blocks: [{ type: "text", text: "new compact summary" }], metadata: null }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(assistantBlocks(state)).toEqual([
      { type: "text", text: "new compact summary" },
    ]);
  });

  test("preserves expanded tool output across a compact same-conversation load", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.showToolOutput = true;
    state.toolOutputsLoaded = true;
    state.messages.push({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
        { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "full output", isError: false },
      ],
      metadata: null,
    });

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [{
        type: "ai",
        blocks: [
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
          { type: "tool_result", toolCallId: "call-1", toolName: "", output: "", isError: false },
        ],
        metadata: null,
      }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);

    expect(state.showToolOutput).toBe(true);
    expect(state.toolOutputsLoaded).toBe(true);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "call-1" },
        { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "full output", isError: false },
      ],
    });
  });

  test("preserves expanded tool output across a compact history update", () => {
    let loadToolOutputsCalls = 0;
    const localDaemon: DaemonActions = {
      ...daemon,
      loadToolOutputs() { loadToolOutputsCalls += 1; },
    };
    const state = createInitialState();
    state.convId = "conv-1";
    state.showToolOutput = true;
    state.toolOutputsLoaded = true;
    state.messages.push({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
        { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "full output", isError: false },
      ],
      metadata: null,
    });

    handleEvent({
      type: "history_updated",
      convId: "conv-1",
      entries: [{
        type: "ai",
        blocks: [
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
          { type: "tool_result", toolCallId: "call-1", toolName: "", output: "", isError: false },
        ],
        metadata: null,
      }],
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, localDaemon);

    expect(state.showToolOutput).toBe(true);
    expect(state.toolOutputsLoaded).toBe(true);
    expect(loadToolOutputsCalls).toBe(0);
    expect(state.messages[0]).toMatchObject({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "call-1" },
        { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "full output", isError: false },
      ],
    });
  });

  test("ignores hidden compact tool-result output differences until output is visible", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push({
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
        { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "full output", isError: false },
      ],
      metadata: null,
    });
    const disk = {
      entries: [{
        type: "ai" as const,
        blocks: [
          { type: "tool_call" as const, toolCallId: "call-1", toolName: "bash", input: {}, summary: "$ make" },
          { type: "tool_result" as const, toolCallId: "call-1", toolName: "", output: "", isError: false },
        ],
        metadata: null,
      }],
      pendingAI: null,
      toolOutputsIncluded: false,
    };

    expect(buildDiskSyncAssistantDiffPayload("history_updated", "conv-1", state, disk)).toBeNull();

    state.showToolOutput = true;
    expect(buildDiskSyncAssistantDiffPayload("history_updated", "conv-1", state, disk)).toMatchObject({
      firstDiff: {
        visibleBlockIndex: 1,
        local: { type: "tool_result", outputChars: 11, outputPreview: "full output" },
        disk: { type: "tool_result", outputChars: 0, outputPreview: "" },
      },
    });
  });
});

describe("streaming assistant metadata", () => {
  test("heartbeat offsets do not invalidate locally committed completion blocks", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.model = "gpt-5.5";
    const completedPrefix = [
      { type: "tool_call" as const, toolCallId: "call-1", toolName: "bash", input: {}, summary: "pwd" },
      { type: "tool_result" as const, toolCallId: "call-1", toolName: "bash", output: "/tmp", isError: false },
    ];
    state.pendingAI = {
      role: "assistant",
      blocks: structuredClone(completedPrefix),
      metadata: { startedAt: 1, endedAt: null, model: "gpt-5.5", tokens: 0 },
    };
    handleEvent({ type: "user_message", convId: "conv-1", text: "next", startedAt: 2 }, state, daemon);

    handleEvent({
      type: "streaming_started",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      snapshotKind: "heartbeat",
      startedAt: 1,
      blocks: [],
      blockOffset: completedPrefix.length,
    }, state, daemon);
    expect(state.pendingAIBlockOffset).toBe(0);

    handleEvent({ type: "text_chunk", convId: "conv-1", text: "foo" }, state, daemon);
    handleEvent({ type: "system_message", convId: "conv-1", text: "notice", color: "warning" }, state, daemon);
    handleEvent({ type: "text_chunk", convId: "conv-1", text: "bar" }, state, daemon);
    handleEvent({
      type: "message_complete",
      convId: "conv-1",
      blocks: [...completedPrefix, { type: "text", text: "foobar" }],
      endedAt: 3,
      tokens: 10,
    }, state, daemon);

    expect(state.messages.flatMap((message) => message.role === "assistant" ? message.blocks : [])).toEqual([
      ...completedPrefix,
      { type: "text", text: "foobar" },
    ]);
  });

  test("late-join completion honors the active-turn block offset from the daemon", () => {
    const state = createInitialState();
    state.model = "gpt-5.5";
    const completedPrefix = [
      { type: "thinking" as const, text: "checking" },
      { type: "tool_call" as const, toolCallId: "call-1", toolName: "bash", input: { command: "pwd" }, summary: "pwd" },
      { type: "tool_result" as const, toolCallId: "call-1", toolName: "", output: "", isError: false },
    ];

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [
        { type: "ai", blocks: completedPrefix, metadata: null },
        { type: "user", text: "also check tests" },
      ],
      pendingAI: {
        blocks: [{ type: "text", text: "done" }],
        blockOffset: completedPrefix.length,
        metadata: { startedAt: 1, endedAt: null, model: "gpt-5.5", tokens: 0 },
      },
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);
    expect(state.pendingAIBlockOffset).toBe(3);

    handleEvent({
      type: "message_complete",
      convId: "conv-1",
      blocks: [...completedPrefix, { type: "text", text: "done" }],
      endedAt: 3,
      tokens: 10,
    }, state, daemon);

    expect(state.messages.flatMap((message) => message.role === "assistant" ? message.blocks : [])).toEqual([
      ...completedPrefix,
      { type: "text", text: "done" },
    ]);
  });

  test("legacy reload derives a completion offset from locally committed blocks", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.model = "gpt-5.5";
    const completedPrefix = [
      { type: "tool_call" as const, toolCallId: "call-1", toolName: "bash", input: {}, summary: "pwd" },
      { type: "tool_result" as const, toolCallId: "call-1", toolName: "bash", output: "/tmp", isError: false },
    ];
    state.pendingAI = {
      role: "assistant",
      blocks: structuredClone(completedPrefix),
      metadata: { startedAt: 1, endedAt: null, model: "gpt-5.5", tokens: 0 },
    };
    handleEvent({ type: "user_message", convId: "conv-1", text: "next", startedAt: 2 }, state, daemon);
    handleEvent({ type: "text_chunk", convId: "conv-1", text: "done" }, state, daemon);

    handleEvent({
      type: "conversation_loaded",
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.5",
      effort: "high",
      fastMode: false,
      entries: [
        { type: "ai", blocks: completedPrefix, metadata: null },
        { type: "user", text: "next" },
      ],
      pendingAI: {
        blocks: [{ type: "text", text: "done" }],
        metadata: state.pendingAI!.metadata,
      },
      contextTokens: null,
      toolOutputsIncluded: false,
    }, state, daemon);
    expect(state.pendingAIBlockOffset).toBe(completedPrefix.length);

    handleEvent({
      type: "message_complete",
      convId: "conv-1",
      blocks: [...completedPrefix, { type: "text", text: "done" }],
      endedAt: 3,
      tokens: 10,
    }, state, daemon);
    expect(state.messages.flatMap((message) => message.role === "assistant" ? message.blocks : [])).toEqual([
      ...completedPrefix,
      { type: "text", text: "done" },
    ]);
  });

  test("message_complete does not duplicate a prefix committed around an injected user message", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.model = "gpt-5.5";
    const completedPrefix = [
      { type: "thinking" as const, text: "checking" },
      { type: "tool_call" as const, toolCallId: "call-1", toolName: "bash", input: { command: "pwd" }, summary: "pwd" },
      { type: "tool_result" as const, toolCallId: "call-1", toolName: "bash", output: "/tmp", isError: false },
    ];
    state.pendingAI = {
      role: "assistant",
      blocks: structuredClone(completedPrefix),
      metadata: { startedAt: 1, endedAt: null, model: "gpt-5.5", tokens: 0 },
    };

    handleEvent({
      type: "user_message",
      convId: "conv-1",
      text: "also check tests",
      startedAt: 2,
    }, state, daemon);
    expect(state.pendingAIBlockOffset).toBe(0);
    expect(state.pendingAIPartialCommittedBlocks).toEqual(completedPrefix);

    handleEvent({
      type: "text_chunk",
      convId: "conv-1",
      text: "done",
    }, state, daemon);
    handleEvent({
      type: "message_complete",
      convId: "conv-1",
      blocks: [...completedPrefix, { type: "text", text: "done" }],
      endedAt: 3,
      tokens: 10,
    }, state, daemon);

    expect(state.messages).toEqual([
      { role: "assistant", blocks: completedPrefix, metadata: null },
      {
        role: "user",
        text: "also check tests",
        images: undefined,
        metadata: { startedAt: 2, endedAt: 2, model: "gpt-5.5", tokens: 0 },
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "done" }],
        metadata: { startedAt: 1, endedAt: 3, model: "gpt-5.5", tokens: 10 },
      },
    ]);
    expect(state.pendingAI).toBeNull();
    expect(state.pendingAIBlockOffset).toBe(0);
  });

  test("message_complete keeps adjacent goal-continuation assistant messages separate", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.model = "gpt-5.5";
    state.messages.push({
      role: "assistant",
      blocks: [{ type: "text", text: "Initial progress" }],
      metadata: { startedAt: 0, endedAt: 1_000, model: "gpt-5.5", tokens: 10 },
    });
    state.pendingAI = {
      role: "assistant",
      blocks: [{ type: "text", text: "Final result" }],
      metadata: { startedAt: 3_600_000, endedAt: null, model: "gpt-5.5", tokens: 0 },
    };

    handleEvent({
      type: "message_complete",
      convId: "conv-1",
      blocks: [{ type: "text", text: "Final result" }],
      endedAt: 7_200_000,
      tokens: 25,
    }, state, daemon);

    expect(state.messages).toEqual([
      {
        role: "assistant",
        blocks: [{ type: "text", text: "Initial progress" }],
        metadata: { startedAt: 0, endedAt: 1_000, model: "gpt-5.5", tokens: 10 },
      },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "Final result" }],
        metadata: { startedAt: 3_600_000, endedAt: 7_200_000, model: "gpt-5.5", tokens: 25 },
      },
    ]);
    expect(state.pendingAI).toBeNull();
  });
});

describe("conversation_updated", () => {
  test("ignores a null summary from a malformed daemon event", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.sidebar.conversations = [summary()];

    expect(() => {
      handleEvent({ type: "conversation_updated", summary: null } as never, state, daemon);
    }).not.toThrow();

    expect(state.sidebar.conversations).toEqual([summary()]);
  });
});
