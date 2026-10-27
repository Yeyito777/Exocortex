import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientExecutor, ExecLiveness, resolveClientCwd, type ClientExecOutcome } from "./command-exec";

const dirs: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "client-exec-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(executor: ClientExecutor, command: string, options: { cwd?: string; timeoutMs?: number; execId?: string } = {}): Promise<ClientExecOutcome> {
  return new Promise(resolve => executor.run({ execId: options.execId ?? crypto.randomUUID(), command, cwd: options.cwd, timeoutMs: options.timeoutMs ?? 10_000 }, resolve));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe.skipIf(process.platform === "win32")("ClientExecutor", () => {
  test("runs in the home directory and captures stdout, stderr and the exit code", async () => {
    const home = tempHome();
    const outcome = await run(new ClientExecutor(home), "pwd; echo err >&2; exit 3");
    expect(outcome).toEqual({ output: `${home}\nerr\n`, byteTruncated: false, exitCode: 3, signal: null, timedOut: false });
  });

  test("resolves ~ and relative working directories against home", async () => {
    const home = tempHome();
    mkdtempSync(join(home, "x"));
    expect(resolveClientCwd(undefined, home)).toBe(home);
    expect(resolveClientCwd("~", home)).toBe(home);
    expect(resolveClientCwd("/", home)).toBe("/");
    writeFileSync(join(home, "file"), "");
    expect(resolveClientCwd("~/file", home)).toBeNull();
    expect(resolveClientCwd("missing", home)).toBeNull();
    const outcome = await run(new ClientExecutor(home), "true", { cwd: "~/missing" });
    expect(outcome.error).toBe("Working directory not found: ~/missing");
  });

  test("a timeout stops the whole process tree", async () => {
    const home = tempHome();
    const outcome = await run(new ClientExecutor(home), "sleep 30 & echo $!; wait", { timeoutMs: 300 });
    expect(outcome.timedOut).toBe(true);
    const grandchild = Number(outcome.output.trim());
    expect(grandchild).toBeGreaterThan(0);
    await Bun.sleep(300);
    expect(alive(grandchild)).toBe(false);
  });

  test("cancel and cancelAll stop running commands", async () => {
    const executor = new ClientExecutor(tempHome());
    const first = run(executor, "sleep 30", { execId: "a" });
    const second = run(executor, "sleep 30", { execId: "b" });
    expect(executor.size).toBe(2);
    executor.cancel("a");
    expect((await first).signal).toBe("SIGTERM");
    executor.cancelAll();
    expect((await second).signal).toBe("SIGTERM");
    expect(executor.size).toBe(0);
  });

  test("caps captured output at 1MB", async () => {
    const outcome = await run(new ClientExecutor(tempHome()), "head -c 1500000 /dev/zero | tr '\\0' a");
    expect(outcome.byteTruncated).toBe(true);
    expect(outcome.output.length).toBe(1_000_000);
    expect(outcome.exitCode).toBe(0);
  });

  test("acknowledges a command at once and reports the running ones until they finish", async () => {
    const alive: string[][] = [];
    const executor = new ClientExecutor(tempHome(), { onAlive: execIds => alive.push(execIds), aliveIntervalMs: 40 });
    const outcome = run(executor, "sleep 0.3", { execId: "long" });
    expect(alive).toEqual([["long"]]);
    expect((await outcome).exitCode).toBe(0);
    expect(alive.length).toBeGreaterThanOrEqual(4);
    expect(alive.every(ids => ids.length === 1 && ids[0] === "long")).toBe(true);
    const reported = alive.length;
    await Bun.sleep(120);
    expect(alive.length).toBe(reported);
  });
});

describe("ExecLiveness", () => {
  test("stalls without an acknowledgement, or when heartbeats stop", async () => {
    const stalls: string[] = [];
    const unacknowledged = new ExecLiveness(phase => stalls.push(phase), 30, 60);
    await Bun.sleep(60);
    expect(stalls).toEqual(["ack"]);
    expect(unacknowledged.wasAcknowledged).toBe(false);

    const beating = new ExecLiveness(phase => stalls.push(phase), 30, 60);
    for (let i = 0; i < 5; i++) {
      beating.heard();
      await Bun.sleep(25);
    }
    expect(stalls).toEqual(["ack"]);
    await Bun.sleep(90);
    expect(stalls).toEqual(["ack", "silence"]);

    const stopped = new ExecLiveness(phase => stalls.push(phase), 10, 10);
    stopped.stop();
    await Bun.sleep(30);
    expect(stalls).toEqual(["ack", "silence"]);
  });
});
