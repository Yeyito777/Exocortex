import { describe, expect, test } from "bun:test";
import type { ApiContentBlock, ApiMessage, Conversation, StoredMessage } from "../messages";
import { context, executeContext, type ContextToolEnv } from "./context";

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

function snapshotFrom(output: string): string {
  const match = output.match(/Snapshot: (ctx-n\d+-[0-9a-f]+)/);
  expect(match).not.toBeNull();
  return match![1];
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

function makeContextToolUseAssistantMessage(id = "context-1"): StoredMessage & { role: "assistant" } {
  const blocks: ApiContentBlock[] = [
    { type: "tool_use", id, name: "context", input: { action: "list" } },
  ];
  return { role: "assistant", content: blocks, metadata: null };
}

function makeToolResultUserMessage(content = "tool output", id = "tool-1"): StoredMessage & { role: "user" } {
  const blocks: ApiContentBlock[] = [
    { type: "tool_result", tool_use_id: id, content },
  ];
  return { role: "user", content: blocks, metadata: null };
}

describe("context tool staged compaction", () => {
  test("display summary shows staged operations instead of opaque op count", () => {
    const summary = context.summarize?.({
      action: "stage",
      targetTokens: 100_000,
      operations: [
        { op: "summarize", start: 1, end: 20 },
        { op: "strip_results", start: 40, end: 55 },
      ],
    });

    expect(summary?.detail).toBe("stage summarize 1–20; strip_results 40–55 target 100k");
    expect(summary?.detail).not.toContain("sr");
  });

  test("list excludes system instructions and returns snapshot plus staged-flow ranges", async () => {
    const conv = makeConversation([
      { role: "system_instructions", content: "Be terse.", metadata: null },
      { role: "user", content: "hello", metadata: null },
      { role: "assistant", content: "hi", metadata: null },
    ]);

    const { env } = makeEnv(conv);
    const result = await executeContext({ action: "list" }, env);

    expect(result.isError).toBe(false);
    expect(result.output).not.toContain("Be terse.");
    expect(result.output).toContain("Snapshot: ctx-");
    expect(result.output).toContain("Card format");
    expect(result.output).toContain("#0 user");
    expect(result.output).toContain("in:  hello");
    expect(result.output).toContain("stage summarize/forget/strip_thinking/strip_results: 0–1");
    expect(result.output).toContain("Flow: list → stage all desired operations");
  });

  test("list stays compact for large conversations and omits only the configured protected tail", async () => {
    const messages: StoredMessage[] = [];
    for (let i = 0; i < 520; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i} ` + "x".repeat(200),
        metadata: null,
      });
    }
    const conv = makeConversation(messages);
    conv.lastContextTokens = 220_000;
    const { env } = makeEnv(conv, 20);

    const result = await executeContext({ action: "list" }, env);

    expect(result.isError).toBe(false);
    expect(result.output.length).toBeLessThan(30_000);
    expect(result.output).toContain("Card format");
    expect(result.output).toContain("499 assistant");
    expect(result.output).not.toContain("500 user");
  });

  test("history protection is just a small tail, not everything since the last real user prompt", async () => {
    const messages: StoredMessage[] = [
      { role: "user", content: "original prompt", metadata: null },
    ];
    for (let i = 0; i < 12; i++) {
      messages.push(makeToolUseAssistantMessage(`tool-${i}`));
      messages.push(makeToolResultUserMessage(`completed output ${i}`, `tool-${i}`));
    }
    const conv = makeConversation(messages);
    conv.lastContextTokens = 20_000;
    const { env } = makeEnv(conv, 5);

    const result = await executeContext({ action: "list" }, env);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("stage summarize/forget/strip_thinking/strip_results: 0–19");
    expect(result.output).toContain("protected/unmodifiable: 20–24");
  });

  test("list preview rows include tool name, input preview, and output preview", async () => {
    const conv = makeConversation([
      makeToolUseAssistantMessage("tool-1", "bash"),
      makeToolResultUserMessage("build succeeded with warnings and a long output " + "x".repeat(500), "tool-1"),
    ]);
    conv.lastContextTokens = 2_000;
    const { env } = makeEnv(conv);

    const result = await executeContext({ action: "list" }, env);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("#1 result:bash");
    expect(result.output).toContain("in:  bash");
    expect(result.output).toContain("echo hi");
    expect(result.output).toContain("out: bash: build succeeded with warnings");
    expect(result.output).not.toContain("x".repeat(200));
  });

  test("stage validates and stores a plan without mutating context", async () => {
    const conv = makeConversation([
      makeToolUseAssistantMessage("tool-1"),
      makeToolResultUserMessage("large tool output that is definitely longer than the stripped placeholder", "tool-1"),
    ]);
    conv.lastContextTokens = 2_000;

    const { env, wasModified } = makeEnv(conv);
    const listed = await executeContext({ action: "list" }, env);
    const snapshot = snapshotFrom(listed.output);
    const staged = await executeContext({
      action: "stage",
      snapshot,
      operations: [{ op: "strip_results", start: 0, end: 1 }],
    }, env);

    expect(staged.isError).toBe(false);
    expect(staged.output).toContain(`Staged 1 context compaction operation against snapshot ${snapshot}`);
    expect(staged.output).toContain("No context was modified yet");
    expect(staged.output).toContain("Run context compact");
    expect(wasModified()).toBe(false);
    expect((conv.messages[1].content as ApiContentBlock[])[0]).toMatchObject({
      content: "large tool output that is definitely longer than the stripped placeholder",
    });
  });

  test("compact applies a staged plan once and clears stale token counts", async () => {
    const conv = makeConversation([
      makeThinkingAssistantMessage("kept assistant text"),
      makeToolUseAssistantMessage("tool-1"),
      makeToolResultUserMessage("tool output that is definitely longer than the stripped placeholder", "tool-1"),
      { role: "user", content: "remove me", metadata: null },
    ]);
    conv.lastContextTokens = 4_000;

    const { env, wasModified } = makeEnv(conv);
    const listed = await executeContext({ action: "list" }, env);
    const snapshot = snapshotFrom(listed.output);
    const staged = await executeContext({
      action: "stage",
      snapshot,
      operations: [
        { op: "strip_thinking", start: 0, end: 0 },
        { op: "strip_results", start: 1, end: 2 },
        { op: "forget", start: 3, end: 3 },
      ],
    }, env);
    expect(staged.isError).toBe(false);

    const compacted = await executeContext({ action: "compact", snapshot }, env);

    expect(compacted.isError).toBe(false);
    expect(compacted.output).toContain("Applied staged compaction plan");
    expect(compacted.output).toContain("stripped thinking 0–0");
    expect(compacted.output).toContain("stripped results 1–2");
    expect(compacted.output).toContain("forgot persisted turns 3–3");
    expect(compacted.output).toContain("Staged plan cleared");
    expect(wasModified()).toBe(true);
    expect(conv.lastContextTokens).toBeNull();
    expect(conv.messages).toHaveLength(3);
    expect((conv.messages[0].content as ApiContentBlock[]).some((b) => b.type === "thinking")).toBe(false);
    expect((conv.messages[2].content as ApiContentBlock[])[0]).toMatchObject({ content: "[Output removed by context tool]" });

    const secondCompact = await executeContext({ action: "compact" }, env);
    expect(secondCompact.isError).toBe(true);
    expect(secondCompact.output).toContain("No staged context compaction plan");
  });

  test("summaries are staged, then generated in parallel during compact", async () => {
    const conv = makeConversation([
      { role: "user", content: "history one " + "x".repeat(3_000), metadata: null },
      { role: "assistant", content: "assistant one " + "y".repeat(3_000), metadata: null },
      { role: "user", content: "history two " + "a".repeat(3_000), metadata: null },
      { role: "assistant", content: "assistant two " + "b".repeat(3_000), metadata: null },
    ]);
    conv.lastContextTokens = 8_000;

    let started = 0;
    let maxConcurrent = 0;
    let inFlight = 0;
    const { env } = makeEnv(conv);
    env.summarizeWithInnerLlm = async (_systemPrompt, userText) => {
      started++;
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await Promise.resolve();
      inFlight--;
      return userText.includes("history one") ? "summary one" : "summary two";
    };

    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);
    const staged = await executeContext({
      action: "stage",
      snapshot,
      operations: [
        { op: "summarize", start: 0, end: 1, prompt: "keep first" },
        { op: "summarize", start: 2, end: 3, prompt: "keep second" },
      ],
    }, env);
    expect(staged.isError).toBe(false);

    const compacted = await executeContext({ action: "compact", snapshot }, env);

    expect(compacted.isError).toBe(false);
    expect(started).toBe(2);
    expect(maxConcurrent).toBe(2);
    expect(conv.messages).toEqual([
      { role: "user", content: "[Summary of turns 0–1]", metadata: null },
      { role: "assistant", content: "summary one", metadata: null },
      { role: "user", content: "[Summary of turns 2–3]", metadata: null },
      { role: "assistant", content: "summary two", metadata: null },
    ]);
  });

  test("compact can summarize ranges split across persisted and in-progress turns", async () => {
    const conv = makeConversation([
      { role: "user", content: "persisted user " + "x".repeat(3_000), metadata: null },
      { role: "assistant", content: "persisted assistant " + "y".repeat(3_000), metadata: null },
    ]);
    conv.lastContextTokens = 4_000;
    const current: ApiMessage[] = [
      makeToolUseAssistantMessage("tool-1"),
      makeToolResultUserMessage("current tool output " + "z".repeat(3_000), "tool-1"),
    ];
    const { env } = makeEnv(conv);
    env.currentTurnMessages = current;
    env.summarizeWithInnerLlm = async (_systemPrompt, userText) => userText.includes("current tool output") ? "current summary" : "history summary";

    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);
    const staged = await executeContext({
      action: "stage",
      snapshot,
      operations: [{ op: "summarize", start: 0, end: 3 }],
    }, env);
    expect(staged.isError).toBe(false);
    expect(staged.output).toContain("Staged 2 context compaction operations");

    const compacted = await executeContext({ action: "compact", snapshot }, env);

    expect(compacted.isError).toBe(false);
    expect(compacted.output).toContain("summarized 0–1 into 2 turns");
    expect(compacted.output).toContain("summarized 2–3 into 1 model-visible summary notice");
    expect(conv.messages[1]).toMatchObject({ role: "assistant", content: "history summary" });
    expect(current[0]).toMatchObject({
      role: "user",
      content: "[Summary of in-progress assistant message turns 2–3]\ncurrent summary",
      metadata: { system: true, kind: "current_turn_summary" },
    });
  });

  test("compact can forget in-progress modifiable turns", async () => {
    const conv = makeConversation([
      { role: "user", content: "persisted user", metadata: null },
      { role: "assistant", content: "persisted assistant", metadata: null },
    ]);
    const current: ApiMessage[] = [
      makeToolUseAssistantMessage("tool-1"),
      makeToolResultUserMessage("current output to forget", "tool-1"),
    ];
    const { env, wasModified } = makeEnv(conv);
    env.currentTurnMessages = current;

    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);
    const staged = await executeContext({
      action: "stage",
      snapshot,
      operations: [{ op: "forget", start: 2, end: 3 }],
    }, env);
    expect(staged.isError).toBe(false);
    expect(staged.output).toContain("forget 2–3");

    const compacted = await executeContext({ action: "compact", snapshot }, env);

    expect(compacted.isError).toBe(false);
    expect(compacted.output).toContain("forgot in-progress turns 2–3");
    expect(current).toEqual([]);
    expect(conv.messages).toHaveLength(2);
    expect(wasModified()).toBe(true);
  });

  test("stage accepts snapshots after append-only turns", async () => {
    const conv = makeConversation([
      { role: "user", content: "hello", metadata: null },
      { role: "assistant", content: "hi", metadata: null },
    ]);
    const { env, wasModified } = makeEnv(conv);
    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);
    env.currentTurnMessages = [
      makeContextToolUseAssistantMessage("list-call"),
      makeToolResultUserMessage("list output appended after the snapshot", "list-call"),
      makeContextToolUseAssistantMessage("stage-call"),
    ];

    const staged = await executeContext({
      action: "stage",
      snapshot,
      operations: [{ op: "forget", start: 0, end: 0 }],
    }, env);

    expect(staged.isError).toBe(false);
    expect(staged.output).toContain("appended turns since list");
    expect(wasModified()).toBe(false);
    expect(conv.messages).toHaveLength(2);
  });

  test("compact accepts append-only turns after staging", async () => {
    const conv = makeConversation([
      { role: "user", content: "hello", metadata: null },
      { role: "assistant", content: "hi", metadata: null },
    ]);
    conv.lastContextTokens = 2_000;
    const { env, wasModified } = makeEnv(conv);
    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);
    const staged = await executeContext({
      action: "stage",
      snapshot,
      operations: [{ op: "forget", start: 0, end: 0 }],
    }, env);
    expect(staged.isError).toBe(false);
    env.currentTurnMessages = [makeContextToolUseAssistantMessage("compact-call")];

    const compacted = await executeContext({ action: "compact", snapshot }, env);

    expect(compacted.isError).toBe(false);
    expect(compacted.output).toContain("appended turn");
    expect(wasModified()).toBe(true);
    expect(conv.messages).toEqual([{ role: "assistant", content: "hi", metadata: null }]);
  });

  test("compact rejects prefix-changing stale staged plans and clears them", async () => {
    const conv = makeConversation([
      { role: "user", content: "hello", metadata: null },
      { role: "assistant", content: "hi", metadata: null },
    ]);
    const { env, wasModified } = makeEnv(conv);
    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);
    const staged = await executeContext({
      action: "stage",
      snapshot,
      operations: [{ op: "forget", start: 0, end: 0 }],
    }, env);
    expect(staged.isError).toBe(false);
    conv.messages[0].content = "changed before compact";

    const compacted = await executeContext({ action: "compact", snapshot }, env);

    expect(compacted.isError).toBe(true);
    expect(compacted.output).toContain("no longer usable");
    expect(wasModified()).toBe(false);
    expect(conv.messages).toHaveLength(2);

    const secondCompact = await executeContext({ action: "compact" }, env);
    expect(secondCompact.isError).toBe(true);
    expect(secondCompact.output).toContain("No staged context compaction plan");
  });

  test("overlapping staged structural operations are rejected", async () => {
    const conv = makeConversation([
      { role: "user", content: "one " + "x".repeat(3_000), metadata: null },
      { role: "assistant", content: "two " + "y".repeat(3_000), metadata: null },
      { role: "user", content: "three", metadata: null },
    ]);
    conv.lastContextTokens = 6_000;
    const { env } = makeEnv(conv);
    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);

    const staged = await executeContext({
      action: "stage",
      snapshot,
      operations: [
        { op: "summarize", start: 0, end: 1 },
        { op: "forget", start: 1, end: 2 },
      ],
    }, env);

    expect(staged.isError).toBe(true);
    expect(staged.output).toContain("overlap ambiguously");
    const compacted = await executeContext({ action: "compact" }, env);
    expect(compacted.isError).toBe(true);
  });

  test("stage allows strip operations to overlap summarize ranges", async () => {
    const conv = makeConversation([
      { role: "user", content: "summarize me " + "x".repeat(3_000), metadata: null },
      { role: "assistant", content: "assistant content " + "y".repeat(3_000), metadata: null },
      makeToolUseAssistantMessage("tool-1"),
      makeToolResultUserMessage("tool output that is definitely longer than the stripped placeholder", "tool-1"),
    ]);
    conv.lastContextTokens = 8_000;
    const { env } = makeEnv(conv);
    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);

    const staged = await executeContext({
      action: "stage",
      snapshot,
      operations: [
        { op: "summarize", start: 0, end: 3 },
        { op: "strip_results", start: 2, end: 3 },
      ],
    }, env);

    expect(staged.isError).toBe(false);
    expect(staged.output).toContain("Staged 2 context compaction operations");
  });

  test("stage rejects plans that would over-compact below targetTokens", async () => {
    const conv = makeConversation([
      { role: "user", content: "large history " + "x".repeat(10_000), metadata: null },
      { role: "assistant", content: "large assistant " + "y".repeat(10_000), metadata: null },
    ]);
    conv.lastContextTokens = 200_000;
    const { env, wasModified } = makeEnv(conv);
    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);

    const staged = await executeContext({
      action: "stage",
      snapshot,
      targetTokens: 100_000,
      operations: [{ op: "summarize", start: 0, end: 1 }],
    }, env);

    expect(staged.isError).toBe(true);
    expect(staged.output).toContain("over-compact");
    expect(staged.output).toContain("targetTokens 100,000");
    expect(staged.output).toContain("No context was modified and no plan was staged");
    expect(wasModified()).toBe(false);

    const compacted = await executeContext({ action: "compact", snapshot }, env);
    expect(compacted.isError).toBe(true);
    expect(compacted.output).toContain("No staged context compaction plan");
  });

  test("stage can intentionally allow target overshoot", async () => {
    const conv = makeConversation([
      { role: "user", content: "large history " + "x".repeat(10_000), metadata: null },
      { role: "assistant", content: "large assistant " + "y".repeat(10_000), metadata: null },
    ]);
    conv.lastContextTokens = 200_000;
    const { env } = makeEnv(conv);
    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);

    const staged = await executeContext({
      action: "stage",
      snapshot,
      targetTokens: 100_000,
      allowOvershoot: true,
      operations: [{ op: "summarize", start: 0, end: 1 }],
    }, env);

    expect(staged.isError).toBe(false);
    expect(staged.output).toContain("Target: ~100,000 tok");
    expect(staged.output).toContain("allowOvershoot=true");
  });

  test("strip_thinking projection counts removable thinking only, not the whole selected range", async () => {
    const conv = makeConversation([
      { role: "user", content: "large user text " + "x".repeat(10_000), metadata: null },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "small reasoning summary", signature: "sig" },
          { type: "text", text: "large assistant text " + "y".repeat(10_000) },
        ],
        metadata: null,
      },
    ]);
    conv.lastContextTokens = 200_000;
    const { env } = makeEnv(conv);
    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);

    const staged = await executeContext({
      action: "stage",
      snapshot,
      targetTokens: 100_000,
      operations: [{ op: "strip_thinking", start: 0, end: 1 }],
    }, env);

    expect(staged.isError).toBe(false);
    expect(staged.output).toContain("strip_thinking 0–1");
    expect(staged.output).toContain("projected above target");
  });

  test("strip_thinking removes OpenAI provider reasoning replay state", async () => {
    const conv = makeConversation([
      {
        ...makeToolUseAssistantMessage("tool-1"),
        providerData: {
          openai: {
            reasoningItems: [{ id: "rs_1", encryptedContent: "encrypted".repeat(100), summaries: ["summary"] }],
          },
        },
      },
    ]);
    conv.lastContextTokens = 2_000;
    const { env } = makeEnv(conv);
    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);
    const staged = await executeContext({
      action: "stage",
      snapshot,
      operations: [{ op: "strip_thinking", start: 0, end: 0 }],
    }, env);
    expect(staged.isError).toBe(false);

    const compacted = await executeContext({ action: "compact", snapshot }, env);

    expect(compacted.isError).toBe(false);
    expect(conv.messages[0].providerData?.openai?.reasoningItems).toEqual([]);
  });

  test("overlapping strip_results is applied to summarization input before compacting", async () => {
    const conv = makeConversation([
      { role: "user", content: "please summarize", metadata: null },
      makeToolUseAssistantMessage("tool-1"),
      makeToolResultUserMessage("very large raw tool output that should not reach the summarizer", "tool-1"),
      { role: "assistant", content: "assistant conclusion", metadata: null },
    ]);
    conv.lastContextTokens = 8_000;
    let summarizedInput = "";
    const { env } = makeEnv(conv);
    env.summarizeWithInnerLlm = async (_systemPrompt, userText) => {
      summarizedInput = userText;
      return "summary without raw output";
    };
    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);
    const staged = await executeContext({
      action: "stage",
      snapshot,
      operations: [
        { op: "summarize", start: 0, end: 3 },
        { op: "strip_results", start: 2, end: 2 },
      ],
    }, env);
    expect(staged.isError).toBe(false);

    const compacted = await executeContext({ action: "compact", snapshot }, env);

    expect(compacted.isError).toBe(false);
    expect(summarizedInput).toContain("[Output removed by context tool]");
    expect(summarizedInput).not.toContain("very large raw tool output");
    expect(conv.messages).toEqual([
      { role: "user", content: "[Summary of turns 0–3]", metadata: null },
      { role: "assistant", content: "summary without raw output", metadata: null },
    ]);
  });

  test("an invalid restage clears the previous pending plan", async () => {
    const conv = makeConversation([
      { role: "user", content: "hello", metadata: null },
      { role: "assistant", content: "hi", metadata: null },
    ]);
    const { env } = makeEnv(conv);
    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);
    const firstStage = await executeContext({
      action: "stage",
      snapshot,
      operations: [{ op: "forget", start: 0, end: 0 }],
    }, env);
    expect(firstStage.isError).toBe(false);

    const badStage = await executeContext({ action: "stage", snapshot, operations: [] }, env);
    expect(badStage.isError).toBe(true);

    const compacted = await executeContext({ action: "compact", snapshot }, env);
    expect(compacted.isError).toBe(true);
    expect(compacted.output).toContain("No staged context compaction plan");
    expect(conv.messages).toHaveLength(2);
  });

  test("failed summarize leaves strip operations unapplied and clears the plan", async () => {
    const conv = makeConversation([
      { role: "user", content: "summarize me " + "x".repeat(3_000), metadata: null },
      { role: "assistant", content: "assistant content " + "y".repeat(3_000), metadata: null },
      makeToolUseAssistantMessage("tool-1"),
      makeToolResultUserMessage("tool output that is definitely longer than the stripped placeholder", "tool-1"),
    ]);
    conv.lastContextTokens = 8_000;
    const { env } = makeEnv(conv);
    env.summarizeWithInnerLlm = async () => { throw new Error("summary failed"); };

    const snapshot = snapshotFrom((await executeContext({ action: "list" }, env)).output);
    const staged = await executeContext({
      action: "stage",
      snapshot,
      operations: [
        { op: "summarize", start: 0, end: 1 },
        { op: "strip_results", start: 2, end: 3 },
      ],
    }, env);
    expect(staged.isError).toBe(false);

    const compacted = await executeContext({ action: "compact", snapshot }, env);

    expect(compacted.isError).toBe(true);
    expect(compacted.output).toContain("No context was modified");
    expect(compacted.output).toContain("staged plan was cleared");
    expect((conv.messages[3].content as ApiContentBlock[])[0]).toMatchObject({
      content: "tool output that is definitely longer than the stripped placeholder",
    });

    env.summarizeWithInnerLlm = async () => "retry summary";
    const retried = await executeContext({ action: "compact", snapshot }, env);
    expect(retried.isError).toBe(true);
    expect(retried.output).toContain("No staged context compaction plan");
    expect((conv.messages[3].content as ApiContentBlock[])[0]).toMatchObject({
      content: "tool output that is definitely longer than the stripped placeholder",
    });
  });

  test("old live mutation actions are rejected instead of mutating context", async () => {
    const conv = makeConversation([
      makeToolUseAssistantMessage("tool-1"),
      makeToolResultUserMessage("tool output that is definitely longer than the stripped placeholder", "tool-1"),
    ]);
    const { env, wasModified } = makeEnv(conv);

    const result = await executeContext({ action: "strip_results", start: 0, end: 1 }, env);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Valid actions: list, stage, compact");
    expect(wasModified()).toBe(false);
    expect((conv.messages[1].content as ApiContentBlock[])[0]).toMatchObject({
      content: "tool output that is definitely longer than the stripped placeholder",
    });
  });

  test("list includes trailing current context-tool bookkeeping as modifiable turns", async () => {
    const conv = makeConversation([
      { role: "user", content: "persisted prompt", metadata: null },
    ]);
    const current: ApiMessage[] = [
      makeContextToolUseAssistantMessage("old-context"),
      makeToolResultUserMessage("old context list output that should stay visible", "old-context"),
      { role: "assistant", content: "normal continuation after old context burst", metadata: null },
      makeContextToolUseAssistantMessage("new-context"),
      makeToolResultUserMessage("new context mini-map output that should be hidden", "new-context"),
    ];
    const { env } = makeEnv(conv);
    env.currentTurnMessages = current;

    const result = await executeContext({ action: "list" }, env);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("stage summarize/forget/strip_thinking/strip_results: 0, 1–5");
    expect(result.output).toContain("5 result:context");
    expect(result.output).toContain("2 result:context");
    expect(result.output).toContain("new context mini-map output");
  });

  test("current-turn protection applies to trailing visible turns", async () => {
    const conv = makeConversation([
      { role: "user", content: "persisted prompt", metadata: null },
    ]);
    const current: ApiMessage[] = [
      makeToolUseAssistantMessage("current-tool"),
      makeToolResultUserMessage("current output that should remain visible and modifiable", "current-tool"),
      makeContextToolUseAssistantMessage("context-current"),
      makeToolResultUserMessage("current context output that should be hidden", "context-current"),
    ];
    const { env } = makeEnv(conv);
    env.currentTurnMessages = current;
    env.protectedCurrentTurnTailCount = 2;

    const result = await executeContext({ action: "list" }, env);

    expect(result.isError).toBe(false);
    expect(result.output).toContain("stage summarize/forget/strip_thinking/strip_results: 0, 1–2");
    expect(result.output).toContain("protected/unmodifiable: 3–4");
    expect(result.output).toContain("2 result:bash");
    expect(result.output).not.toContain("3: assistant");
    expect(result.output).not.toContain("4: tool_result");
  });
});
