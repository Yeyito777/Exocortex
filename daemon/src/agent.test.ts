import { describe, expect, test } from "bun:test";
import { runAgentLoop, type AgentCallbacks, type AgentState } from "./agent";
import type { StreamResult } from "./providers/types";
import type { streamMessage } from "./api";

function callbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onBlockStart: () => {},
    onTextChunk: () => {},
    onThinkingChunk: () => {},
    onSignature: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onTokensUpdate: () => {},
    onContextUpdate: () => {},
    onHeaders: () => {},
    ...overrides,
  };
}

function state(): AgentState {
  return {
    completedMessages: [],
    completedBlocks: [],
    contextMessages: [],
    contextCompacted: false,
    tokens: 0,
  };
}

describe("automatic agent compaction", () => {
  test("records a completed raw tool round before a failing compaction", async () => {
    const recovery = state();
    let recoveryReadyBeforeCompaction = false;
    const response: StreamResult = {
      text: "",
      thinking: "",
      stopReason: "tool_use",
      blocks: [],
      toolCalls: [{ id: "call-1", name: "read", input: { file_path: "/tmp/x" } }],
      inputTokens: 340_000,
      outputTokens: 10,
    };
    const fakeStream = (async () => response) as typeof streamMessage;

    await expect(runAgentLoop(
      [{ role: "user", content: "inspect it" }],
      "openai",
      "gpt-5.6-sol",
      callbacks({
        onRecoveryStateUpdate: () => {
          recoveryReadyBeforeCompaction = recovery.completedMessages.length === 2;
        },
        compactContext: async () => {
          expect(recoveryReadyBeforeCompaction).toBe(true);
          throw new Error("compactor failed");
        },
      }),
      {
        state: recovery,
        streamMessageFn: fakeStream,
        executor: async () => [{
          toolCallId: "call-1",
          toolName: "read",
          output: "file contents",
          isError: false,
        }],
      },
    )).rejects.toThrow("compactor failed");

    expect(recovery.completedMessages).toHaveLength(2);
    expect(recovery.completedMessages[0].role).toBe("assistant");
    expect(recovery.completedMessages[1].role).toBe("user");
    expect(recovery.contextMessages).toHaveLength(3);
    expect(recoveryReadyBeforeCompaction).toBe(true);
  });

  test("does not retry a context error after provider output was already emitted", async () => {
    let compactCalls = 0;
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
      streamCallbacks.onText("partial answer");
      throw new Error("maximum context length exceeded");
    }) as typeof streamMessage;

    await expect(runAgentLoop(
      [{ role: "user", content: "hello" }],
      "openai",
      "gpt-5.6-sol",
      callbacks({
        compactContext: async () => {
          compactCalls += 1;
          return [];
        },
      }),
      { streamMessageFn: fakeStream },
    )).rejects.toThrow("maximum context length exceeded");

    expect(compactCalls).toBe(0);
  });

  test("uses exact provider output usage when projecting mid-turn compaction", async () => {
    let streamCalls = 0;
    let compactCalls = 0;
    const fakeStream = (async () => {
      streamCalls += 1;
      if (streamCalls === 1) {
        return {
          text: "",
          thinking: "",
          stopReason: "tool_use",
          blocks: [],
          toolCalls: [{ id: "call-large-hidden", name: "read", input: { file_path: "/tmp/a" } }],
          inputTokens: 10,
          // Simulates large hidden reasoning with almost no rendered content.
          outputTokens: 390_000,
        };
      }
      return {
        text: "done",
        thinking: "",
        stopReason: "stop",
        blocks: [{ type: "text", text: "done" }],
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 1,
      };
    }) as typeof streamMessage;

    await runAgentLoop(
      [{ role: "user", content: "inspect it" }],
      "openai",
      "gpt-5.6-sol",
      callbacks({
        compactContext: async (messages) => {
          compactCalls += 1;
          return messages;
        },
      }),
      {
        streamMessageFn: fakeStream,
        executor: async () => [{
          toolCallId: "call-large-hidden",
          toolName: "read",
          output: "small result",
          isError: false,
        }],
      },
    );

    expect(compactCalls).toBe(1);
  });
});
