import { afterEach, describe, expect, test } from "bun:test";
import {
  getActiveSubagentCount,
  getConversationActivityCounts,
  getConversationTasks,
  getSubagentConversationIds,
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

describe("focused conversation activity", () => {
  test("deduplicates active tasks while retaining their UI details", () => {
    expect(setSubagentActive("parent", "child-1", true, { title: "Inspect renderer flow", startedAt: 100 })).toBe(true);
    expect(setSubagentActive("parent", "child-1", true, { title: "Inspect renderer flow", startedAt: 100 })).toBe(false);
    expect(setSubagentActive("parent", "child-2", true, { title: "Review daemon events", startedAt: 200 })).toBe(true);
    expect(setBackgroundTaskActive("parent", "bash:1", true, { title: "bun test tui", startedAt: 300 })).toBe(true);
    expect(setBackgroundTaskActive("parent", "bash:1", true, { title: "bun test tui", startedAt: 300 })).toBe(false);

    expect(getConversationActivityCounts("parent")).toEqual({
      subagentCount: 2,
      backgroundTaskCount: 1,
    });
    expect(getActiveSubagentCount()).toBe(2);
    expect(getConversationTasks("parent")).toEqual([
      { id: "child-1", kind: "subagent", title: "Inspect renderer flow", startedAt: 100 },
      { id: "child-2", kind: "subagent", title: "Review daemon events", startedAt: 200 },
      { id: "bash:1", kind: "background", title: "bun test tui", startedAt: 300 },
    ]);

    expect(setSubagentActive("parent", "child-1", false)).toBe(true);
    expect(setBackgroundTaskActive("parent", "bash:1", false)).toBe(true);
    expect(getConversationActivityCounts("parent")).toEqual({
      subagentCount: 1,
      backgroundTaskCount: 0,
    });
    expect(getActiveSubagentCount()).toBe(1);
  });

  test("retains the latest parent-child relationship after activity finishes", () => {
    setSubagentActive("parent-a", "child", true);
    setSubagentActive("parent-a", "child", false);
    expect(getSubagentConversationIds("parent-a")).toEqual(["child"]);

    setSubagentActive("parent-b", "child", true);
    expect(getSubagentConversationIds("parent-a")).toEqual([]);
    expect(getSubagentConversationIds("parent-b")).toEqual(["child"]);
  });

  test("projects ephemeral counts and task details onto conversation summaries", () => {
    const id = `activity-summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    create(id, "openai", "gpt-5.4", "activity");
    setSubagentActive(id, "child", true, { title: "Map daemon events", startedAt: 100 });
    setBackgroundTaskActive(id, "bash:42", true, { title: "bun test daemon", startedAt: 200 });

    expect(getSummary(id)).toMatchObject({
      subagentCount: 1,
      backgroundTaskCount: 1,
      tasks: [
        { id: "child", kind: "subagent", title: "Map daemon events", startedAt: 100 },
        { id: "bash:42", kind: "background", title: "bun test daemon", startedAt: 200 },
      ],
    });
  });
});
