/** Codex shell primitives on the same isolated runner used by the Bash tool.
 * Stdin handles are conversation-owned; output and detached tasks use the
 * existing Exocortex task/recovery lifecycle. No shell authority is inferred
 * from read/search access. */
import type { ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";
import { randomInt, randomUUID } from "crypto";
import { open } from "fs/promises";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { socketPath } from "@exocortex/shared/paths";
import { rewriteExternalToolShellCommandForExecution } from "../external-tools";
import { backgroundTaskRecordPath, removeBackgroundTaskRecord, suppressBackgroundTaskNotification } from "../background-task-state";
import type { Tool, ToolExecutionContext, ToolResult } from "./types";
import { safeSlice } from "./util";
import { spawnShellRunner } from "./shell-runner";
import { bash, killProcessGroup } from "./bash";
import { getDaemonShutdownMode } from "../daemon-lifecycle";

interface Session {
  id: number;
  owner: string;
  runner: ChildProcessWithoutNullStreams;
  pid: number;
  outputPath: string;
  cursor: number;
  startedAt: number;
  taskId: string;
  recordPath?: string;
  cwd: string;
  title: string;
  context?: ToolExecutionContext;
  backgrounded: boolean;
  suppressed: boolean;
  busy: boolean;
  closed: boolean;
  code: number | null;
  signal: string | null;
  error?: string;
  truncated: boolean;
  runnerFailed?: boolean;
  done: Promise<void>;
  finish: () => void;
  ready: Promise<void>;
  started: () => void;
  detached: Promise<void>;
  didDetach: () => void;
}

const sessions = new Map<number, Session>();
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS_PER_OWNER = 32;
const CAPTURE_BYTES = 16 * 1024 * 1024;
const HARD_TIMEOUT_MS = 3_600_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

function integer(input: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = input[key] ?? fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function stop(session: Session, suppress = false): boolean {
  if (session.closed) return false;
  if (suppress) {
    session.suppressed = true;
    if (session.recordPath) suppressBackgroundTaskNotification(session.recordPath);
  }
  // Signal the runner through its control channel even when systemd-run is the
  // direct child. The runner owns process-group termination/startup races.
  try {
    if (!session.runner.stdin.writable || session.runner.stdin.destroyed) {
      return session.pid ? killProcessGroup(session.pid) : session.runner.kill("SIGTERM");
    }
    session.runner.stdin.write(JSON.stringify({ type: "stop" }) + "\n");
    return true;
  } catch {
    if (session.pid) return killProcessGroup(session.pid);
    try { return session.runner.kill("SIGTERM"); } catch { return false; }
  }
}

function complete(session: Session): void {
  if (session.closed) return;
  session.closed = true;
  session.started();
  session.didDetach();
  session.finish();
  session.context?.setBackgroundTaskActive?.(session.taskId, false);
  // A replacement daemon, not the old in-memory notification queue, owns
  // delivery once restart preparation begins. Keep the durable record intact.
  const handoff = getDaemonShutdownMode() === "restart" && Boolean(session.recordPath);
  // A currently waiting tool call will deliver this completion directly. Do
  // not interrupt that same model turn with a duplicate user notification.
  if (!handoff && session.backgrounded && !session.suppressed && !session.busy) {
    session.context?.onBackgroundTaskComplete?.({
      taskId: session.taskId, toolName: "exec_command", title: session.title,
      startedAt: session.startedAt, endedAt: Date.now(), exitCode: session.code,
      signal: session.signal, outputPath: session.outputPath,
      ...(session.error ? { failure: session.error } : {}),
    });
  }
  // On control-channel failure, retain evidence until recovery can verify the
  // command is gone. A detached process must never disappear from recovery
  // merely because its runner died.
  if (session.recordPath && !handoff && !session.runnerFailed) removeBackgroundTaskRecord(session.recordPath);
  session.context = undefined;
  const cleanup = setTimeout(() => sessions.delete(session.id), SESSION_TTL_MS);
  cleanup.unref();
}

function failRunner(session: Session, message: string): void {
  if (session.closed) return;
  session.error ??= message;
  session.runnerFailed = true;
  if (session.pid) killProcessGroup(session.pid);
  complete(session);
}

async function waitFor(session: Session, promise: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) { stop(session); throw new DOMException("Aborted", "AbortError"); }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>(r => { timer = setTimeout(r, ms); }),
      new Promise<void>((_, reject) => {
        onAbort = () => { stop(session); reject(new DOMException("Aborted", "AbortError")); };
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function detach(session: Session, signal?: AbortSignal): Promise<void> {
  if (session.closed || session.backgrounded) return;
  const now = Date.now();
  session.recordPath = session.owner ? backgroundTaskRecordPath(session.taskId) : undefined;
  session.runner.stdin.write(JSON.stringify({
    type: "background",
    ...(session.recordPath ? { recovery: {
      recordPath: session.recordPath, taskId: session.taskId, ownerConversationId: session.owner,
      toolName: "exec_command", title: session.title, startedAt: session.startedAt,
      backgroundedAt: now, originDaemonPid: process.pid, outputPath: session.outputPath,
      cwd: session.cwd, timeoutAt: session.startedAt + HARD_TIMEOUT_MS,
    } } : {}),
  }) + "\n");
  await waitFor(session, session.detached, 10_000, signal);
  if (!session.closed && !session.backgrounded) {
    stop(session);
    throw new Error("Runner did not acknowledge session detachment; termination requested.");
  }
}

async function result(session: Session, startedAt: number, tokens: number): Promise<ToolResult> {
  let output = "";
  let originalBytes = 0;
  try {
    const file = await open(session.outputPath, "r");
    try {
      const size = (await file.stat()).size;
      originalBytes = Math.max(0, size - session.cursor);
      // Approximate token budgets deliberately have a hard byte ceiling too.
      const bytes = Buffer.alloc(Math.min(originalBytes, tokens * 4 + 4));
      const { bytesRead } = await file.read(bytes, 0, bytes.length, session.cursor);
      const decoded = new TextDecoder().decode(bytes.subarray(0, bytesRead), { stream: true });
      output = safeSlice(decoded, tokens * 4);
      // Keep an incomplete UTF-8 tail for the next poll. Budget-clipped output
      // remains available in the output artifact instead of being replayed.
      session.cursor = originalBytes > bytesRead || output.length < decoded.length
        ? size : session.cursor + Buffer.byteLength(decoded);
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") session.error = String(error);
  }
  const truncated = session.truncated || originalBytes > Buffer.byteLength(output);
  return {
    output: JSON.stringify({
      wall_time_seconds: (Date.now() - startedAt) / 1000,
      ...(session.closed ? { exit_code: session.code, ...(session.signal ? { signal: session.signal } : {}) } : { session_id: session.id, task_id: session.taskId }),
      output,
      ...(truncated ? { original_token_count: Math.ceil(originalBytes / 4), truncated: true } : {}),
      output_path: session.outputPath,
      ...(session.error ? { error: session.error } : {}),
    }),
    isError: Boolean(session.error) || (session.closed && session.code !== 0),
    ...(session.closed ? { exitCode: session.code } : {}),
  };
}

async function executeCommand(input: Record<string, unknown>, context?: ToolExecutionContext, signal?: AbortSignal): Promise<ToolResult> {
  let session: Session | undefined;
  try {
    if (typeof input.cmd !== "string" || !input.cmd.trim()) throw new Error("cmd must be a non-empty shell command.");
    const yieldMs = integer(input, "yield_time_ms", 10_000, 0, 30_000);
    const tokens = integer(input, "max_output_tokens", 10_000, 1, 30_000);
    for (const key of ["tty", "login"]) if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`${key} must be a boolean.`);
    for (const key of ["workdir", "shell"]) if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key])) throw new Error(`${key} must be a non-empty string.`);
    // Never imply a sandbox/approval policy exists when it does not.
    for (const key of ["sandbox_permissions", "additional_permissions", "environment_id"]) if (input[key] !== undefined) throw new Error(`${key} is not supported by this local executor.`);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const owner = context?.conversationId ?? "";
    if ([...sessions.values()].filter(s => s.owner === owner && !s.closed).length >= MAX_SESSIONS_PER_OWNER) throw new Error("Too many running shell sessions. Stop or finish an existing session first.");
    const windows = process.platform === "win32";
    if (windows && input.tty) throw new Error("PTY execution is currently supported on POSIX only.");
    const cwd = typeof input.workdir === "string" ? resolve(context?.cwd ?? process.cwd(), input.workdir) : context?.cwd ?? process.cwd();
    // Codex-compatible schemas must not change Exocortex's execution environment:
    // default to legacy non-login Bash (PowerShell on Windows), not $SHELL or a
    // login/interactive shell. Startup profiles can replace the daemon's PATH and
    // auth setup. Different shell/login behavior requires an explicit tool input.
    const shell = typeof input.shell === "string" ? input.shell : windows ? "powershell" : "bash";
    const command = windows ? input.cmd : await rewriteExternalToolShellCommandForExecution(input.cmd);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    let id: number;
    do { id = randomInt(1, 2 ** 31); } while (sessions.has(id));
    const startedAt = Date.now();
    const ready = deferred(), done = deferred(), detached = deferred();
    const outputPath = join(tmpdir(), `exocortex-exec-${process.pid}-${randomUUID()}.tmp`);
    const env = {
      ...process.env, EXOCORTEX_SOCKET: socketPath(), EXOCORTEX_WORKSPACE: cwd,
      ...(owner ? { EXOCORTEX_PARENT_CONV_ID: owner } : {}),
      ...(context?.provider ? { EXOCORTEX_PARENT_PROVIDER: context.provider } : {}),
      ...(context?.model ? { EXOCORTEX_PARENT_MODEL: context.model } : {}),
    };
    const runner = spawnShellRunner({
      cwd, executionId: randomUUID(), env,
    });
    session = {
      id, owner, runner, pid: 0, outputPath, cursor: 0, startedAt, taskId: `exec:${id}:${startedAt.toString(36)}`,
      cwd, title: input.cmd, context, backgrounded: false, suppressed: false, busy: true, closed: false, code: null, signal: null, truncated: false,
      ready: ready.promise, started: ready.resolve, done: done.promise, finish: done.resolve, detached: detached.promise, didDetach: detached.resolve,
    };
    const active = session;
    sessions.set(id, active);
    runner.stdin.on("error", () => {});
    runner.stderr.on("data", () => { /* Only protocol errors are returned; do not accumulate unbounded helper stderr. */ });
    runner.on("error", error => failRunner(active, error.message));
    runner.on("exit", (code, signal) => {
      // A systemd-run/control process may exit while descendants still hold
      // its pipes open: waiting only for `close` can leave the task hung.
      if (code !== 0 || signal) failRunner(active, `Shell runner exited unexpectedly (${signal ?? code}); command termination requested.`);
    });
    runner.on("close", () => {
      failRunner(active, "Shell runner disconnected before reporting completion; command termination requested.");
    });
    createInterface({ input: runner.stdout, crlfDelay: Infinity }).on("line", line => {
      if (active.closed) return;
      try {
        const event = JSON.parse(line);
        if (event.type === "started") { active.pid = event.pid; active.started(); }
        else if (event.type === "backgrounded") {
          active.backgrounded = true;
          active.truncated ||= event.byteTruncated === true;
          active.didDetach();
          if (!active.closed) context?.setBackgroundTaskActive?.(active.taskId, true, {
            title: active.title, startedAt, toolName: "exec_command", pid: active.pid,
            backgroundedAt: Date.now(), outputPath, cwd, stop: suppress => stop(active, suppress),
          });
        } else if (event.type === "error") { active.error = event.message; stop(active); }
        else if (event.type === "close") {
          active.code = event.code; active.signal = event.signal; active.truncated ||= event.byteTruncated === true;
          active.error ??= event.outputError;
          complete(active);
        }
      } catch { active.error = "Invalid shell runner protocol response."; stop(active); }
    });
    // systemd-run does not forward its client's environment to the service.
    // Carry it over the private runner protocol, as the legacy Bash tool does.
    runner.stdin.write(JSON.stringify({ type: "start", command, outputPath, windows, cwd, shell, env,
      login: input.login === true, tty: input.tty === true, keepStdinOpen: true,
      terminateOnParentExit: true, timeoutMs: HARD_TIMEOUT_MS, captureLimitBytes: CAPTURE_BYTES,
    }) + "\n");
    await waitFor(active, active.ready, 10_000, signal);
    if (!active.pid && !active.closed) throw new Error("Shell runner startup timed out; termination requested.");
    const manual = deferred();
    context?.registerBackgrounder?.({ toolName: "exec_command", toolCallId: context.toolCallId, background: () => { manual.resolve(); return !active.closed; } });
    try { await waitFor(active, Promise.race([active.done, manual.promise]), Math.max(0, yieldMs - (Date.now() - startedAt)), signal); }
    finally { context?.registerBackgrounder?.(null); }
    await detach(active, signal);
    return await result(active, startedAt, tokens);
  } catch (error) {
    if (session && !session.closed) stop(session);
    return { output: `exec_command: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  } finally { if (session) session.busy = false; }
}

async function executeStdin(input: Record<string, unknown>, context?: ToolExecutionContext, signal?: AbortSignal): Promise<ToolResult> {
  let session: Session | undefined;
  try {
    const id = integer(input, "session_id", 0, 1, 2 ** 31 - 1);
    const chars = input.chars ?? "";
    if (typeof chars !== "string") throw new Error("chars must be a string.");
    const yieldMs = integer(input, "yield_time_ms", chars ? 250 : 5_000, 0, chars ? 30_000 : 300_000);
    const tokens = integer(input, "max_output_tokens", 10_000, 1, 30_000);
    const candidate = sessions.get(id);
    if (!candidate || candidate.owner !== (context?.conversationId ?? "")) throw new Error("Unknown session in this conversation. Sessions cannot be resumed through stdin after a daemon restart; inspect the recovered task/output instead.");
    if (candidate.busy) throw new Error("Session already has an active input/wait call.");
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    session = candidate;
    session.busy = true;
    if (chars && session.closed) throw new Error("Session has already exited; input was not sent. Poll without chars for its final output.");
    const startedAt = Date.now();
    if (chars) session.runner.stdin.write(JSON.stringify({ type: "input", chars }) + "\n");
    await waitFor(session, session.done, yieldMs, signal);
    return await result(session, startedAt, tokens);
  } catch (error) {
    return { output: `write_stdin: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  } finally { if (session) session.busy = false; }
}

export const execCommand: Tool = {
  name: "exec_command", description: "Runs a shell command, returning output or a session ID for ongoing interaction. Set tty:true for a PTY; otherwise uses plain pipes.",
  parallelSafety: "exclusive", defaultTimeoutMs: null, watchdogExempt: true,
  inputSchema: { type: "object", additionalProperties: false, required: ["cmd"], properties: {
    cmd: { type: "string", description: "Shell command to execute." },
    workdir: { type: "string", description: "Working directory. Defaults to the conversation workspace." },
    shell: { type: "string", description: "Shell binary. Defaults to bash on POSIX or PowerShell on Windows, matching the legacy shell tool." },
    login: { type: "boolean", description: "Run as a login shell. Defaults to false to preserve the daemon's configured environment." },
    tty: { type: "boolean", description: "Allocate a PTY (POSIX only). Defaults to false." },
    yield_time_ms: { type: "integer", minimum: 0, maximum: 30000, description: "Time to wait before yielding a running session, not a kill timeout. Defaults to 10000 ms." },
    max_output_tokens: { type: "integer", minimum: 1, maximum: 30000, description: "Approximate output token budget. Defaults to 10000." },
  } },
  systemHint: "Use exec_command for shell commands, reading files, and searching (prefer rg for search). Use workdir to select a directory. Commands run locally with the daemon's permissions, not inside a Codex sandbox. External CLIs remain ordinary shell commands. A session_id means the process is still running: use write_stdin to send input or collect new output, chrono wait with the returned task_id for completion, or exo stop_task to stop it. Commands have a one-hour hard limit; output files are capped at 16 MiB. Stdin sessions belong to this conversation and do not survive daemon restarts, though detached tasks and their output can be recovered.",
  display: bash.display,
  summarize: input => ({ label: "$", detail: String(input.cmd ?? "") }), execute: executeCommand,
};

export const writeStdin: Tool = {
  name: "write_stdin", description: "Writes characters to an existing shell session and returns recent output. Omit chars or use an empty string to poll without writing.",
  parallelSafety: "exclusive", defaultTimeoutMs: null, watchdogExempt: true,
  inputSchema: { type: "object", additionalProperties: false, required: ["session_id"], properties: {
    session_id: { type: "integer", description: "Session identifier returned by exec_command." },
    chars: { type: "string", description: "Text to send to stdin. For a PTY, control characters such as Ctrl-C (\\u0003) work too." },
    yield_time_ms: { type: "integer", minimum: 0, maximum: 300000, description: "Wait before returning output. Writes default to 250 ms (max 30000); empty polls default to 5000 ms (max 300000)." },
    max_output_tokens: { type: "integer", minimum: 1, maximum: 30000, description: "Approximate output token budget. Defaults to 10000." },
  } },
  display: { label: "Stdin", color: bash.display.color }, summarize: input => ({ label: "Stdin", detail: String(input.session_id ?? "") }), execute: executeStdin,
};

export const unifiedExecInternalsForTest = {
  sessions,
  stopAll: () => { for (const session of sessions.values()) stop(session, true); },
};
