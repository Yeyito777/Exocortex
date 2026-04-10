import { describe, expect, test } from "bun:test";
import { buildClaudePrompt, buildClaudeSdkUserMessage, extractResumeSessionId, renderMessageContent, resolveClaudeModel } from "./prompt";

describe("Claude Code prompt shaping", () => {
  test("resolves shorthand Claude model ids", () => {
    expect(resolveClaudeModel("sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveClaudeModel("claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  test("extracts the latest Claude session id from provider data", () => {
    expect(extractResumeSessionId([
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }], providerData: { anthropic: { sessionId: "sess_1" } } },
      { role: "assistant", content: [{ type: "text", text: "later" }], providerData: { anthropic: { sessionId: "sess_2" } } },
    ])).toBe("sess_2");
  });

  test("renders structured tool history into transcript text", () => {
    expect(renderMessageContent([
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pwd" } },
      { type: "tool_result", tool_use_id: "toolu_1", content: "/repo" },
    ])).toContain("[tool_use Bash]");
  });

  test("uses only the newest user message when resuming a Claude session", () => {
    const prompt = buildClaudePrompt([
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "answer" }], providerData: { anthropic: { sessionId: "sess_1" } } },
      { role: "user", content: "follow up" },
    ], "sess_1");

    expect(prompt).toBe("follow up");
  });

  test("builds a transcript when no Claude session exists yet", () => {
    const prompt = buildClaudePrompt([
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ], null);

    expect(prompt).toContain("User:\nfirst");
    expect(prompt).toContain("Assistant:\nanswer");
  });

  test("builds an SDK user message with image blocks for Claude-native sessions", () => {
    const message = buildClaudeSdkUserMessage([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abcd" } },
        ],
      },
    ], null);

    expect(message.message.role).toBe("user");
    expect(Array.isArray(message.message.content)).toBe(true);
    expect(message.message.content).toEqual([
      { type: "text", text: "describe this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abcd" } },
    ]);
  });
});
