import { describe, expect, test } from "bun:test";
import { browserOpenCommand, handleEvent, type DaemonActions } from "./events";
import { buildDiskSyncAssistantDiffPayload } from "./events/disk-sync-diagnostics";
import type { ConversationSummary } from "./messages";
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
