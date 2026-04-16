import { describe, expect, test } from "bun:test";
import type { Conversation, StoredMessage } from "../messages";
import { executeContext, type ContextToolEnv } from "./context";

function makeConversation(messages: StoredMessage[]): Conversation {
  return {
    id: "test-conv",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
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
});
