import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  getActiveSubagentCount,
  getConversationActivityCounts,
  getConversationTasks,
  getSubagentConversationIds,
  listActiveConversationTasks,
  resetConversationActivityForTest,
  setBackgroundTaskActive,
  setChronoTaskActive,
  setSubagentActive,
  stopBackgroundTask,
  waitForConversationTask,
} from "./conversation-activity";
import { create, createFolder, deleteFolder, getSummary, moveConversationToFolder, remove, setActiveJob } from "./conversations";

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

  test("publishes Chrono timing details and wakes event-driven task waiters", async () => {
    setChronoTaskActive("parent", "chrono:wake:1", true, {
      title: "Daily inbox check",
      startedAt: 100,
      dueAt: 5_000,
      chronoMode: "wake",
    });
    setBackgroundTaskActive("parent", "bash:waited", true, { title: "bun test", startedAt: 200 });

    expect(getConversationTasks("parent")).toContainEqual({
      id: "chrono:wake:1",
      kind: "chrono",
      title: "Daily inbox check",
      startedAt: 100,
      dueAt: 5_000,
      chronoMode: "wake",
    });

    const waiting = waitForConversationTask("bash:waited");
    setBackgroundTaskActive("parent", "bash:waited", false);
    await expect(waiting).resolves.toMatchObject({ id: "bash:waited", kind: "background" });
    await expect(waitForConversationTask("missing")).rejects.toThrow("Active task not found");
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

  test("keeps rich process metadata private from summaries and stops exact task ids", () => {
    const stop = mock(() => true);
    setBackgroundTaskActive("parent", "bash:42:nonce", true, {
      title: "bun test daemon",
      startedAt: 200,
      toolName: "bash",
      pid: 42,
      backgroundedAt: 250,
      outputPath: "/tmp/bash-42.tmp",
      cwd: "/workspace",
      stop,
    });

    expect(getConversationTasks("parent")).toEqual([
      { id: "bash:42:nonce", kind: "background", title: "bun test daemon", startedAt: 200 },
    ]);
    expect(listActiveConversationTasks("parent")).toEqual([
      {
        id: "bash:42:nonce",
        kind: "background",
        ownerConversationId: "parent",
        status: "running",
        title: "bun test daemon",
        startedAt: 200,
        toolName: "bash",
        pid: 42,
        backgroundedAt: 250,
        outputPath: "/tmp/bash-42.tmp",
        cwd: "/workspace",
      },
    ]);

    expect(stopBackgroundTask("bash:42:nonce", true).result).toBe("stopping");
    expect(stop).toHaveBeenCalledWith(true);
    expect(listActiveConversationTasks("parent")[0].status).toBe("stopping");
    expect(stopBackgroundTask("bash:42:nonce", true).result).toBe("already-stopping");
  });

  test("keeps failed stop attempts retryable", () => {
    const stop = mock(() => false);
    setBackgroundTaskActive("parent", "bash:43:retry", true, {
      title: "sleep 30",
      startedAt: 200,
      toolName: "bash",
      pid: 43,
      backgroundedAt: 250,
      stop,
    });

    expect(stopBackgroundTask("bash:43:retry", false).result).toBe("failed");
    expect(listActiveConversationTasks("parent")[0].status).toBe("running");
    expect(stopBackgroundTask("bash:43:retry", false).result).toBe("failed");
    expect(stop).toHaveBeenCalledTimes(2);
  });

  test("aborts foreground turns and stops managed tasks when their conversation is deleted", () => {
    const id = `activity-delete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    create(id, "openai", "gpt-5.4", "activity");
    const controller = new AbortController();
    setActiveJob(id, controller, Date.now());
    const stop = mock(() => true);
    setBackgroundTaskActive(id, "bash:44:delete", true, {
      title: "sleep 30",
      startedAt: 200,
      toolName: "bash",
      pid: 44,
      backgroundedAt: 250,
      stop,
    });

    expect(remove(id)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(stop).toHaveBeenCalledWith(true);
  });

  test("stops managed tasks during recursive folder deletion", () => {
    const id = `activity-folder-delete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ids.push(id);
    create(id, "openai", "gpt-5.4", "activity");
    const folder = createFolder("activity-folder", null, []);
    expect(folder).not.toBeNull();
    expect(moveConversationToFolder(id, folder!.id)).toBe(true);
    const stop = mock(() => true);
    setBackgroundTaskActive(id, "bash:45:folder", true, {
      title: "sleep 30",
      startedAt: 200,
      toolName: "bash",
      pid: 45,
      backgroundedAt: 250,
      stop,
    });

    expect(deleteFolder(folder!.id, "recursive")).toBe(true);
    expect(stop).toHaveBeenCalledWith(true);
  });
});
