/**
 * Tests for conversations.ts behavior.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { create, get, getDisplayData, getSummary, getToolOutputs, listRunningConversationIds, remove, setModel, setSystemInstructions, trimConversation } from "./conversations";
import { setActiveJob, replaceStreamingDisplayMessages, clearActiveJob } from "./streaming";

const IDS: string[] = [];

function mkId(suffix: string): string {
  const id = `test-conv-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  return id;
}

beforeEach(() => {
  for (const id of IDS.splice(0)) {
    clearActiveJob(id);
    remove(id);
  }
});

describe("setModel", () => {
  test("switches provider/model atomically, clears stale context, and bumps updatedAt", async () => {
    const id = mkId("switch-provider");
    const conv = create(id, "openai", "gpt-5.4", undefined, "low", true);
    conv.lastContextTokens = 123_456;
    const before = conv.updatedAt;

    await Bun.sleep(2);
    expect(setModel(id, "anthropic", "claude-opus-4-6", "high", false)).toBe(true);

    const after = get(id)!;
    expect(after.provider).toBe("anthropic");
    expect(after.model).toBe("claude-opus-4-6");
    expect(after.effort).toBe("high");
    expect(after.fastMode).toBe(false);
    expect(after.lastContextTokens).toBeNull();
    expect(after.updatedAt).toBeGreaterThan(before);
  });
});

describe("trimConversation", () => {
  test("trims oldest history entries and clears stale context", () => {
    const id = mkId("trim-messages");
    const conv = create(id, "openai", "gpt-5.4");
    conv.lastContextTokens = 9_999;
    expect(setSystemInstructions(id, "Be terse.")).toBe(true);
    conv.messages.push({ role: "user", content: "first", metadata: null });
    conv.messages.push({ role: "assistant", content: "reply one", metadata: null });
    conv.messages.push({ role: "user", content: "second", metadata: null });

    const result = trimConversation(id, "messages", 2);

    expect(result).not.toBeNull();
    expect(result?.changed).toBe(true);
    expect(result?.message).toContain("Trimmed 2 oldest history entries");
    expect(get(id)?.messages).toEqual([
      { role: "system_instructions", content: "Be terse.", metadata: null },
      { role: "user", content: "second", metadata: null },
    ]);
    expect(get(id)?.lastContextTokens).toBeNull();
  });

  test("expands message trimming to preserve assistant tool_use and user tool_result pairs", () => {
    const id = mkId("trim-messages-tool-pair");
    create(id, "anthropic", "claude-opus-4-6");
    const conv = get(id)!;
    conv.messages.push({ role: "user", content: "before tool", metadata: null });
    conv.messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: "tool-1", name: "bash", input: { command: "echo hi" } }],
      metadata: null,
    });
    conv.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "hi" }],
      metadata: null,
    });
    conv.messages.push({ role: "assistant", content: "after tool", metadata: null });

    const result = trimConversation(id, "messages", 2);

    expect(result).not.toBeNull();
    expect(result?.changed).toBe(true);
    expect(result?.message).toContain("expanded from 2 to 3 to preserve a tool_use/tool_result pair");
    expect(get(id)?.messages).toEqual([
      { role: "assistant", content: "after tool", metadata: null },
    ]);
  });

  test("strips thinking from the oldest assistant turns first", () => {
    const id = mkId("trim-thinking");
    create(id, "openai", "gpt-5.4");
    const conv = get(id)!;
    conv.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "secret", signature: "sig" }, { type: "text", text: "visible" }], metadata: null });
    conv.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "later", signature: "sig2" }, { type: "text", text: "second" }], metadata: null });

    const result = trimConversation(id, "thinking", 1);

    expect(result).not.toBeNull();
    expect(result?.changed).toBe(true);
    expect(result?.message).toContain("Trimmed thinking from 1 assistant turn");
    expect(get(id)?.messages[0]?.content).toEqual([{ type: "text", text: "visible" }]);
    expect(Array.isArray(get(id)?.messages[1]?.content)).toBe(true);
    expect((get(id)?.messages[1]?.content as Array<{ type: string }>).some((block) => block.type === "thinking")).toBe(true);
  });

  test("strips oldest tool result payloads first", () => {
    const id = mkId("trim-toolresults");
    create(id, "anthropic", "claude-opus-4-6");
    const conv = get(id)!;
    conv.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "very long output that should definitely be longer than the trim placeholder" }],
      metadata: null,
    });
    conv.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-2", content: "second output" }],
      metadata: null,
    });

    const result = trimConversation(id, "toolresults", 1);

    expect(result).not.toBeNull();
    expect(result?.changed).toBe(true);
    expect(result?.message).toContain("Trimmed 1 tool result");
    expect(get(id)?.messages[0]?.content).toEqual([{ type: "tool_result", tool_use_id: "tool-1", content: "[Output removed by /trim]" }]);
    expect(get(id)?.messages[1]?.content).toEqual([{ type: "tool_result", tool_use_id: "tool-2", content: "second output" }]);
  });
});

describe("setSystemInstructions", () => {
  test("bumps updatedAt when instructions are added", async () => {
    const id = mkId("add");
    const conv = create(id, "anthropic", "sonnet");
    const before = conv.updatedAt;

    await Bun.sleep(2);
    expect(setSystemInstructions(id, "Be terse.")).toBe(true);

    const after = get(id)!;
    expect(after.messages[0]).toEqual({ role: "system_instructions", content: "Be terse.", metadata: null });
    expect(after.updatedAt).toBeGreaterThan(before);
  });

  test("bumps updatedAt when instructions are changed or cleared, but not on no-op", async () => {
    const id = mkId("change-clear");
    create(id, "anthropic", "sonnet");

    expect(setSystemInstructions(id, "Be terse.")).toBe(true);
    const afterSet = get(id)!;
    const firstUpdatedAt = afterSet.updatedAt;

    expect(setSystemInstructions(id, "Be terse.")).toBe(true);
    const afterNoOp = get(id)!;
    expect(afterNoOp.updatedAt).toBe(firstUpdatedAt);

    await Bun.sleep(2);
    expect(setSystemInstructions(id, "Be thorough.")).toBe(true);
    const afterChange = get(id)!;
    expect(afterChange.updatedAt).toBeGreaterThan(firstUpdatedAt);
    const secondUpdatedAt = afterChange.updatedAt;

    await Bun.sleep(2);
    expect(setSystemInstructions(id, "")).toBe(true);
    const afterClear = get(id)!;
    expect(afterClear.messages.find((m) => m.role === "system_instructions")).toBeUndefined();
    expect(afterClear.updatedAt).toBeGreaterThan(secondUpdatedAt);
  });
});

describe("getSummary", () => {
  test("messageCount excludes system_instructions", () => {
    const id = mkId("summary-count");
    create(id, "anthropic", "sonnet");
    expect(setSystemInstructions(id, "Be terse.")).toBe(true);

    const conv = get(id)!;
    conv.messages.push({ role: "user", content: "hello", metadata: null });
    conv.messages.push({ role: "assistant", content: "hi", metadata: null });

    const summary = getSummary(id)!;
    expect(summary.messageCount).toBe(2);
  });
});

describe("listRunningConversationIds", () => {
  test("returns only conversations with active streams", () => {
    const running = mkId("running");
    const idle = mkId("idle");
    create(running, "anthropic", "sonnet");
    create(idle, "anthropic", "sonnet");

    setActiveJob(running, new AbortController(), Date.now());

    expect(listRunningConversationIds()).toEqual([running]);
  });
});

describe("getDisplayData", () => {
  test("includes transient streaming messages for active conversations", () => {
    const id = mkId("display-transient");
    create(id, "anthropic", "sonnet");

    const conv = get(id)!;
    conv.messages.push({ role: "user", content: "initial", metadata: null });

    setActiveJob(id, new AbortController(), Date.now());
    replaceStreamingDisplayMessages(id, [
      { role: "assistant", content: "First tool round done", metadata: null },
      { role: "user", content: "queued next turn", metadata: null },
    ]);

    const data = getDisplayData(id)!;
    expect(data.entries).toHaveLength(3);
    expect(data.entries[0]).toEqual({ type: "user", text: "initial" });
    expect(data.entries[1].type).toBe("ai");
    if (data.entries[1].type !== "ai") throw new Error("expected ai entry");
    expect(data.entries[1].blocks).toEqual([{ type: "text", text: "First tool round done" }]);
    expect(data.entries[2]).toEqual({ type: "user", text: "queued next turn" });
  });

  test("can omit historical tool_result payloads while still exposing patch data", () => {
    const id = mkId("display-tool-outputs");
    create(id, "anthropic", "sonnet");
    const conv = get(id)!;
    conv.messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "read", input: { file_path: "/tmp/x" } }],
      metadata: null,
    });
    conv.messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: "tool output" }],
      metadata: null,
    });

    const compact = getDisplayData(id, false)!;
    expect(compact.toolOutputsIncluded).toBe(false);
    expect(compact.entries[0].type).toBe("ai");
    if (compact.entries[0].type !== "ai") throw new Error("expected ai entry");
    expect(compact.entries[0].blocks[1]).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "",
      output: "",
      isError: false,
    });
    expect(getToolOutputs(id)).toEqual([{ toolCallId: "call-1", output: "tool output" }]);
  });
});
