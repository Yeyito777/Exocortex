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

  test("allows context recovery after a provider retry discarded partial output", async () => {
    let streamCalls = 0;
    let compactCalls = 0;
    const retryAttempts: number[] = [];
    const fakeStream = (async (_provider, _messages, _model, streamCallbacks) => {
      streamCalls += 1;
      if (streamCalls === 1) {
        streamCallbacks.onText("discarded partial answer");
        streamCallbacks.onRetry?.(1, 8, "Timed out (stale stream)", 0, { kind: "transient" });
        throw new Error("maximum context length exceeded");
      }
      return {
        text: "recovered",
        thinking: "",
        stopReason: "stop",
        blocks: [{ type: "text", text: "recovered" }],
        toolCalls: [],
      };
    }) as typeof streamMessage;

    const result = await runAgentLoop(
      [{ role: "user", content: "hello" }],
      "openai",
      "gpt-5.6-sol",
      callbacks({
        onRetry: (attempt) => retryAttempts.push(attempt),
        compactContext: async (messages) => {
          compactCalls += 1;
          return messages;
        },
      }),
      { streamMessageFn: fakeStream },
    );

    expect(streamCalls).toBe(2);
    expect(compactCalls).toBe(1);
    expect(retryAttempts).toEqual([1]);
    expect(result.blocks).toEqual([{ type: "text", text: "recovered" }]);
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

describe("deferred tool results", () => {
  test("ends the provider loop with an outstanding Chrono tool call", async () => {
    const recovery = state();
    const emittedResults: string[] = [];
    let streamCalls = 0;
    const fakeStream = (async () => {
      streamCalls += 1;
      return {
        text: "",
        thinking: "",
        stopReason: "tool_use",
        blocks: [],
        toolCalls: [{ id: "sleep-call", name: "chrono", input: { action: "sleep", duration: "10m" } }],
        outputTokens: 4,
      } satisfies StreamResult;
    }) as typeof streamMessage;

    const result = await runAgentLoop(
      [{ role: "user", content: "wait ten minutes" }],
      "openai",
      "gpt-5.6-sol",
      callbacks({ onToolResult: (block) => emittedResults.push(block.output) }),
      {
        state: recovery,
        streamMessageFn: fakeStream,
        executor: async () => [{
          toolCallId: "sleep-call",
          toolName: "chrono",
          output: "",
          isError: false,
          deferred: {
            kind: "chrono_sleep",
            sleepId: "chrono:sleep:sleep-call",
            startedAt: 1_000,
            dueAt: 601_000,
            durationMs: 600_000,
          },
        }],
      },
    );

    expect(streamCalls).toBe(1);
    expect(result.suspended).toMatchObject({ kind: "chrono_sleep", sleepId: "chrono:sleep:sleep-call" });
    expect(result.newMessages).toHaveLength(1);
    expect(result.newMessages[0]).toMatchObject({
      role: "assistant",
      content: [expect.objectContaining({ type: "tool_use", id: "sleep-call", name: "chrono" })],
    });
    expect(recovery.completedMessages).toHaveLength(1);
    expect(emittedResults).toEqual([]);
  });
});

describe("queued-message handoff", () => {
  test("does not drain a next-turn message after the active turn is interrupted", async () => {
    const controller = new AbortController();
    const recovery = state();
    let streamCalls = 0;
    let drainCalls = 0;
    const fakeStream = (async () => {
      streamCalls += 1;
      if (streamCalls > 1) throw new Error("interrupted turn started another provider round");
      return {
        text: "",
        thinking: "",
        stopReason: "tool_use",
        blocks: [],
        toolCalls: [{ id: "call-before-interrupt", name: "read", input: { file_path: "/tmp/x" } }],
      } satisfies StreamResult;
    }) as typeof streamMessage;

    await expect(runAgentLoop(
      [{ role: "user", content: "inspect it" }],
      "openai",
      "gpt-5.6-sol",
      callbacks({
        drainNextTurnMessages: () => {
          drainCalls += 1;
          return [{ role: "user", content: "queued follow-up" }];
        },
      }),
      {
        signal: controller.signal,
        state: recovery,
        streamMessageFn: fakeStream,
        executor: async () => {
          // Ctrl+Q can arrive while a tool is settling. The completed tool round
          // remains recoverable, but the queued prompt belongs to a fresh turn.
          controller.abort();
          return [{
            toolCallId: "call-before-interrupt",
            toolName: "read",
            output: "file contents",
            isError: false,
          }];
        },
      },
    )).rejects.toThrow();

    expect(streamCalls).toBe(1);
    expect(drainCalls).toBe(0);
    expect(recovery.completedMessages).toHaveLength(2);
  });
});

describe("tool-call presentation", () => {
  test("snapshots presentation into live blocks and durable tool-use messages", async () => {
    let streamCalls = 0;
    const fakeStream = (async () => {
      streamCalls++;
      if (streamCalls === 1) {
        return {
          text: "",
          thinking: "",
          stopReason: "tool_use",
          blocks: [],
          toolCalls: [{ id: "call-local", name: "bash", input: { command: "./scripts/exo-check" } }],
        } satisfies StreamResult;
      }
      return {
        text: "done",
        thinking: "",
        stopReason: "stop",
        blocks: [{ type: "text", text: "done" }],
        toolCalls: [],
      } satisfies StreamResult;
    }) as typeof streamMessage;
    const emitted: Array<Parameters<AgentCallbacks["onToolCall"]>[0]> = [];
    const presentation = {
      bashStyles: [{ cmd: "./scripts/exo-check", label: "Check", color: "#123456" }],
    };

    const result = await runAgentLoop(
      [{ role: "user", content: "check it" }],
      "openai",
      "gpt-5.6-sol",
      callbacks({ onToolCall: (block) => emitted.push(block) }),
      {
        streamMessageFn: fakeStream,
        presentationResolver: () => presentation,
        executor: async () => [{
          toolCallId: "call-local",
          toolName: "bash",
          output: "ok",
          isError: false,
        }],
      },
    );

    expect(emitted[0]?.presentation).toEqual(presentation);
    expect(result.blocks.find((block) => block.type === "tool_call")).toMatchObject({ presentation });
    expect(result.newMessages[0]?.content).toContainEqual({
      type: "tool_use",
      id: "call-local",
      name: "bash",
      input: { command: "./scripts/exo-check" },
      presentation,
    });
  });

  test("a stalled presentation resolver never prevents tool execution", async () => {
    let streamCalls = 0;
    let executed = false;
    const fakeStream = (async () => {
      streamCalls++;
      return streamCalls === 1
        ? {
            text: "",
            thinking: "",
            stopReason: "tool_use",
            blocks: [],
            toolCalls: [{ id: "call-1", name: "bash", input: { command: "./exo-test" } }],
          } satisfies StreamResult
        : {
            text: "done",
            thinking: "",
            stopReason: "stop",
            blocks: [{ type: "text", text: "done" }],
            toolCalls: [],
          } satisfies StreamResult;
    }) as typeof streamMessage;

    const result = await runAgentLoop(
      [{ role: "user", content: "run it" }],
      "openai",
      "gpt-5.6-sol",
      callbacks(),
      {
        streamMessageFn: fakeStream,
        presentationResolver: () => new Promise(() => {}),
        executor: async () => {
          executed = true;
          return [{ toolCallId: "call-1", toolName: "bash", output: "ok", isError: false }];
        },
      },
    );

    expect(executed).toBe(true);
    expect(result.blocks.find((block) => block.type === "tool_call")).not.toHaveProperty("presentation");
  });
});
