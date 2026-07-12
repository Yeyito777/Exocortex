import { afterEach, describe, expect, mock, test } from "bun:test";
import { chrono, chronoToolInternalsForTest } from "./chrono";
import { chronoInternalsForTest, installMigratedSchedule } from "../chrono-service";
import { resetConversationActivityForTest, setBackgroundTaskActive } from "../conversation-activity";

afterEach(() => {
  chronoInternalsForTest.reset();
  resetConversationActivityForTest();
});

describe("Chrono tool", () => {
  test("parses compact sleep durations", () => {
    expect(chronoToolInternalsForTest.parseDurationMs("250ms")).toBe(250);
    expect(chronoToolInternalsForTest.parseDurationMs("1.5m")).toBe(90_000);
    expect(chronoToolInternalsForTest.parseDurationMs("2h")).toBe(7_200_000);
    expect(chronoToolInternalsForTest.parseDurationMs("later")).toBeNull();
  });

  test("wait requires an explicit maximum duration", async () => {
    const result = await chrono.execute(
      { action: "wait", task_id: "bash:42" },
      { conversationId: "parent" },
    );
    expect(result).toEqual(expect.objectContaining({ isError: true }));
    expect(result.output).toContain("requires max_wait");
  });

  test("wait resolves on task completion and reports its own Tasks UI lifecycle", async () => {
    setBackgroundTaskActive("parent", "bash:42", true, { title: "test job", startedAt: 1 });
    const activity = mock(() => {});
    const resultPromise = chrono.execute(
      { action: "wait", task_id: "bash:42", max_wait: "5m" },
      { conversationId: "parent", toolCallId: "call-1", setChronoTaskActive: activity },
    );
    setBackgroundTaskActive("parent", "bash:42", false);
    await expect(resultPromise).resolves.toEqual(expect.objectContaining({ isError: false }));
    expect(activity).toHaveBeenNthCalledWith(1, "chrono:wait:call-1", true, expect.objectContaining({
      title: "Waiting up to 5m for bash:42",
      chronoMode: "wait",
      dueAt: expect.any(Number),
    }));
    expect(activity).toHaveBeenLastCalledWith("chrono:wait:call-1", false);
  });

  test("wait returns when its maximum duration is reached and clears its Tasks UI row", async () => {
    setBackgroundTaskActive("parent", "bash:slow", true, { title: "slow job", startedAt: 1 });
    const activity = mock(() => {});
    const result = await chrono.execute(
      { action: "wait", task_id: "bash:slow", max_wait: "5ms" },
      { conversationId: "parent", toolCallId: "call-limit", setChronoTaskActive: activity },
    );
    expect(result).toEqual(expect.objectContaining({ isError: false }));
    expect(result.output).toContain("Wait limit reached after 5ms");
    expect(activity).toHaveBeenLastCalledWith("chrono:wait:call-limit", false);
  });

  test("sleep is abortable and always clears its Tasks UI row", async () => {
    const activity = mock(() => {});
    const controller = new AbortController();
    const result = chrono.execute(
      { action: "sleep", duration: "5m" },
      { conversationId: "parent", toolCallId: "call-2", setChronoTaskActive: activity },
      controller.signal,
    );
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(activity).toHaveBeenLastCalledWith("chrono:sleep:call-2", false);
  });

  test("creates and lists a durable hard wake", async () => {
    const created = await chrono.execute({
      action: "wake",
      after_seconds: 60,
      title: "Check inbox",
      message: "Check my inbox.",
    }, { conversationId: "parent" });
    expect(created.isError).toBe(false);
    expect(created.output).toContain("Scheduled hard wake");

    const listed = await chrono.execute({ action: "list" }, { conversationId: "parent" });
    expect(listed.output).toContain("Check inbox");
  });

  test("adopts an ownerless daemon command schedule", async () => {
    installMigratedSchedule({
      id: "chrono:migrated:tool-adopt",
      title: "Recorder monitor",
      createdAt: Date.now(),
      nextAt: Date.now() + 60_000,
      target: { kind: "command", command: "exit 1", timeoutMs: 30_000 },
      source: "legacy-cron",
    });
    const adopted = await chrono.execute({
      action: "adopt",
      schedule_id: "chrono:migrated:tool-adopt",
      hard_wake: { message: "Investigate PMV4." },
    }, { conversationId: "pmv4-owner" });
    expect(adopted).toEqual(expect.objectContaining({ isError: false }));
    expect(adopted.output).toContain("soft wake → hard wake");

    const listed = await chrono.execute({ action: "list" }, { conversationId: "pmv4-owner" });
    expect(listed.output).toContain("Recorder monitor");
  });
});
