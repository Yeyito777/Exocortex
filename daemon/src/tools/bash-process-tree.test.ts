import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { bash, executeBashBackgroundable } from "./bash";
import { backgroundTaskRecordPath, readBackgroundTaskRecord } from "../background-task-state";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("bash process-tree timeout", () => {
  test("treats unexpected command signals as failures", async () => {
    if (process.platform === "win32") return;
    const result = await executeBashBackgroundable({ command: "kill -TERM $$", timeout_seconds: 2 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("terminated by signal SIGTERM");
  });

  test("managed runner kills its command tree when the owning daemon channel closes", async () => {
    if (process.platform === "win32") return;
    const markerPath = join(tmpdir(), `exocortex-managed-runner-${process.pid}-${Date.now()}`);
    const outputPath = join(tmpdir(), `exocortex-managed-runner-output-${process.pid}-${Date.now()}`);
    const runnerPath = join(import.meta.dir, "bash-runner.ts");
    const runner = spawn(process.execPath, [runnerPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let channelClosed = false;
    const closed = new Promise<void>((resolve, reject) => {
      runner.on("error", reject);
      runner.on("close", () => resolve());
      runner.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (channelClosed || !stdout.includes('"type":"started"')) return;
        channelClosed = true;
        runner.stdin.end();
      });
    });
    runner.stdin.write(JSON.stringify({
      type: "start",
      command: `sleep 0.8; touch '${markerPath}'`,
      outputPath,
      windows: false,
      terminateOnParentExit: true,
      timeoutMs: 5_000,
    }) + "\n");

    await closed;
    await Bun.sleep(1_000);
    expect(existsSync(markerPath)).toBe(false);
    rmSync(markerPath, { force: true });
    rmSync(outputPath, { force: true });
  });

  test("officially backgrounded runner survives loss of its original daemon channel", async () => {
    if (process.platform === "win32") return;
    const directory = mkdtempSync(join(tmpdir(), `exocortex-recoverable-runner-${process.pid}-`));
    const markerPath = join(directory, "completed");
    const outputPath = join(directory, "output");
    const taskId = `bash:recoverable:${Date.now()}`;
    const recordPath = backgroundTaskRecordPath(taskId, directory);
    const runnerPath = join(import.meta.dir, "bash-runner.ts");
    const runner = spawn(process.execPath, [runnerPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let commandPid = 0;
    let backgroundRequested = false;
    let backgroundAcknowledged = false;
    const closed = new Promise<void>((resolve, reject) => {
      runner.on("error", reject);
      runner.on("close", () => resolve());
      runner.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          let event: { type?: string; pid?: number };
          try { event = JSON.parse(line) as { type?: string; pid?: number }; }
          catch { continue; }
          if (event.type === "started" && event.pid && !backgroundRequested) {
            commandPid = event.pid;
            backgroundRequested = true;
            runner.stdin.write(JSON.stringify({
              type: "background",
              recovery: {
                recordPath,
                taskId,
                ownerConversationId: "recoverable-owner",
                title: "recoverable command",
                startedAt: Date.now(),
                backgroundedAt: Date.now(),
                originDaemonPid: process.pid,
                outputPath,
                cwd: directory,
              },
            }) + "\n");
          }
          if (event.type === "backgrounded" && !backgroundAcknowledged) {
            backgroundAcknowledged = true;
            // This is the exact channel loss caused by the old daemon exiting.
            runner.stdin.end();
          }
        }
      });
    });
    runner.stdin.write(JSON.stringify({
      type: "start",
      command: `sleep 0.15; touch '${markerPath}'`,
      outputPath,
      windows: false,
      terminateOnParentExit: true,
      timeoutMs: 5_000,
      cwd: directory,
      env: process.env,
    }) + "\n");

    await closed;
    expect(commandPid).toBeGreaterThan(0);
    expect(backgroundAcknowledged).toBe(true);
    expect(existsSync(markerPath)).toBe(true);
    expect(readBackgroundTaskRecord(recordPath)).toMatchObject({
      state: "completed",
      taskId,
      pid: commandPid,
      completion: { exitCode: 0, signal: null },
    });
    rmSync(directory, { recursive: true, force: true });
  });

  test("times out and kills descendants in the isolated command process group", async () => {
    if (process.platform === "win32") return;
    const result = await executeBashBackgroundable({
      command: "(trap '' TERM; sleep 30) & child=$!; echo $child; wait",
      // Long enough for the shell to start and print the child's pid under load.
      timeout_seconds: 0.5,
      await: 10,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("command timed out");
    const descendantPid = Number(result.output.match(/\n(\d+)\n/)?.[1]);
    expect(descendantPid).toBeGreaterThan(0);
    // SIGKILL reaches the group as output closes; give the kernel a moment to
    // reap it (the descendant itself would sleep for 30 s).
    for (let i = 0; i < 100 && isAlive(descendantPid); i++) await Bun.sleep(10);
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  test("rejects a non-positive timeout before spawning", async () => {
    const result = await executeBashBackgroundable({ command: "echo should-not-run", timeout_seconds: 0 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("greater than 0 seconds");
  });

  test("exposes only the new timeout_seconds parameter", async () => {
    const properties = bash.inputSchema.properties as Record<string, unknown>;
    expect(properties.timeout_seconds).toBeDefined();
    expect(properties.timeout).toBeUndefined();

    const result = await executeBashBackgroundable({ command: "echo should-not-run", timeout: 1_000 });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("use 'timeout_seconds' instead");
  });

  test("does not orphan commands when timeout wins the runner startup race", async () => {
    if (process.platform === "win32") return;
    const markerPath = join(tmpdir(), `exocortex-bash-timeout-race-${process.pid}-${Date.now()}`);
    const calls = Array.from({ length: 20 }, () => executeBashBackgroundable({
      command: `(sleep 0.15; echo leaked >> '${markerPath}') & wait`,
      timeout_seconds: 0.001,
      await: 10,
    }));

    const results = await Promise.all(calls);
    expect(results.every((result) => result.isError)).toBe(true);
    await Bun.sleep(400);
    expect(existsSync(markerPath)).toBe(false);
    rmSync(markerPath, { force: true });
  });
});
