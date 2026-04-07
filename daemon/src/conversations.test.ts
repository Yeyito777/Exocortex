/**
 * Tests for conversations.ts behavior.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { create, get, getDisplayData, getSummary, remove, setSystemInstructions } from "./conversations";
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
});
