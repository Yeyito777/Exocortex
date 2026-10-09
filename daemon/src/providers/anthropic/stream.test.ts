import { describe, expect, test } from "bun:test";
import type { ProviderRound, StreamCallbacks } from "../types";
import { ClaudeOverageError, commitInterruptedRound, createClaudeStreamState, finalizeClaudeStream, pushClaudeMessage } from "./stream";
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

  test("hands each tool round to the agent loop as soon as its results arrive", () => {
    const { events, callbacks } = recorder();
    const rounds: ProviderRound[] = [];
    callbacks.onProviderRound = (round) => {
      events.push("round");
      rounds.push(round);
    };
    const state = createClaudeStreamState(callbacks, "/work");
    for (const message of TOOL_TURN) pushClaudeMessage(state, message);
    const result = finalizeClaudeStream(state);

    expect(events.slice(0, 3)).toEqual(["call:Bash:echo hi", "result:Bash:hi", "round"]);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].blocks.map((b) => b.type)).toEqual(["tool_call", "tool_result"]);
    expect(rounds[0].messages).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hi", is_error: false }],
        // An interrupted turn resumes the Claude Code session right after this round.
        providerData: { anthropic: { sessionId: SESSION, resumeAt: "u-1", cwd: "/work" } },
      },
    ]);
    expect(rounds[0].outputTokens).toBe(30);
    expect(rounds[0].inputTokens).toBe(2 + 20933);

    // The result carries only what followed the last round; usage totals still cover the request.
    expect(result.blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(result.transcriptMessages).toEqual([{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "It printed hi.", signature: "sig" },
        { type: "text", text: "It printed hi." },
      ],
      providerData: { anthropic: { sessionId: SESSION, resumeAt: "a-3", cwd: "/work" } },
    }]);
    expect(result.outputTokens).toBe(70);
  });

  test("times each API call from its request to its last token, like the agent loop's own calls", () => {
    let now = 0;
    const rates: number[] = [];
    const { callbacks } = recorder();
    callbacks.onGenerationRate = (rate) => rates.push(rate);
    const state = createClaudeStreamState(callbacks, "/work", null, () => now);
    const requesting = { type: "system", subtype: "status", status: "requesting", session_id: SESSION };
    const at = (time: number, message: Record<string, unknown>) => { now = time; pushClaudeMessage(state, message); };

    // Recorded order from Claude Code 2.1.295: the Read result arrives while the
    // call is still generating its second tool call.
    at(0, requesting);
    at(600, se({ type: "message_start", message: { usage: { input_tokens: 2, cache_read_input_tokens: 9000 } } }));
    at(800, { type: "assistant", uuid: "a-1", session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }] } });
    at(810, { type: "user", uuid: "u-1", session_id: SESSION, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a", is_error: false }] } });
    at(900, requesting); // a subagent's request while this call streams
    at(1000, { type: "assistant", uuid: "a-2", session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }] } });
    at(2000, se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 100 } }));
    expect(rates).toEqual([50]);

    // A retried call is not timed.
    at(2100, requesting);
    at(2200, { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, session_id: SESSION });
    at(3000, se({ type: "message_start", message: { usage: { input_tokens: 2 } } }));
    at(4000, se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } }));
    expect(rates).toEqual([50]);

    at(4100, requesting);
    at(4500, se({ type: "message_start", message: { usage: { input_tokens: 2 } } }));
    at(5100, se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } }));
    expect(rates).toEqual([50, 40]);

    // Output a relay replayed after a daemon restart is not timed, nor is the call it was in the middle of.
    const replayed = (message: Record<string, unknown>) => ({ ...message, exocortex_replayed: true });
    at(6000, replayed(requesting));
    at(6000, replayed(se({ type: "message_start", message: { usage: { input_tokens: 2 } } })));
    at(6000, replayed(se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } })));
    at(6000, replayed(se({ type: "message_start", message: { usage: { input_tokens: 2 } } })));
    at(7000, se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } }));
    expect(rates).toEqual([50, 40]);
  });

  test("commits parallel tool calls only once every result is in", () => {
    const { callbacks } = recorder();
    const rounds: ProviderRound[] = [];
    callbacks.onProviderRound = (round) => rounds.push(round);
    const state = createClaudeStreamState(callbacks, "/work");
    const call = (id: string, uuid: string) => ({ type: "assistant", uuid, session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: `/${id}` } }] } });
    const done = (id: string, uuid: string) => ({ type: "user", uuid, session_id: SESSION, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: id, is_error: false }] } });

    pushClaudeMessage(state, call("t1", "a-1"));
    pushClaudeMessage(state, call("t2", "a-2"));
    pushClaudeMessage(state, done("t1", "u-1"));
    expect(rounds).toHaveLength(0);
    pushClaudeMessage(state, done("t2", "u-2"));
    expect(rounds).toHaveLength(1);
    expect(rounds[0].messages.map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(rounds[0].messages[1].content).toHaveLength(2);
    expect(rounds[0].messages[1].providerData?.anthropic?.resumeAt).toBe("u-2");
  });

  test("keeps streaming past a result Claude Code produced for its own turn", () => {
    const { events, callbacks } = recorder();
    const state = createClaudeStreamState(callbacks, "/work", "prompt-1");
    // Recorded from Claude Code 2.1.295 resuming a session whose process died
    // with background shells running: the orphan report gets a model-less turn.
    pushClaudeMessage(state, { type: "system", subtype: "task_notification", task_id: "b1", status: "stopped", session_id: SESSION });
    pushClaudeMessage(state, { type: "result", subtype: "success", is_error: false, num_turns: 0, stop_reason: null, origin: { kind: "task-notification" }, session_id: SESSION });
    expect(state.done).toBe(false);

    pushClaudeMessage(state, { type: "assistant", uuid: "a-1", session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: "text", text: "ok" }] } });
    pushClaudeMessage(state, { type: "result", subtype: "success", is_error: false, num_turns: 1, stop_reason: "end_turn", user_message_uuid: "prompt-1", user_message_uuids: ["prompt-1"], session_id: SESSION });
    expect(state.done).toBe(true);
    expect(finalizeClaudeStream(state).text).toBe("ok");
    expect(events).toEqual([]);
  });

  test("an interruption keeps the running tool calls, without a resume point inside them", () => {
    const { events, callbacks } = recorder();
    const rounds: ProviderRound[] = [];
    callbacks.onProviderRound = (round) => rounds.push(round);
    const state = createClaudeStreamState(callbacks, "/work");
    pushClaudeMessage(state, { type: "assistant", uuid: "a-1", session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: "text", text: "Waiting." }] } });
    pushClaudeMessage(state, { type: "assistant", uuid: "a-2", session_id: SESSION, parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "t1", name: "mcp__exocortex__chrono", input: { action: "sleep", duration: "4m" } }] } });

    commitInterruptedRound(state);
    expect(events.at(-1)).toBe("result:chrono:Interrupted before this tool call finished.");
    expect(rounds).toHaveLength(1);
    expect(rounds[0].messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Waiting." },
          { type: "tool_use", id: "t1", name: "chrono", input: { action: "sleep", duration: "4m" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Interrupted before this tool call finished.", is_error: true }] },
    ]);

    // Nothing in flight: the orchestrator salvages streamed text itself.
    commitInterruptedRound(state);
    expect(rounds).toHaveLength(1);
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
