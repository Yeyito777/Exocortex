import { afterEach, describe, expect, mock, test } from "bun:test";
import { chrono, chronoToolInternalsForTest } from "./chrono";
import { chronoInternalsForTest } from "../chrono-service";
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

  test("wait resolves on task completion and reports its own Tasks UI lifecycle", async () => {
    setBackgroundTaskActive("parent", "bash:42", true, { title: "test job", startedAt: 1 });
    const activity = mock(() => {});
    const resultPromise = chrono.execute(
      { action: "wait", task_id: "bash:42" },
      { conversationId: "parent", toolCallId: "call-1", setChronoTaskActive: activity },
    );
    setBackgroundTaskActive("parent", "bash:42", false);
    await expect(resultPromise).resolves.toEqual(expect.objectContaining({ isError: false }));
    expect(activity).toHaveBeenNthCalledWith(1, "chrono:wait:call-1", true, expect.objectContaining({ chronoMode: "wait" }));
    expect(activity).toHaveBeenLastCalledWith("chrono:wait:call-1", false);
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
});
