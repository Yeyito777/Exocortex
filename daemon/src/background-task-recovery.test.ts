import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { BackgroundTaskRecovery } from "./background-task-recovery";
import {
  backgroundTaskRecordPath,
  readProcessStartTime,
  writeBackgroundTaskRecord,
  type PersistedBackgroundTask,
} from "./background-task-state";
import { listActiveConversationTasks, resetConversationActivityForTest, stopBackgroundTask } from "./conversation-activity";
import type { BackgroundTaskCompletion } from "./tools/types";

afterEach(() => resetConversationActivityForTest());

describe("background task restart recovery", () => {
  test("adopts running tasks before delivering deferred completion", async () => {
    if (process.platform !== "linux") return;
    const directory = mkdtempSync(join(tmpdir(), `exocortex-background-recovery-${process.pid}-`));
    const command = spawn("bash", ["-c", "sleep 30"], {
      detached: true,
      stdio: "ignore",
    });
    expect(command.pid).toBeGreaterThan(0);
    const taskId = `bash:${command.pid}:recovered`;
    const recordPath = backgroundTaskRecordPath(taskId, directory);
    const record: PersistedBackgroundTask = {
      version: 1,
      state: "running",
      taskId,
      ownerConversationId: "recovery-owner",
      toolName: "bash",
      title: "sleep 30",
      startedAt: 100,
      backgroundedAt: 200,
      originDaemonPid: process.pid + 1,
      runnerPid: process.pid,
      runnerStartTime: readProcessStartTime(process.pid),
      pid: command.pid!,
      processStartTime: readProcessStartTime(command.pid!),
      outputPath: join(directory, "output"),
      cwd: directory,
    };
    writeBackgroundTaskRecord(recordPath, record);
    const changed: string[] = [];
    const completions: BackgroundTaskCompletion[] = [];
    const recovery = new BackgroundTaskRecovery({
      onConversationChanged: convId => changed.push(convId),
      onComplete: (_convId, completion) => completions.push(completion),
    }, {
      directory,
      daemonPid: process.pid,
      pollMs: 60_000,
      hasConversation: () => true,
    });

    try {
      expect(recovery.start()).toBe(1);
      expect(listActiveConversationTasks("recovery-owner")).toMatchObject([{
        id: taskId,
        kind: "background",
        status: "running",
        pid: command.pid,
      }]);
      expect(changed).toEqual(["recovery-owner"]);

      expect(stopBackgroundTask(taskId, false).result).toBe("stopping");
      await new Promise(resolve => command.once("close", resolve));
      writeBackgroundTaskRecord(recordPath, {
        ...record,
        state: "completed",
        completion: {
          endedAt: 300,
          exitCode: 0,
          signal: null,
          byteTruncated: false,
        },
      });
      recovery.scan();

      expect(listActiveConversationTasks("recovery-owner")).toEqual([]);
      expect(completions).toEqual([]);
      expect(changed).toEqual(["recovery-owner", "recovery-owner"]);

      recovery.enableCompletionDelivery();
      expect(completions).toMatchObject([{
        taskId,
        title: "sleep 30",
        startedAt: 100,
        endedAt: 300,
        exitCode: 0,
        signal: null,
      }]);
    } finally {
      recovery.stop();
      try { process.kill(-command.pid!, "SIGKILL"); } catch { /* already exited */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("consumes a completed record without duplicating an already-durable notification", () => {
    const directory = mkdtempSync(join(tmpdir(), `exocortex-background-dedup-${process.pid}-`));
    const taskId = "bash:123:already-delivered";
    const recordPath = backgroundTaskRecordPath(taskId, directory);
    writeBackgroundTaskRecord(recordPath, {
      version: 1,
      state: "completed",
      taskId,
      ownerConversationId: "dedup-owner",
      toolName: "bash",
      title: "true",
      startedAt: 100,
      backgroundedAt: 110,
      originDaemonPid: process.pid + 1,
      runnerPid: process.pid,
      pid: process.pid,
      outputPath: join(directory, "output"),
      cwd: directory,
      completion: {
        endedAt: 120,
        exitCode: 0,
        signal: null,
        byteTruncated: false,
      },
    });
    const completions: BackgroundTaskCompletion[] = [];
    const recovery = new BackgroundTaskRecovery({
      onConversationChanged: () => {},
      onComplete: (_convId, completion) => completions.push(completion),
    }, {
      directory,
      daemonPid: process.pid,
      pollMs: 60_000,
      hasConversation: () => true,
      hasDeliveredCompletion: () => true,
    });

    try {
      expect(recovery.start()).toBe(0);
      recovery.enableCompletionDelivery();
      expect(completions).toEqual([]);
      expect(existsSync(recordPath)).toBe(false);
    } finally {
      recovery.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
