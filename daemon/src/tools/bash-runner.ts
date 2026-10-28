/**
 * Isolated subprocess/output runner for the bash tool.
 *
 * Agent commands can produce output much faster than the daemon can write it.
 * Keeping their pipes in this helper prevents that traffic (and its GC/write
 * backpressure) from competing with the daemon's client socket event loop.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { closeSync, createWriteStream, openSync, readSync, renameSync, statSync, writeFileSync, type WriteStream } from "fs";
import { createInterface } from "readline";
import {
  readProcessStartTime,
  writeBackgroundTaskRecord,
  type BackgroundTaskRecoveryMetadata,
  type PersistedBackgroundTask,
} from "../background-task-state";

const MAX_CAPTURE_BYTES = 1_000_000;

interface StartRequest {
  type: "start";
  command: string;
  outputPath: string;
  windows: boolean;
  stdin?: string;
  keepStdinOpen?: boolean;
  tty?: boolean;
  shell?: string;
  login?: boolean;
  captureLimitBytes?: number;
  /** Cap on everything captured once the command is backgrounded (default: none). */
  backgroundCaptureLimitBytes?: number;
  terminateOnParentExit?: boolean;
  timeoutMs?: number;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface BackgroundRequest {
  type: "background";
  recovery?: BackgroundTaskRecoveryMetadata;
}

type Request = StartRequest | BackgroundRequest | { type: "input"; chars: string } | { type: "stop" };

type RunnerEvent =
  | { type: "started"; pid: number }
  | { type: "backgrounded"; byteTruncated: boolean; outputError?: string }
  | { type: "error"; message: string }
  | {
      type: "close";
      code: number | null;
      signal: string | null;
      byteTruncated: boolean;
      outputError?: string;
    };

let commandProcess: ChildProcessWithoutNullStreams | null = null;
let terminalProcess: Bun.Subprocess | null = null;
let terminal: Bun.Terminal | undefined;
let captureLimitBytes: number | undefined;
let backgroundCaptureLimitBytes: number | undefined;
let outputPath: string | undefined;
/** Bytes in the capture file, so a backgrounded capture knows when to drop its front. */
let fileBytes = 0;
/** While the front of the capture is being dropped, output waits here in order. */
let rotation: Promise<void> | null = null;
const heldOutput: Buffer[] = [];
const commandPid = () => commandProcess?.pid ?? terminalProcess?.pid;
let outputStream: WriteStream | null = null;
let outputStreamFailed = false;
let outputError: string | undefined;
let totalCapturedBytes = 0;
let byteTruncated = false;
let backgrounded = false;
let waitingForDrain = false;
let finalSent = false;
let terminating = false;
let terminateOnParentExit = false;
let commandTimeout: ReturnType<typeof setTimeout> | undefined;
let recoveryRecordPath: string | undefined;
let recoveryRecord: PersistedBackgroundTask | undefined;
let controlChannelOpen = true;

process.stdout.on("error", () => {
  controlChannelOpen = false;
});

function send(event: RunnerEvent, final = false): void {
  if (finalSent) return;
  if (final) finalSent = true;
  if (!controlChannelOpen || process.stdout.destroyed) {
    if (final) process.exit(0);
    return;
  }
  const payload = `${JSON.stringify(event)}\n`;
  try {
    if (final) {
      process.stdout.write(payload, () => process.exit(0));
    } else {
      process.stdout.write(payload);
    }
  } catch {
    controlChannelOpen = false;
    if (final) process.exit(0);
  }
}

function markOutputFailed(err: unknown): void {
  if (outputStreamFailed) return;
  outputStreamFailed = true;
  outputError = err instanceof Error ? err.message : String(err);
  outputStream?.destroy();
  outputStream = null;
  resumeCommandOutput();
}

function pauseCommandOutput(): void {
  if (waitingForDrain) return;
  waitingForDrain = true;
  commandProcess?.stdout.pause();
  commandProcess?.stderr.pause();
}

function resumeCommandOutput(): void {
  if (!waitingForDrain) return;
  waitingForDrain = false;
  commandProcess?.stdout.resume();
  commandProcess?.stderr.resume();
}

function writeOutput(data: Buffer): void {
  if (rotation) {
    heldOutput.push(data);
    return;
  }
  const stream = outputStream;
  if (!stream || outputStreamFailed) return;

  // A backgrounded command can write without end (a dev server, tail -f).
  // What matters when someone checks on it is the latest output, so past the
  // cap the front of the file is dropped, not the new output.
  if (backgrounded && captureLimitBytes === undefined && backgroundCaptureLimitBytes !== undefined) {
    if (fileBytes + data.length > backgroundCaptureLimitBytes && outputPath) {
      heldOutput.push(data);
      rotation = dropCaptureFront(outputPath, backgroundCaptureLimitBytes);
      return;
    }
    fileBytes += data.length;
    if (!stream.write(data)) pauseCommandOutput();
    return;
  }

  let chunk = data;
  const limit = captureLimitBytes ?? (backgrounded ? undefined : MAX_CAPTURE_BYTES);
  if (limit !== undefined) {
    const remaining = limit - totalCapturedBytes;
    if (remaining <= 0) {
      byteTruncated = true;
      return;
    }
    if (chunk.length > remaining) {
      chunk = chunk.subarray(0, remaining);
      byteTruncated = true;
    }
    totalCapturedBytes += chunk.length;
  }

  fileBytes += chunk.length;
  if (chunk.length > 0 && !stream.write(chunk)) {
    pauseCommandOutput();
  }
}

/**
 * Keep the newest half of the capture: copy its tail behind a one-line marker
 * into a new file and rename it over the old one (a reader that already has
 * the old file open keeps a consistent copy), then append to the new file.
 * Runs once each time the cap is passed, not per chunk.
 */
async function dropCaptureFront(path: string, limit: number): Promise<void> {
  const keepBytes = Math.floor(limit / 2);
  commandProcess?.stdout.pause();
  commandProcess?.stderr.pause();
  try {
    const old = outputStream!;
    outputStream = null;
    await new Promise<void>((resolve) => old.end(resolve));
    const size = statSync(path).size;
    const start = Math.max(0, size - keepBytes);
    const tail = Buffer.alloc(size - start);
    const input = openSync(path, "r");
    try { readSync(input, tail, 0, tail.length, start); } finally { closeSync(input); }
    // Begin at a line boundary when one is near, so the first kept line is whole.
    const newline = tail.indexOf(10);
    const kept = newline >= 0 && newline < 4096 ? tail.subarray(newline + 1) : tail;
    const marker = Buffer.from(`[earlier output dropped: kept the last ${Math.round(keepBytes / 1_048_576)} MiB; the process keeps running]\n`);
    const next = `${path}.${process.pid}.next`;
    writeFileSync(next, Buffer.concat([marker, kept]), { mode: 0o600 });
    renameSync(next, path);
    fileBytes = marker.length + kept.length;
    byteTruncated = true;
    outputStream = createWriteStream(path, { flags: "a", mode: 0o600 });
    outputStream.on("error", markOutputFailed);
    outputStream.on("drain", resumeCommandOutput);
  } catch (err) {
    markOutputFailed(err);
  } finally {
    rotation = null;
    // Backpressure belonged to the old stream, which is gone.
    waitingForDrain = false;
    const held = heldOutput.splice(0);
    for (const chunk of held) writeOutput(chunk);
    if (!waitingForDrain) {
      commandProcess?.stdout.resume();
      commandProcess?.stderr.resume();
    }
  }
}

function enableBackgrounding(request: BackgroundRequest): void {
  if (backgrounded) return;
  const pid = commandPid();
  if (request.recovery && pid) {
    const metadata = request.recovery;
    const runnerStartTime = readProcessStartTime(process.pid);
    const processStartTime = readProcessStartTime(pid);
    const record: PersistedBackgroundTask = {
      version: 1,
      state: "running",
      taskId: metadata.taskId,
      ownerConversationId: metadata.ownerConversationId,
      toolName: metadata.toolName ?? "bash",
      title: metadata.title,
      startedAt: metadata.startedAt,
      backgroundedAt: metadata.backgroundedAt,
      originDaemonPid: metadata.originDaemonPid,
      runnerPid: process.pid,
      ...(runnerStartTime ? { runnerStartTime } : {}),
      pid,
      ...(processStartTime ? { processStartTime } : {}),
      outputPath: metadata.outputPath,
      cwd: metadata.cwd,
      ...(metadata.timeoutAt !== undefined ? { timeoutAt: metadata.timeoutAt } : {}),
    };
    try {
      writeBackgroundTaskRecord(metadata.recordPath, record);
      recoveryRecordPath = metadata.recordPath;
      recoveryRecord = record;
    } catch (err) {
      send({
        type: "error",
        message: `could not persist background task state: ${err instanceof Error ? err.message : String(err)}`,
      });
      terminateCommandTree();
      return;
    }
  }

  // From this point onward the command is a durable detached task. Losing the
  // original daemon control pipe must not terminate it.
  terminateOnParentExit = false;
  backgrounded = true;
  send({
    type: "backgrounded",
    byteTruncated,
    ...(outputError ? { outputError } : {}),
  });
}

function finish(code: number | null, signal: string | null): void {
  // Output still being moved into the capture is written before the exit line.
  if (rotation) {
    void rotation.then(() => finish(code, signal));
    return;
  }
  terminal?.close();
  if (commandTimeout) clearTimeout(commandTimeout);
  const done = () => {
    if (recoveryRecordPath && recoveryRecord) {
      recoveryRecord = {
        ...recoveryRecord,
        state: "completed",
        completion: {
          endedAt: Date.now(),
          exitCode: code,
          signal,
          byteTruncated,
          ...(outputError ? { outputError } : {}),
        },
      };
      try {
        writeBackgroundTaskRecord(recoveryRecordPath, recoveryRecord);
      } catch {
        // The original daemon still receives the close event when connected.
        // Recovery cannot be guaranteed when its durable state is unavailable.
      }
    }
    send({
      type: "close",
      code,
      signal,
      byteTruncated,
      ...(outputError ? { outputError } : {}),
    }, true);
  };

  const stream = outputStream;
  outputStream = null;
  if (!stream || outputStreamFailed) {
    done();
    return;
  }

  if (backgrounded) {
    stream.write(code !== 0 && code !== null
      ? `\n[process exited with code ${code}]\n`
      : "\n[process exited successfully]\n");
  }
  stream.end(done);
}

function terminateCommandTree(): void {
  if (terminating) return;
  terminating = true;
  const pid = commandPid();
  if (!pid) {
    send({ type: "error", message: "bash runner terminated before command startup completed" }, true);
    return;
  }

  if (process.platform === "win32") {
    try { spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }); }
    catch { try { commandProcess?.kill(); } catch { /* already exited */ } }
    return;
  }

  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  const forceKill = setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
    // A descendant that left the process group (setsid, a daemonizing
    // command) survives the kill and keeps the output pipes open, so 'close'
    // would wait for it and the tool call would hang. Stop reading them once
    // the group is dead; the runner then exits (under systemd, taking that
    // descendant's unit with it).
    const release = setTimeout(() => {
      if (finalSent || !commandProcess) return;
      commandProcess.stdout.destroy();
      commandProcess.stderr.destroy();
    }, 300);
    release.unref?.();
  }, 200);
  forceKill.unref?.();
}

function start(request: StartRequest): void {
  if (commandPid()) {
    send({ type: "error", message: "bash runner received more than one start request" }, true);
    return;
  }

  try {
    terminateOnParentExit = request.terminateOnParentExit === true;
    captureLimitBytes = request.captureLimitBytes;
    backgroundCaptureLimitBytes = request.backgroundCaptureLimitBytes;
    outputPath = request.outputPath;
    outputStream = createWriteStream(request.outputPath, { flags: "wx", mode: 0o600 });
    outputStream.on("error", markOutputFailed);
    outputStream.on("drain", resumeCommandOutput);

    // Keep the legacy non-login shell default; $SHELL/login profiles are not a
    // substitute for the daemon environment supplied in request.env. Apply that
    // same environment to both PTY and pipe execution (see shell-runner.ts).
    const shell = request.shell ?? (request.windows ? "powershell" : "bash");
    const args = request.windows ? ["-NoProfile", "-Command", request.command] : [request.login ? "-lc" : "-c", request.command];
    if (request.tty) {
      if (request.windows) throw new Error("PTY execution is not supported on Windows by this runner");
      terminal = new Bun.Terminal({ cols: 120, rows: 30, data: (_term, data) => writeOutput(Buffer.from(data)) });
      terminalProcess = Bun.spawn([shell, ...args], {
        cwd: request.cwd, env: request.env ?? process.env, terminal, detached: true,
      });
      send({ type: "started", pid: terminalProcess.pid });
      if (request.timeoutMs) commandTimeout = setTimeout(terminateCommandTree, request.timeoutMs);
      if (request.stdin) terminal.write(request.stdin);
      void terminalProcess.exited.then(code => {
        // Newer Bun types also allow a signal number here.
        const signal = terminalProcess?.signalCode ?? null;
        finish(code, signal === null ? null : String(signal));
      });
      return;
    }
    commandProcess = spawn(
      shell,
      args,
      {
        cwd: request.cwd,
        env: request.env ? { ...request.env } : { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: !request.windows,
        windowsHide: request.windows,
      },
    );
  } catch (err) {
    send({ type: "error", message: err instanceof Error ? err.message : String(err) }, true);
    return;
  }

  const proc = commandProcess!;
  if (!proc.pid) {
    send({ type: "error", message: "bash runner did not receive a command PID" }, true);
    return;
  }

  send({ type: "started", pid: proc.pid });
  if (request.timeoutMs !== undefined && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0) {
    // Longer than setTimeout's maximum overflows to an immediate kill.
    commandTimeout = setTimeout(terminateCommandTree, Math.min(request.timeoutMs, 2_147_483_647));
    commandTimeout.unref?.();
  }
  proc.stdin.on("error", () => { /* the command may exit before consuming all input */ });
  if (request.keepStdinOpen) {
    if (request.stdin) proc.stdin.write(request.stdin);
  } else proc.stdin.end(request.stdin ?? "");
  proc.stdout.on("data", writeOutput);
  proc.stderr.on("data", writeOutput);
  proc.on("error", (err) => {
    send({ type: "error", message: err.message });
  });
  proc.on("close", finish);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let request: Request;
  try {
    request = JSON.parse(line) as Request;
  } catch {
    send({ type: "error", message: "bash runner received invalid JSON" }, true);
    return;
  }

  if (request.type === "start") start(request);
  else if (request.type === "background") enableBackgrounding(request);
  else if (request.type === "stop") terminateCommandTree();
  else if (request.type === "input") {
    if (terminal) terminal.write(request.chars);
    else if (commandProcess?.stdin.writable) commandProcess.stdin.write(request.chars);
  }
});

process.stdin.on("end", () => {
  if (commandPid() && terminateOnParentExit && !finalSent) {
    terminateCommandTree();
  } else if (!commandPid() && !finalSent) {
    send({ type: "error", message: "bash runner input closed before start" }, true);
  }
});

// The daemon may have to stop us before it receives the command PID. Handle
// termination here so the already-detached command group cannot be orphaned in
// that startup race.
process.on("SIGTERM", terminateCommandTree);
process.on("SIGINT", terminateCommandTree);
