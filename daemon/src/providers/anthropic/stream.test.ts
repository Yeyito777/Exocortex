import { describe, expect, test } from "bun:test";
import type { StreamCallbacks } from "../types";
import { ClaudeOverageError, createClaudeStreamState, finalizeClaudeStream, pushClaudeMessage } from "./stream";
import { handleUsageHeaders } from "./usage";

function recorder() {
  const events: string[] = [];
  const headers: Headers[] = [];
  const callbacks: StreamCallbacks = {
    onText: (t) => events.push(`text:${t}`),
    onThinking: (t) => events.push(`thinking:${t}`),
    onBlockStart: (type) => events.push(`start:${type}`),
    onToolCall: (b) => events.push(`call:${b.toolName}:${b.summary}`),
    onToolResult: (b) => events.push(`result:${b.toolName}:${b.output}`),
    onHeaders: (h) => headers.push(h),
  };
  return { events, headers, callbacks };
}

const SESSION = "11111111-1111-1111-1111-111111111111";
const se = (event: Record<string, unknown>) => ({ type: "stream_event", event, parent_tool_use_id: null, session_id: SESSION });

/** Shape recorded from Claude Code 2.1.294: one Bash round, then a final answer. */
const TOOL_TURN = [
  { type: "system", subtype: "init", session_id: SESSION },
  se({ type: "message_start", message: { usage: { input_tokens: 2, cache_creation_input_tokens: 20933, cache_read_input_tokens: 0, output_tokens: 1 } } }),
  se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } }),
  se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"command\":\"echo hi\"}" } }),
  { type: "assistant", uuid: "a-1", session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } }] } },
  se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } }),
  { type: "user", uuid: "u-1", session_id: SESSION, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi", is_error: false }] } },
  // A subagent's traffic must not leak into the parent transcript.
  { type: "assistant", uuid: "sub-1", session_id: SESSION, parent_tool_use_id: "toolu_x", message: { content: [{ type: "text", text: "subagent noise" }] } },
  se({ type: "message_start", message: { usage: { input_tokens: 2, cache_creation_input_tokens: 2067, cache_read_input_tokens: 20933, output_tokens: 1 } } }),
  se({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
  se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } }),
  se({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "It printed hi." } }),
  { type: "assistant", uuid: "a-2", session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: "thinking", thinking: "It printed hi.", signature: "sig" }] } },
  se({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
  se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "It printed " } }),
  se({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi." } }),
  { type: "assistant", uuid: "a-3", session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: "text", text: "It printed hi." }] } },
  se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } }),
  { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", session_id: SESSION },
];

describe("Claude Code stream translation", () => {
  test("streams live deltas and records tool rounds as tool_use/tool_result messages", () => {
    const { events, callbacks } = recorder();
    const state = createClaudeStreamState(callbacks, "/work");
    for (const message of TOOL_TURN) pushClaudeMessage(state, message);
    const result = finalizeClaudeStream(state);

    expect(events).toEqual([
      "call:Bash:echo hi",
      "result:Bash:hi",
      "start:thinking",
      "thinking:It printed hi.",
      "start:text",
      "text:It printed ",
      "text:hi.",
    ]);
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("stop");
    expect(result.text).toBe("It printed hi.");
    expect(result.blocks.map((b) => b.type)).toEqual(["tool_call", "tool_result", "thinking", "text"]);
    expect(result.transcriptMessages).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi", is_error: false }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "It printed hi.", signature: "sig" },
          { type: "text", text: "It printed hi." },
        ],
        providerData: { anthropic: { sessionId: SESSION, resumeAt: "a-3", cwd: "/work" } },
      },
    ]);
    // Context = the latest call's full prompt; output = summed across calls.
    expect(result.inputTokens).toBe(2 + 2067 + 20933);
    expect(result.cachedInputTokens).toBe(20933);
    expect(result.outputTokens).toBe(70);
  });

  test("fails when Claude Code exits without a result", () => {
    const state = createClaudeStreamState(recorder().callbacks, "/work");
    pushClaudeMessage(state, TOOL_TURN[0]);
    expect(() => finalizeClaudeStream(state)).toThrow("exited before finishing");
  });

  test("surfaces error results", () => {
    const state = createClaudeStreamState(recorder().callbacks, "/work");
    expect(() => pushClaudeMessage(state, { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] })).toThrow("boom");
  });

  test("forwards subscription usage and refuses overage", () => {
    const { headers, callbacks } = recorder();
    const state = createClaudeStreamState(callbacks, "/work");
    const info = {
      status: "allowed",
      isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1791496800 }, seven_day: { utilization: 0.5, resetsAt: 1791619200 } },
    };
    pushClaudeMessage(state, { type: "rate_limit_event", rate_limit_info: info });
    const updates: unknown[] = [];
    handleUsageHeaders(headers[0], (usage) => updates.push(usage));
    expect(updates).toEqual([{
      fiveHour: { utilization: 25, resetsAt: 1791496800000 },
      sevenDay: { utilization: 50, resetsAt: 1791619200000 },
    }]);

    expect(() => pushClaudeMessage(state, { type: "rate_limit_event", rate_limit_info: { ...info, isUsingOverage: true } }))
      .toThrow(ClaudeOverageError);
  });
});
