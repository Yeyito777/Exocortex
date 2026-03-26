/**
 * Bash tool — execute shell commands.
 *
 * Output protection: when stdout+stderr exceeds ~30K characters, the full
 * output is saved to a temp file and a head+tail preview is returned.
 * The agent can use the read tool to paginate through the full output.
 *
 * Backgrounding: when a command runs longer than TOOL_BACKGROUND_SECONDS,
 * the promise resolves with partial output + PID + temp file path.
 * The process keeps running and its output continues being written to the
 * temp file. The AI can check on it, read its output, or kill it.
 */

import { spawn } from "child_process";
import { writeFileSync, createWriteStream, type WriteStream } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Tool, ToolResult, ToolSummary } from "./types";
import { MAX_OUTPUT_CHARS, getString, getNumber, safeSlice, summarizeParams } from "./util";
import { TOOL_BACKGROUND_SECONDS } from "../constants";
import { isWindows } from "@exocortex/shared/paths";

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 3_600_000; // 1 hour
const MAX_OUTPUT_BYTES = 1_000_000;   // 1MB process capture limit
const HEAD_BUDGET = 20_000;           // chars for head preview
const TAIL_BUDGET = 8_000;            // chars for tail preview

// ── Output limiting ───────────────────────────────────────────────

/** Truncate a single line if it exceeds the per-line budget. */
function truncLine(line: string, budget: number): string {
  if (line.length <= budget) return line;
  return safeSlice(line, budget) + `... [truncated, ${line.length} chars total]`;
}

/**
 * When output is too large for the conversation context, save the full
 * text to a temp file and return a head+tail preview with the file path.
 */
function spillAndPreview(output: string, byteTruncated: boolean): string {
  const spillPath = join(tmpdir(), `exocortex-bash-${Date.now()}.txt`);
  writeFileSync(spillPath, output);

  const lines = output.split("\n");
  const totalLines = lines.length;

  // Head: lines from the start, up to HEAD_BUDGET chars.
  // Individual lines longer than HEAD_BUDGET are truncated so a single
  // minified line can never blow through the budget.
  let headEnd = 0;
  let headChars = 0;
  while (headEnd < totalLines) {
    const lineCost = Math.min(lines[headEnd].length, HEAD_BUDGET) + 1;
    if (headChars + lineCost > HEAD_BUDGET && headEnd > 0) break;
    headChars += lineCost;
    headEnd++;
  }

  // Tail: lines from the end, up to TAIL_BUDGET chars
  let tailStart = totalLines;
  let tailChars = 0;
  while (tailStart > headEnd) {
    const lineCost = Math.min(lines[tailStart - 1].length, TAIL_BUDGET) + 1;
    if (tailChars + lineCost > TAIL_BUDGET) break;
    tailStart--;
    tailChars += lineCost;
  }

  const omitted = tailStart - headEnd;
  const head = lines.slice(0, headEnd).map(l => truncLine(l, HEAD_BUDGET)).join("\n");
  const tail = tailStart < totalLines
    ? lines.slice(tailStart).map(l => truncLine(l, TAIL_BUDGET)).join("\n")
    : "";

  const truncNote = byteTruncated ? ", byte-truncated at 1MB" : "";
  const separator = `\n\n... ${omitted.toLocaleString()} lines omitted (${totalLines.toLocaleString()} total${truncNote}). Full output: ${spillPath}\nUse the read tool with offset/limit to browse.\n\n`;

  return tail ? head + separator + tail : head + separator;
}

// ── Process group kill ─────────────────────────────────────────────

const KILL_GRACE_MS = 200;

/**
 * Kill an entire process group: SIGTERM first, then SIGKILL after a
 * short grace period. The negative PID targets every process in the
 * group — bash, its children, their children, etc.
 *
 * On Windows, uses `taskkill /T /F` to kill the process tree (negative
 * PIDs are meaningless on Windows).
 */
function killProcessGroup(pid: number): void {
  if (isWindows) {
    try { spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* process already exited */ }
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { /* process already exited */ }
    setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch { /* process already exited */ }
    }, KILL_GRACE_MS);
  }
}

// ── Execution ──────────────────────────────────────────────────────

/** Conforms to Tool.execute — no backgrounding (used if called via the generic path). */
async function executeBash(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  return executeBashImpl(input, signal);
}

/**
 * Execute a bash command with backgrounding support.
 *
 * When the command doesn't finish in time, the promise resolves with
 * partial output + PID + temp file path. The process keeps running —
 * its output is written to the temp file.
 *
 * When the AI passes `await` (seconds), it fully overrides the default
 * background threshold — even if shorter.
 *
 * Called directly by the registry (bypassing Tool.execute) so it can
 * inject the default background timeout from TOOL_BACKGROUND_SECONDS.
 */
// Commands that are expected to take a long time (subagent calls, etc).
// When one of these is detected and no explicit `await` is set, the
// background threshold is raised to 30 minutes instead of the default 60s.
const LONG_RUNNING_COMMANDS = ["exo ", "exo\n"];
const LONG_RUNNING_BG_MS = 30 * 60 * 1000; // 30 minutes

export async function executeBashBackgroundable(
  input: Record<string, unknown>,
  signal?: AbortSignal,
  defaultBgMs?: number,
): Promise<ToolResult> {
  const awaitSeconds = getNumber(input, "await");
  let bgMs: number | undefined;
  if (awaitSeconds) {
    bgMs = awaitSeconds * 1000;
  } else {
    const command = getString(input, "command") ?? "";
    const cmdTrimmed = command.trimStart();
    const isLongRunning = LONG_RUNNING_COMMANDS.some(prefix => cmdTrimmed.startsWith(prefix));
    bgMs = isLongRunning ? LONG_RUNNING_BG_MS : defaultBgMs;
  }
  return executeBashImpl(input, signal, bgMs);
}

async function executeBashImpl(
  input: Record<string, unknown>,
  signal?: AbortSignal,
  backgroundAfterMs?: number,
): Promise<ToolResult> {
  const command = getString(input, "command");
  if (!command) return { output: "Error: missing 'command' parameter", isError: true };

  const timeout = getNumber(input, "timeout") ?? DEFAULT_TIMEOUT_MS;

  const startTime = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(
      isWindows ? "powershell" : "bash",
      isWindows ? ["-NoProfile", "-Command", command] : ["-c", command],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
        detached: !isWindows,   // own process group so we can kill the entire tree (breaks on Windows)
        windowsHide: isWindows,
      },
    );

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let byteTruncated = false;
    let settled = false;
    let bgTimer: ReturnType<typeof setTimeout> | undefined;

    // When backgrounded, output is redirected to this write stream.
    let bgStream: WriteStream | undefined;

    function collect(data: Buffer): void {
      // After backgrounding, write to temp file instead of in-memory buffer
      if (bgStream) {
        bgStream.write(data);
        return;
      }
      if (byteTruncated) return;
      totalBytes += data.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        byteTruncated = true;
        chunks.push(data.subarray(0, MAX_OUTPUT_BYTES - (totalBytes - data.length)));
      } else {
        chunks.push(data);
      }
    }

    proc.stdout.on("data", collect);
    proc.stderr.on("data", collect);

    // ── Abort handling: kill entire process group on signal ────
    // Resolves immediately with elapsed time + partial output so the
    // agent loop doesn't block. The process cleanup continues in the
    // background via killProcessGroup.
    if (signal) {
      const onAbort = () => {
        if (bgTimer) clearTimeout(bgTimer);
        if (proc.pid) killProcessGroup(proc.pid);
        if (bgStream) { bgStream.end(); bgStream = undefined; }
        if (settled) return;
        settled = true;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const partial = Buffer.concat(chunks).toString("utf8").trimEnd();
        const reason = signal.reason === "watchdog"
          ? `Watchdog timed out after ${elapsed}s (stream was inactive too long).`
          : `User interrupted after ${elapsed}s of execution.`;
        let output = reason;
        if (partial) output += ` Partial output captured:\n${partial}`;
        resolve({ output, isError: false });
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        proc.on("close", () => signal.removeEventListener("abort", onAbort));
      }
    }

    // ── Background handling: detach after timeout ─────────────
    // The process keeps running. Output is redirected to a temp file.
    // The promise resolves with partial output + instructions for the AI.
    if (backgroundAfterMs && backgroundAfterMs > 0) {
      bgTimer = setTimeout(() => {
        if (settled || !proc.pid) return;
        settled = true;

        const spillPath = join(tmpdir(), `exocortex-bash-${proc.pid}-${Date.now()}.tmp`);
        const partial = Buffer.concat(chunks).toString("utf8");

        // Open write stream and flush accumulated output to it
        bgStream = createWriteStream(spillPath);
        bgStream.write(partial);
        // New data events will now append to bgStream via collect()

        const bgSec = Math.round(backgroundAfterMs / 1000);
        const preview = partial.trimEnd();
        let output = preview ? `${preview}\n\n` : "";
        const checkCmd = isWindows
          ? `bash "if (Get-Process -Id ${proc.pid} -ErrorAction SilentlyContinue) { 'running' } else { 'exited' }"`
          : `bash "kill -0 ${proc.pid} 2>/dev/null && echo running || echo exited"`;
        const stopCmd = isWindows
          ? `bash "taskkill /T /F /PID ${proc.pid}"`
          : `bash "kill ${proc.pid}"`;
        output += [
          `⏳ Command backgrounded — still running after ${bgSec}s (PID ${proc.pid}).`,
          `Output is being written to: ${spillPath}`,
          `• View output so far → read tool on that file`,
          `• Check if still running → ${checkCmd}`,
          `• Wait for it to finish → ${isWindows ? `bash with command "Get-Content -Path '${spillPath}' -Wait -Tail 50" and await=N` : `bash with command "tail -f ${spillPath}" and await=N`} (where N is how long you're willing to wait in seconds, prevents hangs)`,
          `• Stop it → ${stopCmd}`,
        ].join("\n");

        resolve({ output, isError: false });
      }, backgroundAfterMs);
    }

    proc.on("error", (err) => {
      if (bgTimer) clearTimeout(bgTimer);
      if (settled) return;
      settled = true;
      resolve({ output: `Error: ${err.message}`, isError: true });
    });

    proc.on("close", (code, _sig) => {
      if (bgTimer) clearTimeout(bgTimer);

      // If backgrounded, append exit status to the temp file and close
      if (bgStream) {
        if (code !== 0 && code !== null) {
          bgStream.write(`\n[process exited with code ${code}]\n`);
        } else {
          bgStream.write(`\n[process exited successfully]\n`);
        }
        bgStream.end();
        bgStream = undefined;
        return;
      }

      if (settled) return;
      settled = true;

      let output = Buffer.concat(chunks).toString("utf8");

      // If output exceeds context budget, spill to file and return preview
      if (output.length > MAX_OUTPUT_CHARS) {
        output = spillAndPreview(output, byteTruncated);
      } else if (byteTruncated) {
        output += "\n... (output byte-truncated at 1MB)";
      }

      if (code !== 0 && code !== null) {
        output += `\n(exit code ${code})`;
      }

      resolve({ output, isError: code !== 0 && code !== null });
    });
  });
}

// ── Summary ────────────────────────────────────────────────────────

function summarize(input: Record<string, unknown>): ToolSummary {
  const command = getString(input, "command") ?? "";
  return { label: "$", detail: summarizeParams(command, input, ["command"]) };
}

// ── Tool definition ────────────────────────────────────────────────

const shellName = isWindows ? "PowerShell" : "bash";

export const bash: Tool = {
  name: "bash",
  description: `Execute a ${shellName} command. Returns stdout and stderr.`,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: `The ${shellName} command to execute` },
      timeout: { type: "number", description: "Timeout in milliseconds (default 3600000)" },
      await: { type: "number", description: "Seconds to wait before backgrounding this command. Use when you expect a command to take longer than the default threshold (e.g. builds, installs, watching a backgrounded process)." },
    },
    required: ["command"],
  },
  systemHint: `${shellName} commands that run longer than ${TOOL_BACKGROUND_SECONDS}s are automatically backgrounded: the process keeps running but control returns to you with the PID and a temp file where output accumulates. Pass the "await" parameter (seconds) to suppress backgrounding when you expect a command to take longer (builds, installs, sleeps, tailing a backgrounded process).`,
  display: {
    label: "$",
    color: "#d19a66",  // muted amber
  },
  summarize,
  execute: executeBash,
};
