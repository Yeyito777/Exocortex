/**
 * Runs a model's shell command on this machine for another Exocortex daemon:
 * client_bash for a daemon this machine's TUI (over /ssh) or daemon (over its
 * /proxy link) is connected to, and remote_bash for a daemon that borrows this
 * one's provider through /proxy (run by this daemon).
 *
 * Each command runs in its own process group, so a timeout, a cancel from the
 * daemon, a lost connection, or the TUI exiting stops everything it started.
 *
 * While commands run, the executor says so (`onAlive`) at once and then every
 * EXEC_ALIVE_INTERVAL_MS, so the asking daemon can tell a frozen or vanished
 * machine from a slow command (ExecLiveness) instead of waiting out the timeout.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { dataDir } from "./paths";
import type { ClientExecRequestEvent, ClientExecResultCommand, ClientHostInfo } from "./protocol";

const MAX_CAPTURE_BYTES = 1_000_000;
const KILL_GRACE_MS = 200;
const windows = process.platform === "win32";

/** How often a machine running commands says it is still alive. */
export const EXEC_ALIVE_INTERVAL_MS = 10_000;
/** A machine that has not acknowledged a command this long after it was sent is taken as unresponsive. */
export const EXEC_ACK_TIMEOUT_MS = 15_000;
/** A machine silent this long while a command runs is taken as gone. */
export const EXEC_SILENCE_TIMEOUT_MS = 45_000;

export type ClientExecOutcome = Omit<ClientExecResultCommand, "type" | "execId">;

/** What an install ID looks like (ClientHostInfo.installId). */
export const INSTALL_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

let cachedInstallId: string | null | undefined;

function readInstallId(path: string): string | null {
  try {
    const id = readFileSync(path, "utf8").trim();
    return INSTALL_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * This install's ID: random, made once and kept in its data directory
 * (client-install-id), and sent with the machine it announces so a daemon can
 * tell apart two machines with the same user@hostname. Null when it can be
 * neither read nor saved.
 */
export function clientInstallId(): string | null {
  if (cachedInstallId !== undefined) return cachedInstallId;
  const path = join(dataDir(), "client-install-id");
  let id = readInstallId(path);
  if (!id) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      // Exclusive create, so a TUI and daemon starting together keep one ID.
      writeFileSync(path, `${randomBytes(8).toString("hex")}\n`, { flag: existsSync(path) ? "w" : "wx", mode: 0o600 });
    } catch { /* made by another process just now, or not writable */ }
    id = readInstallId(path);
  }
  cachedInstallId = id;
  return id;
}

/** This machine, as client_bash and remote_bash describe it. */
export function localHostInfo(): ClientHostInfo {
  let user = process.env.USER ?? process.env.USERNAME ?? "";
  try { user = userInfo().username; } catch { /* no passwd entry */ }
  const installId = clientInstallId();
  return { hostname: hostname(), user, platform: process.platform, home: homedir(), ...(installId ? { installId } : {}) };
}

export interface ClientExecutorOptions {
  /** Called with a command's id as soon as it is received, then with every running id each interval. */
  onAlive?: (execIds: string[]) => void;
  aliveIntervalMs?: number;
}

/**
 * The asking side's watch on one command: fails it (`onStall`) when the
 * machine does not acknowledge it in time, or goes silent while it runs.
 * Only for machines that send alive messages.
 */
export class ExecLiveness {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private acknowledged = false;

  constructor(
    private readonly onStall: (phase: "ack" | "silence", afterMs: number) => void,
    ackTimeoutMs = EXEC_ACK_TIMEOUT_MS,
    private readonly silenceTimeoutMs = EXEC_SILENCE_TIMEOUT_MS,
  ) {
    this.arm(ackTimeoutMs, "ack");
  }

  get wasAcknowledged(): boolean { return this.acknowledged; }

  /** The machine said the command is running. */
  heard(): void {
    if (!this.timer) return;
    this.acknowledged = true;
    this.arm(this.silenceTimeoutMs, "silence");
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(ms: number, phase: "ack" | "silence"): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onStall(phase, ms);
    }, ms);
    this.timer.unref?.();
  }
}

/** Why a stalled command failed, for the model. */
export function execStallMessage(where: string, phase: "ack" | "silence", afterMs: number): string {
  const seconds = Math.round(afterMs / 1000);
  return phase === "ack"
    ? `${where} did not respond within ${seconds}s (frozen, asleep or offline); the command was not confirmed to start there.`
    : `${where} stopped responding while the command ran (silent for ${seconds}s); it may still be running there.`;
}

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
  private aliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly home = homedir(), private readonly options: ClientExecutorOptions = {}) {}

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
    this.reportAlive(request.execId);
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
      if (this.running.size === 0) {
        process.off("exit", this.exitHandler);
        if (this.aliveTimer) clearInterval(this.aliveTimer);
        this.aliveTimer = null;
      }
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

  /** Acknowledge a command just started, and keep reporting the running ones. */
  private reportAlive(execId: string): void {
    const onAlive = this.options.onAlive;
    if (!onAlive) return;
    onAlive([execId]);
    if (this.aliveTimer) return;
    this.aliveTimer = setInterval(() => {
      if (this.running.size > 0) onAlive([...this.running.keys()]);
    }, this.options.aliveIntervalMs ?? EXEC_ALIVE_INTERVAL_MS);
    this.aliveTimer.unref?.();
  }
}
