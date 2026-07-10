import { afterEach, describe, expect, test } from "bun:test";
import {
  getConversationActivityCounts,
  resetConversationActivityForTest,
  setBackgroundTaskActive,
  setSubagentActive,
} from "./conversation-activity";
import { create, getSummary, remove } from "./conversations";

const ids: string[] = [];

afterEach(() => {
  resetConversationActivityForTest();
  for (const id of ids.splice(0)) remove(id);
});

describe("focused conversation activity counts", () => {
  test("deduplicates active subagents and background tasks", () => {
    expect(setSubagentActive("parent", "child-1", true)).toBe(true);
    expect(setSubagentActive("parent", "child-1", true)).toBe(false);
    expect(setSubagentActive("parent", "child-2", true)).toBe(true);
    expect(setBackgroundTaskActive("parent", "bash:1", true)).toBe(true);
    expect(setBackgroundTaskActive("parent", "bash:1", true)).toBe(false);

    expect(getConversationActivityCounts("parent")).toEqual({
      subagentCount: 2,
      backgroundTaskCount: 1,
    });

    expect(setSubagentActive("parent", "child-1", false)).toBe(true);
    expect(setBackgroundTaskActive("parent", "bash:1", false)).toBe(true);
    expect(getConversationActivityCounts("parent")).toEqual({
      subagentCount: 1,
      backgroundTaskCount: 0,
    });
  });

  test("projects ephemeral counts onto conversation summaries", () => {
    const id = `activity-summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    create(id, "openai", "gpt-5.4", "activity");
    setSubagentActive(id, "child", true);
    setBackgroundTaskActive(id, "bash:42", true);

    expect(getSummary(id)).toMatchObject({
      subagentCount: 1,
      backgroundTaskCount: 1,
    });
  });
});
