import { describe, expect, test } from "bun:test";
import type { ApiContentBlock, Conversation, StoredMessage } from "../messages";
import { executeContext, type ContextToolEnv } from "./context";

function makeConversation(messages: StoredMessage[]): Conversation {
  return {
    id: "test-conv",
    provider: "openai",
    model: "gpt-5.5",
    effort: "high",
    fastMode: false,
    messages,
    createdAt: 0,
    updatedAt: 0,
    lastContextTokens: null,
    marked: false,
    pinned: false,
    sortOrder: 0,
    title: "",
  };
}

function makeEnv(conv: Conversation, protectedTailCount = 0): { env: ContextToolEnv; wasModified: () => boolean } {
  let modified = false;
  return {
    env: {
      conv,
      onContextModified: () => { modified = true; },
      summarizer: () => "",
      protectedTailCount,
      contextLimit: 1_000_000,
      summarizeWithInnerLlm: async () => "summary",
    },
    wasModified: () => modified,
  };
}

function makeThinkingAssistantMessage(text = "answer"): StoredMessage & { role: "assistant" } {
  const content: ApiContentBlock[] = [
    { type: "thinking", thinking: "hidden reasoning", signature: "sig" },
    { type: "text", text },
  ];
  return { role: "assistant", content, metadata: null };
}

function makeToolUseAssistantMessage(id = "tool-1", name = "bash"): StoredMessage & { role: "assistant" } {
  const blocks: ApiContentBlock[] = [
    { type: "tool_use", id, name, input: { command: "echo hi" } },
  ];
  return { role: "assistant", content: blocks, metadata: null };
}

function makeToolResultUserMessage(content = "tool output", id = "tool-1"): StoredMessage & { role: "user" } {
  const blocks: ApiContentBlock[] = [
    { type: "tool_result", tool_use_id: id, content },
  ];
  return { role: "user", content: blocks, metadata: null };
}

describe("context tool", () => {
  test("list excludes per-conversation system instructions from visible turns", async () => {
    const conv = makeConversation([
      { role: "system_instructions", content: "Be terse.", metadata: null },
      { role: "user", content: "hello", metadata: null },
      { role: "assistant", content: "hi", metadata: null },
    ]);

    const { env } = makeEnv(conv);
    const result = await executeContext({ action: "list" }, env);

    expect(result.isError).toBe(false);
    expect(result.output).not.toContain("Be terse.");
    expect(result.output).toContain('"hello"');
    expect(result.output).toContain("Modifiable turns: 0–1");
  });

  test("delete cannot remove per-conversation system instructions", async () => {
    const conv = makeConversation([
      { role: "system_instructions", content: "Be terse.", metadata: null },
      { role: "user", content: "hello", metadata: null },
      { role: "assistant", content: "hi", metadata: null },
    ]);

    const { env, wasModified } = makeEnv(conv);
    const result = await executeContext({ action: "delete", start: 0, end: 0 }, env);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Deleted turns 0–0");
    expect(wasModified()).toBe(true);
    expect(conv.messages).toEqual([
      { role: "system_instructions", content: "Be terse.", metadata: null },
      { role: "assistant", content: "hi", metadata: null },
    ]);
  });

  test("summarize uses the injected inner LLM and preserves system instructions", async () => {
    const conv = makeConversation([
      { role: "system_instructions", content: "Be terse.", metadata: null },
      { role: "user", content: "hello", metadata: null },
      { role: "assistant", content: "hi", metadata: null },
    ]);
    conv.lastContextTokens = 2_000;

    const calls: Array<{ systemPrompt: string; userText: string; maxTokens: number }> = [];
    const { env, wasModified } = makeEnv(conv);
    env.summarizeWithInnerLlm = async (systemPrompt, userText, maxTokens) => {
      calls.push({ systemPrompt, userText, maxTokens });
      return "kept summary";
    };

    const result = await executeContext({ action: "summarize", start: 0, end: 1 }, env);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("Summarized turns 0–1 into 2 turns");
    expect(wasModified()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userText).toContain("User: hello");
    expect(calls[0]?.userText).toContain("Assistant: hi");
    expect(conv.messages).toEqual([
      { role: "system_instructions", content: "Be terse.", metadata: null },
      { role: "user", content: "[Summary of turns 0–1]", metadata: null },
      { role: "assistant", content: "kept summary", metadata: null },
    ]);
  });

  test("delete clears stale lastContextTokens so list re-estimates from current messages", async () => {
    const conv = makeConversation([
      { role: "user", content: "hello", metadata: null },
      { role: "assistant", content: "hi", metadata: null },
    ]);
    conv.lastContextTokens = 2_000;

    const { env } = makeEnv(conv);
    const del = await executeContext({ action: "delete", start: 0, end: 0 }, env);
    expect(del.isError).toBe(false);

    expect(conv.lastContextTokens).toBeNull();

    const listed = await executeContext({ action: "list" }, env);
    expect(listed.isError).toBe(false);
    expect(listed.output).toContain("estimated — no API token count available yet");
    expect(listed.output).not.toContain("Context: 2,000 tokens");
  });

  test("summarize clears stale lastContextTokens after replacing a range", async () => {
    const conv = makeConversation([
      { role: "user", content: "hello", metadata: null },
      { role: "assistant", content: "hi", metadata: null },
    ]);
    conv.lastContextTokens = 2_000;

    const { env } = makeEnv(conv);
    const result = await executeContext({ action: "summarize", start: 0, end: 1 }, env);

    expect(result.isError).toBe(false);
    expect(conv.lastContextTokens).toBeNull();
  });

  test("strip_thinking clears stale lastContextTokens after mutating assistant content", async () => {
    const conv = makeConversation([
      makeThinkingAssistantMessage(),
    ]);
    conv.lastContextTokens = 2_000;

    const { env } = makeEnv(conv);
    const result = await executeContext({ action: "strip_thinking", start: 0, end: 0 }, env);

    expect(result.isError).toBe(false);
    expect(conv.lastContextTokens).toBeNull();
  });

  test("strip_results clears stale lastContextTokens after mutating tool results", async () => {
    const conv = makeConversation([
      makeToolResultUserMessage("large tool output that is definitely longer than the stripped placeholder"),
    ]);
    conv.lastContextTokens = 2_000;

    const { env } = makeEnv(conv);
    const result = await executeContext({ action: "strip_results", start: 0, end: 0 }, env);

    expect(result.isError).toBe(false);
    expect(conv.lastContextTokens).toBeNull();
  });

  test("list shows in-progress assistant message turns separately from persisted history", async () => {
    const conv = makeConversation([
      { role: "user", content: "persisted prompt", metadata: null },
    ]);
    const { env } = makeEnv(conv);
    env.currentTurnMessages = [
      makeToolUseAssistantMessage(),
      makeToolResultUserMessage("large current result"),
      makeToolUseAssistantMessage("tool-2"),
    ];
    env.protectedCurrentTurnTailCount = 1;

    const result = await executeContext({ action: "list" }, env);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("In-progress assistant message turns");
    expect(result.output).toContain("modifiable");
    expect(result.output).toContain("protected");
    expect(result.output).toContain("tool_result");
  });

  test("strip_results can target in-progress assistant message turns by listed index", async () => {
    const conv = makeConversation([
      makeToolResultUserMessage("persisted tool output that must stay intact"),
    ]);
    conv.lastContextTokens = 2_000;
    const current = [
      makeToolUseAssistantMessage("tool-1"),
      makeToolResultUserMessage("current tool output that is definitely longer than the stripped placeholder", "tool-1"),
      makeToolUseAssistantMessage("tool-2"),
    ];
    const { env, wasModified } = makeEnv(conv);
    env.currentTurnMessages = current;
    env.protectedCurrentTurnTailCount = 1;

    const result = await executeContext({ action: "strip_results", start: 2, end: 2 }, env);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("in-progress assistant message");
    expect(wasModified()).toBe(true);
    expect(conv.lastContextTokens).toBeNull();
    expect((conv.messages[0].content as ApiContentBlock[])[0]).toMatchObject({ content: "persisted tool output that must stay intact" });
    expect((current[1].content as ApiContentBlock[])[0]).toMatchObject({ content: "[Output removed by context tool]" });
    expect((current[2].content as ApiContentBlock[])[0]).toMatchObject({ type: "tool_use", id: "tool-2" });
  });

  test("strip_results clamps oversized end indices", async () => {
    const conv = makeConversation([
      makeToolUseAssistantMessage("tool-1"),
      makeToolResultUserMessage("persisted tool output that is definitely longer than the stripped placeholder", "tool-1"),
    ]);
    const { env } = makeEnv(conv);

    const result = await executeContext({ action: "strip_results", start: 0, end: 999 }, env);

    expect(result.isError).toBe(false);
    expect(result.output).not.toContain("out of range");
    expect((conv.messages[1].content as ApiContentBlock[])[0]).toMatchObject({ content: "[Output removed by context tool]" });
  });

  test("strip_results can clamp oversized end indices across persisted and in-progress turns", async () => {
    const conv = makeConversation([
      makeToolUseAssistantMessage("persisted-tool"),
      makeToolResultUserMessage("persisted tool output that is definitely longer than the stripped placeholder", "persisted-tool"),
    ]);
    const current = [
      makeToolUseAssistantMessage("current-tool"),
      makeToolResultUserMessage("current tool output that is definitely longer than the stripped placeholder", "current-tool"),
    ];
    const { env } = makeEnv(conv);
    env.currentTurnMessages = current;
    env.protectedCurrentTurnTailCount = 0;

    const result = await executeContext({ action: "strip_results", start: 0, end: 999 }, env);

    expect(result.isError).toBe(false);
    expect(result.output).not.toContain("out of range");
    expect((conv.messages[1].content as ApiContentBlock[])[0]).toMatchObject({ content: "[Output removed by context tool]" });
    expect((current[1].content as ApiContentBlock[])[0]).toMatchObject({ content: "[Output removed by context tool]" });
  });

  test("delete rejects in-progress assistant message turn indices", async () => {
    const conv = makeConversation([
      { role: "user", content: "persisted prompt", metadata: null },
    ]);
    const { env } = makeEnv(conv);
    env.currentTurnMessages = [makeToolUseAssistantMessage("tool-1")];

    const result = await executeContext({ action: "delete", start: 1, end: 1 }, env);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Cannot delete in-progress assistant message turns");
    expect(conv.messages).toHaveLength(1);
  });

  test("summarize can replace in-progress assistant message turns with model-visible summary notice", async () => {
    const conv = makeConversation([]);
    const current = [
      makeToolUseAssistantMessage("tool-1"),
      makeToolResultUserMessage("x".repeat(3_000), "tool-1"),
      makeToolUseAssistantMessage("tool-2"),
    ];
    const { env } = makeEnv(conv);
    env.currentTurnMessages = current;
    env.protectedCurrentTurnTailCount = 1;
    env.summarizeWithInnerLlm = async () => "important summarized facts";

    const result = await executeContext({ action: "summarize", start: 0, end: 1 }, env);

    expect(result.isError).toBe(false);
    expect(current).toHaveLength(2);
    expect(current[0]).toMatchObject({
      role: "user",
      content: "[Summary of in-progress assistant message turns 0–1]\nimportant summarized facts",
      metadata: { system: true, kind: "current_turn_summary" },
    });
    expect(current[1].role).toBe("assistant");
  });
});
