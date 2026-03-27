/**
 * Tests for conversations.ts focused on system instructions behavior.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { create, get, getSummary, remove, setSystemInstructions } from "./conversations";

const IDS: string[] = [];

function mkId(suffix: string): string {
  const id = `test-conv-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  IDS.push(id);
  return id;
}

beforeEach(() => {
  for (const id of IDS.splice(0)) {
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
