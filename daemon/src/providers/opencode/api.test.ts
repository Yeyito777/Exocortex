import { describe, expect, test } from "bun:test";
import type { ApiMessage } from "../../messages";
import { buildOpenCodeMessagesForTest, readOpenCodeEventsForTest } from "./api";
import { buildRequestBody } from "./request";

const VALID_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

describe("OpenCode Zen chat backend", () => {
  test("builds multimodal Ox Alpha requests with supported reasoning effort", () => {
    const messages: ApiMessage[] = [{
      role: "user",
      content: [
        { type: "text", text: "What color?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: VALID_PNG } },
      ],
    }];

    const body = buildRequestBody(messages, "ox-alpha", { effort: "max", maxTokens: 200 });

    expect(body.model).toBe("x-preview-f-free");
    expect(body.reasoning_effort).toBe("max");
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.max_tokens).toBe(200);
    expect(body.messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "What color?" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${VALID_PNG}` } },
      ],
    }]);
  });

  test("replays reasoning, tool calls, tool results, and tool-result images", () => {
    const messages: ApiMessage[] = [
      { role: "user", content: "inspect it" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should inspect it.", signature: "" },
          { type: "tool_use", id: "call_1", name: "read", input: { file_path: "/tmp/red.png" } },
        ],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "call_1",
          is_error: false,
          content: [
            { type: "text", text: "Read image" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: VALID_PNG } },
          ],
        }],
      },
    ];

    expect(buildOpenCodeMessagesForTest(messages)).toEqual([
      { role: "user", content: "inspect it" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "I should inspect it.",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: '{"file_path":"/tmp/red.png"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "Read image" },
      {
        role: "user",
        content: [
          { type: "text", text: "Image output for tool call call_1." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${VALID_PNG}` } },
        ],
      },
    ]);
  });

  test("parses reasoning, tool calls, cached usage, and ignores cost-only events", () => {
    const result = readOpenCodeEventsForTest([
      { choices: [{ delta: { reasoning_content: "think" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"command":"pwd"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64, cache_write_tokens: 12 } } },
      { choices: [], cost: "0" },
    ]);

    expect(result.thinking).toBe("think");
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "bash", input: { command: "pwd" } }]);
    expect(result.inputTokens).toBe(100);
    expect(result.cachedInputTokens).toBe(64);
    expect(result.cacheMissInputTokens).toBe(12);
    expect(result.outputTokens).toBe(20);
  });

  test("normalizes unsupported Exocortex effort levels to Ox Alpha low", () => {
    expect(buildRequestBody([{ role: "user", content: "hi" }], "ox-alpha", { effort: "none" }).reasoning_effort).toBe("low");
    expect(buildRequestBody([{ role: "user", content: "hi" }], "ox-alpha", { effort: "medium" }).reasoning_effort).toBe("low");
  });
});
