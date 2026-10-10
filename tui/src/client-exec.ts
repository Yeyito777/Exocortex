/**
 * Runs the model's client_bash commands on this machine for a daemon reached
 * over /ssh.
 *
 * Each command runs in its own process group, so a timeout, a cancel from the
 * daemon, a lost connection, or the TUI exiting stops everything it started.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ClientExecRequestEvent, ClientExecResultCommand } from "./protocol";

const MAX_CAPTURE_BYTES = 1_000_000;
const KILL_GRACE_MS = 200;
const windows = process.platform === "win32";

export type ClientExecOutcome = Omit<ClientExecResultCommand, "type" | "execId">;

/** A cwd relative to home, with ~ expanded; null if it is not a directory. */
export function resolveClientCwd(cwd: string | undefined, home = homedir()): string | null {
  const path = !cwd || cwd === "~" ? home
    : cwd.startsWith("~/") ? join(home, cwd.slice(2))
    : isAbsolute(cwd) ? cwd : join(home, cwd);
  try {
    return statSync(path).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (windows) {
    try { spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }); } catch { /* already gone */ }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { return; }
  setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
  }, KILL_GRACE_MS).unref();
}

export class ClientExecutor {
  private readonly running = new Map<string, ChildProcess>();
  private readonly exitHandler = () => this.cancelAll();

  constructor(private readonly home = homedir()) {}

  get size(): number { return this.running.size; }

  run(request: Pick<ClientExecRequestEvent, "execId" | "command" | "cwd" | "timeoutMs">, done: (outcome: ClientExecOutcome) => void): void {
    const fail = (error: string) => done({ output: "", byteTruncated: false, exitCode: null, signal: null, timedOut: false, error });
    if (this.running.has(request.execId)) return;
    const cwd = resolveClientCwd(request.cwd, this.home);
    if (!cwd) return fail(`Working directory not found: ${request.cwd}`);

    let child: ChildProcess;
    try {
      child = spawn(windows ? "powershell" : "bash", windows ? ["-NoProfile", "-Command", request.command] : ["-c", request.command], {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: !windows,
        windowsHide: true,
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    if (this.running.size === 0) process.once("exit", this.exitHandler);
    this.running.set(request.execId, child);
    const chunks: Buffer[] = [];
    let captured = 0;
    let byteTruncated = false;
    let timedOut = false;
    let spawnError: string | undefined;
    const capture = (chunk: Buffer) => {
      const remaining = MAX_CAPTURE_BYTES - captured;
      if (remaining <= 0) { byteTruncated = true; return; }
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      if (kept !== chunk) byteTruncated = true;
      chunks.push(kept);
      captured += kept.length;
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    const timer = request.timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, request.timeoutMs) : undefined;
    timer?.unref();

    let settled = false;
    const settle = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      this.running.delete(request.execId);
      if (this.running.size === 0) process.off("exit", this.exitHandler);
      done({
        output: Buffer.concat(chunks).toString("utf8"),
        byteTruncated,
        exitCode,
        signal,
        timedOut,
        ...(spawnError ? { error: spawnError } : {}),
      });
    };
    child.on("error", error => {
      spawnError = error.message;
      // A process that never started emits no close event.
      if (child.pid === undefined) settle(null, null);
    });
    child.on("close", (code, signal) => settle(code, signal));
  }

  cancel(execId: string): void {
    const child = this.running.get(execId);
    if (child) killTree(child);
  }

  cancelAll(): void {
    for (const child of this.running.values()) killTree(child);
  }
}
