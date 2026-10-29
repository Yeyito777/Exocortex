import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { bash, executeBashBackgroundable, intentionalBackgroundTaskStopPidsForTest } from "./bash";
import type { BackgroundTaskCompletion } from "./types";
import { backgroundTaskRecordPath, isBackgroundTaskNotificationSuppressed } from "../background-task-state";

const isWindows = process.platform === "win32";

function platformCommand(posix: string, windows: string): string {
  return isWindows ? windows : posix;
}

/**
 * A shell wait that ends once release() runs, so a command cannot finish
 * before the test acts on it. It gives up after ~30 s if a failed test never releases it.
 */
function gate(): { wait: string; release: () => void; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "exo-bash-gate-"));
  const path = join(dir, "open");
  return {
    wait: `i=0; until [ -e '${path}' ] || [ $i -ge 3000 ]; do sleep 0.01; i=$((i + 1)); done`,
    release: () => writeFileSync(path, ""),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function waitUntil(done: () => boolean, timeoutMs = 3_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; !done() && Date.now() < deadline;) await Bun.sleep(5);
}

describe("bash manual backgrounding", () => {
  test("a user steer backgrounds a running command with a steer-specific notice", async () => {
    let background: ((reason?: "manual" | "steer") => boolean) | null = null;
    const held = gate();

    const promise = executeBashBackgroundable(
      { command: platformCommand(held.wait, "sleep 0.2"), await: 60 },
      undefined,
      60_000,
      {
        toolCallId: "call-bash-steer",
        registerBackgrounder: (backgrounder) => {
          background = backgrounder?.background ?? null;
        },
      },
    );

    await waitUntil(() => background !== null);

    expect(background!("steer")).toBe(true);
    const result = await promise;
    expect(result.isError).toBe(false);
    expect(result.output).toContain("because the user sent a message; it is still running");
    held.release();
    await new Promise(resolve => setTimeout(resolve, 300));
    held.cleanup();
  });

  test("registered backgrounder resolves a running command immediately", async () => {
    let background: (() => boolean) | null = null;
    const held = gate();

    const promise = executeBashBackgroundable(
      { command: platformCommand(`echo start; ${held.wait}; echo done`, "echo start; sleep 0.2; echo done"), await: 60 },
      undefined,
      60_000,
      {
        toolCallId: "call-bash-1",
        registerBackgrounder: (backgrounder) => {
          background = backgrounder?.background ?? null;
        },
      },
    );

    await waitUntil(() => background !== null);

    expect(background).toBeTruthy();
    expect(background!()).toBe(true);

    const result = await promise;
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Command backgrounded on user request");
    expect(result.output).toContain("Output is being written to:");
    expect(background).toBeNull();

    const spillPath = result.output.match(/Output is being written to: (\S+)/)?.[1];
    expect(spillPath).toBeTruthy();

    held.release();
    await waitUntil(() => readFileSync(spillPath!, "utf8").includes("done"));
    held.cleanup();
    const spilled = readFileSync(spillPath!, "utf8");
    expect(spilled).toContain("start");
    expect(spilled).toContain("done");
  });

  test("isolates command output handling from the daemon event loop process", async () => {
    if (process.platform === "win32") return;

    let background: (() => boolean) | null = null;
    const promise = executeBashBackgroundable(
      { command: "sleep 2", await: 60 },
      undefined,
      60_000,
      {
        toolCallId: "call-bash-isolation",
        registerBackgrounder: (entry) => { background = entry?.background ?? null; },
      },
    );

    for (let i = 0; i < 40 && !background; i++) await Bun.sleep(5);
    expect(background).toBeTruthy();
    expect(background!()).toBe(true);

    const result = await promise;
    const commandPid = Number(result.output.match(/PID (\d+)/)?.[1]);
    const status = readFileSync(`/proc/${commandPid}/status`, "utf8");
    const parentPid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);

    // The command is owned by bash-runner, not by this daemon/test process. Its
    // high-volume stdout/stderr callbacks therefore cannot monopolize our loop.
    expect(parentPid).toBeGreaterThan(0);
    expect(parentPid).not.toBe(process.pid);
    process.kill(-commandPid, "SIGTERM");
    await Bun.sleep(100);
    const spillPath = result.output.match(/Output is being written to: (\S+)/)?.[1];
    if (spillPath) rmSync(spillPath, { force: true });
  });

  test("runner failure stops a backgrounded command and clears lifecycle state", async () => {
    if (process.platform === "win32") return;
    const activity: boolean[] = [];
    const completions: BackgroundTaskCompletion[] = [];
    const result = await executeBashBackgroundable(
      { command: "sleep 30", background: true },
      undefined,
      60_000,
      {
        conversationId: "runner-failure-conversation",
        setBackgroundTaskActive: (_id, active) => activity.push(active),
        onBackgroundTaskComplete: (completion) => completions.push(completion),
      },
    );
    const commandPid = Number(result.output.match(/PID (\d+)/)?.[1]);
    const status = readFileSync(`/proc/${commandPid}/status`, "utf8");
    const runnerPid = Number(status.match(/^PPid:\s+(\d+)/m)?.[1]);
    expect(runnerPid).toBeGreaterThan(0);

    process.kill(runnerPid, "SIGKILL");
    for (let i = 0; i < 50 && activity.length < 2; i++) await Bun.sleep(10);
    await Bun.sleep(250);

    expect(activity).toEqual([true, false]);
    expect(completions).toHaveLength(1);
    expect(completions[0].failure).toContain("runner exited unexpectedly");
    expect(() => process.kill(-commandPid, 0)).toThrow();
    const spillPath = result.output.match(/Output is being written to: (\S+)/)?.[1];
    if (spillPath) rmSync(spillPath, { force: true });
  });
});

describe("bash explicit backgrounding", () => {
  test("background=true returns immediately while output continues into the spill file", async () => {
    const markerPath = join(tmpdir(), `exocortex-bash-background-marker-${process.pid}-${Date.now()}`);
    const promise = executeBashBackgroundable({
      command: platformCommand(`printf 'start\\n'; sleep 0.3; printf 'done\\n'; touch '${markerPath}'`, `[Console]::Write('start' + [Environment]::NewLine); Start-Sleep -Milliseconds 300; [Console]::Write('done' + [Environment]::NewLine); [IO.File]::WriteAllText('${markerPath}', '')`),
      background: true,
    }, undefined, 60_000);

    const result = await promise;
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Command backgrounded immediately by request");
    expect(result.output).toContain("Output is being written to:");
    expect(result.output).toMatch(/chrono wait with task_id="bash:\d+:[a-z0-9]+" and max_wait=<duration>/);
    if (process.platform !== "win32") {
      expect(result.output).toContain("kill -0 -- -");
      expect(result.output).toContain("kill -- -");
    }
    expect(existsSync(markerPath)).toBe(false);

    const spillPath = result.output.match(/Output is being written to: (\S+)/)?.[1];
    expect(spillPath).toBeTruthy();

    for (let i = 0; i < 50 && !existsSync(markerPath); i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(existsSync(markerPath)).toBe(true);
    let spilled = "";
    for (let i = 0; i < 50; i++) {
      spilled = existsSync(spillPath!) ? readFileSync(spillPath!, "utf8") : "";
      if (spilled.includes("done")) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(spilled).toContain("start");
    expect(spilled).toContain("done");

    rmSync(markerPath, { force: true });
    rmSync(spillPath!, { force: true });
  });

  test("reports the detached process lifecycle to its conversation context", async () => {
    const activity: Array<{ id: string; active: boolean; details?: { title: string; startedAt: number } }> = [];
    const completions: BackgroundTaskCompletion[] = [];
    const result = await executeBashBackgroundable({
      command: "sleep 0.1",
      background: true,
    }, undefined, 60_000, {
      conversationId: "parent-conversation",
      setBackgroundTaskActive: (id, active, details) => activity.push({ id, active, details }),
      onBackgroundTaskComplete: (completion) => completions.push(completion),
    });

    expect(result.isError).toBe(false);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      active: true,
      details: { title: "sleep 0.1", startedAt: expect.any(Number) },
    });
    expect(activity[0].id).toMatch(/^bash:\d+:[a-z0-9]+$/);
    expect(activity[0].details).toMatchObject({
      toolName: "bash",
      pid: expect.any(Number),
      backgroundedAt: expect.any(Number),
      outputPath: expect.any(String),
      cwd: expect.any(String),
      stop: expect.any(Function),
    });

    for (let i = 0; i < 50 && activity.length < 2; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(activity).toEqual([
      { id: activity[0].id, active: true, details: activity[0].details },
      { id: activity[0].id, active: false, details: undefined },
    ]);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      taskId: activity[0].id,
      toolName: "bash",
      title: "sleep 0.1",
      exitCode: 0,
      signal: null,
      outputPath: expect.any(String),
    });
    expect(completions[0].endedAt).toBeGreaterThanOrEqual(completions[0].startedAt);

    const spillPath = result.output.match(/Output is being written to: (\S+)/)?.[1];
    if (spillPath) rmSync(spillPath, { force: true });
  });

  test("does not notify the model about a background task it deliberately stops", async () => {
    const completions: BackgroundTaskCompletion[] = [];
    const activity: boolean[] = [];
    const context = {
      conversationId: "intentional-stop-conversation",
      setBackgroundTaskActive: (_id: string, active: boolean) => activity.push(active),
      onBackgroundTaskComplete: (completion: BackgroundTaskCompletion) => completions.push(completion),
    };
    const background = await executeBashBackgroundable({
      command: "sleep 30",
      background: true,
    }, undefined, 60_000, context);
    const pid = Number(background.output.match(/PID (\d+)/)?.[1]);
    const spillPath = background.output.match(/Output is being written to: (\S+)/)?.[1];

    expect(pid).toBeGreaterThan(0);
    const stopped = await executeBashBackgroundable({ command: `kill ${pid}` }, undefined, 60_000, context);
    expect(stopped.isError).toBe(false);

    for (let index = 0; index < 50 && !activity.includes(false); index++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(activity).toEqual([true, false]);
    expect(completions).toHaveLength(0);
    if (spillPath) rmSync(spillPath, { force: true });
  });

  test("restores durable notification delivery when an attempted stop command fails", async () => {
    if (process.platform === "win32") return;
    const completions: BackgroundTaskCompletion[] = [];
    const context = {
      conversationId: `failed-stop-${process.pid}-${Date.now()}`,
      setBackgroundTaskActive: () => {},
      onBackgroundTaskComplete: (completion: BackgroundTaskCompletion) => completions.push(completion),
    };
    const background = await executeBashBackgroundable({
      command: "sleep 0.3",
      background: true,
    }, undefined, 60_000, context);
    const taskId = background.output.match(/task_id="([^"]+)"/)?.[1];
    const pid = Number(background.output.match(/PID (\d+)/)?.[1]);
    expect(taskId).toBeTruthy();
    expect(pid).toBeGreaterThan(0);

    const failedStop = await executeBashBackgroundable({ command: `kill -NOT_A_SIGNAL ${pid}` }, undefined, 60_000, context);
    expect(failedStop.isError).toBe(true);
    expect(isBackgroundTaskNotificationSuppressed(backgroundTaskRecordPath(taskId!))).toBe(false);

    for (let index = 0; index < 100 && completions.length === 0; index++) await Bun.sleep(10);
    expect(completions).toHaveLength(1);
    const spillPath = background.output.match(/Output is being written to: (\S+)/)?.[1];
    if (spillPath) rmSync(spillPath, { force: true });
  });

  test("rejects conflicting background and await parameters before spawning", async () => {
    const result = await executeBashBackgroundable({
      command: "echo should-not-run",
      background: true,
      await: 10,
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("cannot be combined");
  });

  test("directs await=0 callers to the explicit background parameter", async () => {
    const result = await executeBashBackgroundable({ command: "echo should-not-run", await: 0 });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Use 'background: true'");
  });

  test("exposes and summarizes the background flag", () => {
    expect((bash.inputSchema.properties as Record<string, unknown>).background).toBeDefined();
    expect(bash.summarize({ command: "sleep 30", background: true }).detail).toBe("sleep 30 --background");
  });
});

describe("bash intentional background-task stop detection", () => {
  test("recognizes direct kill commands and signal variants", () => {
    expect(intentionalBackgroundTaskStopPidsForTest("kill 1234")).toEqual([1234]);
    expect(intentionalBackgroundTaskStopPidsForTest("kill -TERM 1234; rm -f output.tmp")).toEqual([1234]);
    expect(intentionalBackgroundTaskStopPidsForTest("/bin/kill -9 1234 5678")).toEqual([1234, 5678]);
    expect(intentionalBackgroundTaskStopPidsForTest("kill -- -1234")).toEqual([1234]);
    expect(intentionalBackgroundTaskStopPidsForTest("taskkill /T /F /PID 1234")).toEqual([1234]);
  });

  test("does not treat status probes or incidental text as stop commands", () => {
    expect(intentionalBackgroundTaskStopPidsForTest("kill -0 1234 && echo running || echo exited")).toEqual([]);
    expect(intentionalBackgroundTaskStopPidsForTest("echo kill 1234")).toEqual([]);
  });
});
