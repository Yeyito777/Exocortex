import { describe, expect, test } from "bun:test";
import { buildBackgroundTaskNotificationText } from "./background-task-notifications";

describe("background task notifications", () => {
  test("describes a successful command and its output file", () => {
    const text = buildBackgroundTaskNotificationText({
      taskId: "bash:123",
      toolName: "bash",
      title: "bun test tui",
      startedAt: 1_000,
      endedAt: 3_500,
      exitCode: 0,
      signal: null,
      outputPath: "/tmp/exocortex-bash-123.tmp",
    });

    expect(text).toContain("[notification] Background task completed: bash:123");
    expect(text).toContain("Command: bun test tui");
    expect(text).toContain("Status: exited successfully");
    expect(text).toContain("Duration: 2.5s");
    expect(text).toContain("Output: /tmp/exocortex-bash-123.tmp");
    expect(text).toContain("Use the read tool");
  });

  test("reports non-zero exits as failures", () => {
    const text = buildBackgroundTaskNotificationText({
      taskId: "bash:456",
      toolName: "bash",
      title: "false",
      startedAt: 0,
      endedAt: 25,
      exitCode: 1,
      signal: null,
      outputError: "disk full",
    });

    expect(text).toContain("[notification] Background task failed: bash:456");
    expect(text).toContain("Status: exited with code 1");
    expect(text).toContain("Output: unavailable (disk full)");
  });
});
