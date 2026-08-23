/**
 * Isolated subprocess/output runner for the bash tool.
 *
 * Agent commands can produce output much faster than the daemon can write it.
 * Keeping their pipes in this helper prevents that traffic (and its GC/write
 * backpressure) from competing with the daemon's client socket event loop.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createWriteStream, type WriteStream } from "fs";
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
  terminateOnParentExit?: boolean;
  timeoutMs?: number;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface BackgroundRequest {
  type: "background";
  recovery?: BackgroundTaskRecoveryMetadata;
}

type Request = StartRequest | BackgroundRequest;

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
  const stream = outputStream;
  if (!stream || outputStreamFailed) return;

  let chunk = data;
  if (!backgrounded) {
    const remaining = MAX_CAPTURE_BYTES - totalCapturedBytes;
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

  if (chunk.length > 0 && !stream.write(chunk)) {
    pauseCommandOutput();
  }
}

function enableBackgrounding(request: BackgroundRequest): void {
  if (backgrounded) return;
  if (request.recovery && commandProcess?.pid) {
    const metadata = request.recovery;
    const runnerStartTime = readProcessStartTime(process.pid);
    const processStartTime = readProcessStartTime(commandProcess.pid);
    const record: PersistedBackgroundTask = {
      version: 1,
      state: "running",
      taskId: metadata.taskId,
      ownerConversationId: metadata.ownerConversationId,
      toolName: "bash",
      title: metadata.title,
      startedAt: metadata.startedAt,
      backgroundedAt: metadata.backgroundedAt,
      originDaemonPid: metadata.originDaemonPid,
      runnerPid: process.pid,
      ...(runnerStartTime ? { runnerStartTime } : {}),
      pid: commandProcess.pid,
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
  const proc = commandProcess;
  if (!proc?.pid) {
    send({ type: "error", message: "bash runner terminated before command startup completed" }, true);
    return;
  }

  if (process.platform === "win32") {
    try { spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], { stdio: "ignore", windowsHide: true }); }
    catch { try { proc.kill(); } catch { /* already exited */ } }
    return;
  }

  try { process.kill(-proc.pid, "SIGTERM"); } catch { /* already exited */ }
  const forceKill = setTimeout(() => {
    try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* already exited */ }
  }, 200);
  forceKill.unref?.();
}

function start(request: StartRequest): void {
  if (commandProcess) {
    send({ type: "error", message: "bash runner received more than one start request" }, true);
    return;
  }

  try {
    terminateOnParentExit = request.terminateOnParentExit === true;
    outputStream = createWriteStream(request.outputPath, { flags: "wx", mode: 0o600 });
    outputStream.on("error", markOutputFailed);
    outputStream.on("drain", resumeCommandOutput);

    commandProcess = spawn(
      request.windows ? "powershell" : "bash",
      request.windows ? ["-NoProfile", "-Command", request.command] : ["-c", request.command],
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
    commandTimeout = setTimeout(terminateCommandTree, request.timeoutMs);
    commandTimeout.unref?.();
  }
  proc.stdin.on("error", () => { /* the command may exit before consuming all input */ });
  proc.stdin.end(request.stdin ?? "");
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
});

process.stdin.on("end", () => {
  if (commandProcess && terminateOnParentExit && !finalSent) {
    terminateCommandTree();
  } else if (!commandProcess && !finalSent) {
    send({ type: "error", message: "bash runner input closed before start" }, true);
  }
});

// The daemon may have to stop us before it receives the command PID. Handle
// termination here so the already-detached command group cannot be orphaned in
// that startup race.
process.on("SIGTERM", terminateCommandTree);
process.on("SIGINT", terminateCommandTree);
