import { describe, expect, test } from "bun:test";
import type { ApiMessage } from "../../messages";
import { buildAnthropicRequest, sanitizeMessagesForAnthropic } from "./request";

describe("sanitizeMessagesForAnthropic", () => {
  test("strips unsigned thinking blocks and drops assistant messages left empty", () => {
    const messages: ApiMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning", signature: "" },
          { type: "text", text: "visible answer" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thinking only", signature: "" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "signed reasoning", signature: "sig-123" },
        ],
      },
    ];

    expect(sanitizeMessagesForAnthropic(messages)).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "visible answer" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "signed reasoning", signature: "sig-123" },
        ],
      },
    ]);
  });
});

describe("buildAnthropicRequest", () => {
  test("replays sanitized assistant history in the request body", () => {
    const messages: ApiMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning", signature: "" },
          { type: "text", text: "visible answer" },
        ],
      },
    ];

    const { init } = buildAnthropicRequest("token", messages, "claude-opus-4-6", 4096);
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: Array<Record<string, unknown>> | string }> };

    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toMatchObject({ role: "assistant" });
    expect(Array.isArray(body.messages[1]!.content)).toBe(true);
    expect(body.messages[1]!.content).toEqual([
      {
        type: "text",
        text: "visible answer",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });
});
