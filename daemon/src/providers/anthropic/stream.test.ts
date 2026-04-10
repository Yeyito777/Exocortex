import { describe, expect, mock, test } from "bun:test";
import { readClaudeEventsForTest } from "./stream";

describe("Claude Code stream parsing", () => {
  test("parses partial text deltas and session metadata", () => {
    const result = readClaudeEventsForTest([
      { type: "system", subtype: "init", session_id: "sess_123" },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hel" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", session_id: "sess_123", usage: { input_tokens: 12, output_tokens: 5 } },
    ]);

    expect(result.text).toBe("hello");
    expect(result.blocks).toEqual([{ type: "text", text: "hello" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(5);
    expect(result.assistantProviderData).toEqual({ anthropic: { sessionId: "sess_123" } });
  });

  test("falls back to assistant snapshots when no partial stream events were emitted", () => {
    const result = readClaudeEventsForTest([
      {
        type: "assistant",
        session_id: "sess_456",
        message: {
          content: [{ type: "text", text: "snapshot answer" }],
          usage: { input_tokens: 3, output_tokens: 2 },
          stop_reason: "stop_sequence",
        },
      },
      { type: "result", subtype: "success", is_error: false, session_id: "sess_456" },
    ]);

    expect(result.text).toBe("snapshot answer");
    expect(result.stopReason).toBe("stop_sequence");
    expect(result.assistantProviderData).toEqual({ anthropic: { sessionId: "sess_456" } });
  });

  test("captures Claude Code native tool calls and results", () => {
    const onToolCall = mock(() => {});
    const onToolResult = mock(() => {});
    const result = readClaudeEventsForTest([
      { type: "system", subtype: "init", session_id: "sess_tools" },
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "Bash" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
        },
      },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "/repo" }] }],
        },
      },
      { type: "result", subtype: "success", is_error: false, session_id: "sess_tools" },
    ], { onToolCall, onToolResult });

    expect(result.blocks).toEqual([
      { type: "tool_call", id: "toolu_1", name: "Bash", input: { command: "pwd" }, summary: 'Bash {"command":"pwd"}' },
      { type: "tool_result", toolUseId: "toolu_1", toolName: "Bash", output: "/repo", isError: false },
    ]);
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledTimes(1);
  });

  test("surfaces Claude auth failures as AuthError", () => {
    expect(() => readClaudeEventsForTest([
      {
        type: "assistant",
        error: "authentication_failed",
        isApiErrorMessage: true,
        message: {
          content: [{ type: "text", text: "Failed to authenticate. API Error: 401" }],
        },
      },
      { type: "result", subtype: "success", is_error: true, result: "Failed to authenticate. API Error: 401" },
    ])).toThrow("Failed to authenticate");
  });
});
