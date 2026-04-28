import { describe, expect, test } from "bun:test";
import type { ApiMessage } from "../../messages";
import { buildDeepSeekMessagesForTest, readDeepSeekEventsForTest } from "./api";

describe("DeepSeek chat backend", () => {
  test("streams reasoning, text, tool calls, and usage", () => {
    const blockStarts: string[] = [];
    const result = readDeepSeekEventsForTest([
      {
        choices: [{ delta: { reasoning_content: "think " }, finish_reason: null }],
      },
      {
        choices: [{ delta: { content: "hello" }, finish_reason: null }],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "{\"command\":" } }] }, finish_reason: null }],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"echo hi\"}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 12, completion_tokens: 34 },
      },
    ], {
      onBlockStart: (type) => blockStarts.push(type),
    });

    expect(blockStarts).toEqual(["thinking", "text"]);
    expect(result.thinking).toBe("think ");
    expect(result.text).toBe("hello");
    expect(result.stopReason).toBe("tool_use");
    expect(result.inputTokens).toBe(12);
    expect(result.outputTokens).toBe(34);
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "bash", input: { command: "echo hi" } }]);
  });

  test("replays assistant reasoning and tool calls in DeepSeek chat format", () => {
    const messages: ApiMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reason", signature: "" },
          { type: "text", text: "I'll check." },
          { type: "tool_use", id: "call_1", name: "bash", input: { command: "date" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: "Mon", is_error: false }],
      },
    ];

    expect(buildDeepSeekMessagesForTest(messages, "system prompt")).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "I'll check.",
        reasoning_content: "reason",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"date"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "Mon" },
    ]);
  });
});
