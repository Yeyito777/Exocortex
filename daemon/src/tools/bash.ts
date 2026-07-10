/**
 * Bash tool — execute shell commands.
 *
 * Output protection: when stdout+stderr exceeds the inline output budget,
 * the full output is saved to a temp file and a head+tail preview is returned.
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
import type { Tool, ToolResult, ToolSummary, ToolExecutionContext } from "./types";
import { getString, getNumber, getBoolean, safeSlice, summarizeParams } from "./util";
import { TOOL_BACKGROUND_SECONDS } from "../constants";
import { formatToolAbortMessage } from "../abort";
import { isWindows } from "@exocortex/shared/paths";
import { rewriteExternalToolShellCommandForExecution } from "../external-tools";
import { log } from "../log";

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 3_600_000; // 1 hour
const MAX_OUTPUT_BYTES = 1_000_000;   // 1MB process capture limit
const DEFAULT_INLINE_OUTPUT_CHARS = 12_000;
const MIN_INLINE_OUTPUT_CHARS = 1_000;
const MAX_INLINE_OUTPUT_CHARS = 30_000;
const HEAD_PREVIEW_FRACTION = 0.7;

// ── Output limiting ───────────────────────────────────────────────

/** Truncate a single line if it exceeds the per-line budget. */
function truncLine(line: string, budget: number): string {
  if (line.length <= budget) return line;
  return safeSlice(line, budget) + `... [truncated, ${line.length} chars total]`;
}

function buildSpillPreview(
  output: string,
  byteTruncated: boolean,
  inlineBudget: number,
  spillPath?: string,
  spillError?: string,
): string {
  const lines = output.split("\n");
  const totalLines = lines.length;
  const headBudget = Math.max(1, Math.floor(inlineBudget * HEAD_PREVIEW_FRACTION));
  const tailBudget = Math.max(1, inlineBudget - headBudget);

  // Head: lines from the start, up to headBudget chars.
  // Individual lines longer than headBudget are truncated so a single
  // minified line can never blow through the budget.
  let headEnd = 0;
  let headChars = 0;
  while (headEnd < totalLines) {
    const lineCost = Math.min(lines[headEnd].length, headBudget) + 1;
    if (headChars + lineCost > headBudget && headEnd > 0) break;
    headChars += lineCost;
    headEnd++;
  }

  // Tail: lines from the end, up to tailBudget chars
  let tailStart = totalLines;
  let tailChars = 0;
  while (tailStart > headEnd) {
    const lineCost = Math.min(lines[tailStart - 1].length, tailBudget) + 1;
    if (tailChars + lineCost > tailBudget) break;
    tailStart--;
    tailChars += lineCost;
  }

  const omitted = tailStart - headEnd;
  const head = lines.slice(0, headEnd).map(l => truncLine(l, headBudget)).join("\n");
  const tail = tailStart < totalLines
    ? lines.slice(tailStart).map(l => truncLine(l, tailBudget)).join("\n")
    : "";

  const truncNote = byteTruncated ? ", byte-truncated at 1MB" : "";
  const fileNote = spillPath
    ? `Full output: ${spillPath}\nUse the read tool with offset/limit to browse.`
    : `Full output could not be written to a temp file${spillError ? ` (${spillError})` : ""}.`;
  const separator = `\n\n... ${omitted.toLocaleString()} lines omitted (${totalLines.toLocaleString()} total${truncNote}). ${fileNote}\n\n`;

  return tail ? head + separator + tail : head + separator;
}

function clampInlineOutputBudget(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_INLINE_OUTPUT_CHARS;
  return Math.min(
    MAX_INLINE_OUTPUT_CHARS,
    Math.max(MIN_INLINE_OUTPUT_CHARS, Math.floor(requested)),
  );
}

function inlineOutputBudget(input: Record<string, unknown>): number {
  return clampInlineOutputBudget(getNumber(input, "max_output_chars"));
}

/**
 * When output is too large for the conversation context, save the full
 * text to a temp file and return a head+tail preview with the file path.
 * If the temp-file write fails, degrade gracefully instead of crashing.
 */
export function spillAndPreviewForTest(
  output: string,
  byteTruncated: boolean,
  writer: (spillPath: string, contents: string) => void = writeFileSync,
  maxOutputChars = DEFAULT_INLINE_OUTPUT_CHARS,
): string {
  const inlineBudget = clampInlineOutputBudget(maxOutputChars);
  const spillPath = join(tmpdir(), `exocortex-bash-${Date.now()}.txt`);
  try {
    writer(spillPath, output);
    return buildSpillPreview(output, byteTruncated, inlineBudget, spillPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("warn", `bash: failed to spill oversized output to temp file: ${message}`);
    return buildSpillPreview(output, byteTruncated, inlineBudget, undefined, message);
  }
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
async function executeBash(input: Record<string, unknown>, _context?: ToolExecutionContext, signal?: AbortSignal): Promise<ToolResult> {
  return executeBashImpl(input, signal);
}

/**
 * Execute a bash command with backgrounding support.
 *
 * When the command doesn't finish in time, the promise resolves with
 * partial output + PID + temp file path. The process keeps running —
 * its output is written to the temp file.
 *
 * `background: true` detaches immediately after spawn. Otherwise, when the AI
 * passes `await` (seconds), it fully overrides the default background threshold
 * — even if shorter.
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
  context?: ToolExecutionContext,
): Promise<ToolResult> {
  const awaitSeconds = getNumber(input, "await");
  const backgroundImmediately = getBoolean(input, "background") === true;
  if (backgroundImmediately && awaitSeconds !== undefined) {
    return {
      output: "Error: 'background: true' cannot be combined with 'await'. Remove 'await' to background immediately.",
      isError: true,
    };
  }
  if (awaitSeconds !== undefined && (!Number.isFinite(awaitSeconds) || awaitSeconds <= 0)) {
    return {
      output: "Error: 'await' must be greater than 0 seconds. Use 'background: true' to background immediately.",
      isError: true,
    };
  }
  let bgMs: number | undefined;
  if (awaitSeconds !== undefined) {
    bgMs = awaitSeconds * 1000;
  } else {
    const command = getString(input, "command") ?? "";
    const cmdTrimmed = command.trimStart();
    const isLongRunning = LONG_RUNNING_COMMANDS.some(prefix => cmdTrimmed.startsWith(prefix));
    bgMs = isLongRunning ? LONG_RUNNING_BG_MS : defaultBgMs;
  }
  return executeBashImpl(input, signal, bgMs, context, backgroundImmediately);
}

async function executeBashImpl(
  input: Record<string, unknown>,
  signal?: AbortSignal,
  backgroundAfterMs?: number,
  context?: ToolExecutionContext,
  backgroundImmediately = false,
): Promise<ToolResult> {
  const command = getString(input, "command");
  if (!command) return { output: "Error: missing 'command' parameter", isError: true };
  const maxOutputChars = inlineOutputBudget(input);

  let rewrittenCommand: string;
  try {
    rewrittenCommand = isWindows ? command : await rewriteExternalToolShellCommandForExecution(command);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Error preparing external tool command: ${msg}`, isError: true };
  }
  const timeout = getNumber(input, "timeout") ?? DEFAULT_TIMEOUT_MS;

  const startTime = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(
      isWindows ? "powershell" : "bash",
      isWindows ? ["-NoProfile", "-Command", rewrittenCommand] : ["-c", rewrittenCommand],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(context?.conversationId ? { EXOCORTEX_PARENT_CONV_ID: context.conversationId } : {}),
          ...(context?.provider ? { EXOCORTEX_PARENT_PROVIDER: context.provider } : {}),
          ...(context?.model ? { EXOCORTEX_PARENT_MODEL: context.model } : {}),
        },
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
    let bgStreamFailed = false;
    let bgStreamError: string | undefined;
    let backgrounderCleared = false;
    let backgroundTaskTracked = false;

    function setBackgroundTaskTracked(active: boolean): void {
      if (!proc.pid || backgroundTaskTracked === active) return;
      backgroundTaskTracked = active;
      context?.setBackgroundTaskActive?.(`bash:${proc.pid}`, active);
    }

    function clearRegisteredBackgrounder(): void {
      if (backgrounderCleared) return;
      backgrounderCleared = true;
      context?.registerBackgrounder?.(null);
    }

    function markBgStreamFailed(err: unknown): void {
      const message = err instanceof Error ? err.message : String(err);
      log("warn", `bash: background output stream failed: ${message}`);
      bgStreamFailed = true;
      bgStreamError = message;
      if (bgStream) {
        bgStream.destroy();
        bgStream = undefined;
      }
    }

    function collect(data: Buffer): void {
      // After backgrounding, write to temp file instead of in-memory buffer.
      // If the temp file becomes unavailable, drop additional output rather than crashing.
      if (bgStream) {
        try {
          bgStream.write(data);
        } catch (err) {
          markBgStreamFailed(err);
        }
        return;
      }
      if (bgStreamFailed || byteTruncated) return;
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

    function backgroundNow(trigger: "timeout" | "manual" | "explicit"): boolean {
      if (settled || !proc.pid) return false;
      if (bgTimer) {
        clearTimeout(bgTimer);
        bgTimer = undefined;
      }
      settled = true;
      clearRegisteredBackgrounder();
      setBackgroundTaskTracked(true);

      const spillPath = join(tmpdir(), `exocortex-bash-${proc.pid}-${Date.now()}.tmp`);
      const partial = Buffer.concat(chunks).toString("utf8");

      try {
        // Open write stream and flush accumulated output to it.
        bgStream = createWriteStream(spillPath);
        bgStream.on("error", markBgStreamFailed);
        bgStream.write(partial);
        // New data events will now append to bgStream via collect()
      } catch (err) {
        markBgStreamFailed(err);
      }

      let preview = partial.trimEnd();
      if (preview.length > maxOutputChars) {
        preview = buildSpillPreview(
          preview,
          byteTruncated,
          maxOutputChars,
          bgStreamFailed ? undefined : spillPath,
          bgStreamError,
        );
      }
      let output = preview ? `${preview}\n\n` : "";
      const checkCmd = isWindows
        ? `bash "if (Get-Process -Id ${proc.pid} -ErrorAction SilentlyContinue) { 'running' } else { 'exited' }"`
        : `bash "kill -0 ${proc.pid} 2>/dev/null && echo running || echo exited"`;
      const stopCmd = isWindows
        ? `bash "taskkill /T /F /PID ${proc.pid}"`
        : `bash "kill ${proc.pid}"`;
      const headline = trigger === "explicit"
        ? `⏳ Command backgrounded immediately by request (PID ${proc.pid}).`
        : trigger === "manual"
          ? `⏳ Command backgrounded on user request after ${((Date.now() - startTime) / 1000).toFixed(1)}s (PID ${proc.pid}).`
          : `⏳ Command backgrounded — still running after ${Math.round((backgroundAfterMs ?? 0) / 1000)}s (PID ${proc.pid}).`;
      output += [
        headline,
        ...(bgStreamFailed
          ? [`Output could not be redirected to a temp file. Additional output may be unavailable.`]
          : [
              `Output is being written to: ${spillPath}`,
              `• View output so far → read tool on that file`,
              `• Wait for it to finish → ${isWindows ? `bash with command "Get-Content -Path '${spillPath}' -Wait -Tail 50" and await=N` : `bash with command "tail -f ${spillPath}" and await=N`} (where N is how long you're willing to wait in seconds, prevents hangs)`,
            ]),
        `• Check if still running → ${checkCmd}`,
        `• Stop it → ${stopCmd}`,
      ].join("\n");

      resolve({ output, isError: false });
      return true;
    }

    if (context?.registerBackgrounder) {
      context.registerBackgrounder({
        toolName: "bash",
        toolCallId: context.toolCallId,
        background: () => backgroundNow("manual"),
      });
    }

    // ── Abort handling: kill entire process group on signal ────
    // Resolves immediately with elapsed time + partial output so the
    // agent loop doesn't block. The process cleanup continues in the
    // background via killProcessGroup.
    if (signal) {
      const onAbort = () => {
        if (bgTimer) clearTimeout(bgTimer);
        clearRegisteredBackgrounder();
        if (proc.pid) killProcessGroup(proc.pid);
        if (bgStream) { bgStream.end(); bgStream = undefined; }
        if (settled) return;
        settled = true;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        let partial = Buffer.concat(chunks).toString("utf8").trimEnd();
        if (partial.length > maxOutputChars) {
          partial = spillAndPreviewForTest(partial, byteTruncated, writeFileSync, maxOutputChars);
        }
        const reason = formatToolAbortMessage(signal, elapsed);
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
        backgroundNow("timeout");
      }, backgroundAfterMs);
    }

    proc.on("error", (err) => {
      if (bgTimer) clearTimeout(bgTimer);
      clearRegisteredBackgrounder();
      setBackgroundTaskTracked(false);
      if (settled) return;
      settled = true;
      resolve({ output: `Error: ${err.message}`, isError: true });
    });

    proc.on("close", (code, _sig) => {
      if (bgTimer) clearTimeout(bgTimer);
      if (!bgStream) clearRegisteredBackgrounder();
      setBackgroundTaskTracked(false);

      // If backgrounded, append exit status to the temp file and close.
      // Stream failures are already reported via markBgStreamFailed; don't crash here.
      if (bgStream) {
        try {
          if (code !== 0 && code !== null) {
            bgStream.write(`\n[process exited with code ${code}]\n`);
          } else {
            bgStream.write(`\n[process exited successfully]\n`);
          }
          bgStream.end();
        } catch (err) {
          markBgStreamFailed(err);
        }
        bgStream = undefined;
        return;
      }

      if (settled) return;
      settled = true;

      let output = Buffer.concat(chunks).toString("utf8");

      // If output exceeds the inline budget, spill to file and return a compact preview.
      if (output.length > maxOutputChars) {
        output = spillAndPreviewForTest(output, byteTruncated, writeFileSync, maxOutputChars);
      } else if (byteTruncated) {
        output += "\n... (output byte-truncated at 1MB)";
      }

      if (code !== 0 && code !== null) {
        output += `\n(exit code ${code})`;
      }

      resolve({ output, isError: code !== 0 && code !== null });
    });

    // Defer until every stdout/stderr/error/close listener is installed, but do
    // not impose the one-second latency required by the old await=1 workaround.
    if (backgroundImmediately) queueMicrotask(() => backgroundNow("explicit"));
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
  parallelSafety: "exclusive",
  defaultTimeoutMs: null,
  watchdogExempt: true,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: `The ${shellName} command to execute` },
      timeout: { type: "number", description: "Timeout in milliseconds (default 3600000)" },
      background: { type: "boolean", description: "Background immediately after spawning and return the PID/output file without waiting. Cannot be combined with await." },
      await: { type: "number", description: "Seconds greater than 0 to wait before backgrounding this command. Cannot be combined with background=true." },
      max_output_chars: { type: "number", description: `Maximum command-output characters to include inline before spilling full output to a temp file (default ${DEFAULT_INLINE_OUTPUT_CHARS}, min ${MIN_INLINE_OUTPUT_CHARS}, max ${MAX_INLINE_OUTPUT_CHARS}).` },
    },
    required: ["command"],
  },
  systemHint: `${shellName} commands that run longer than ${TOOL_BACKGROUND_SECONDS}s are automatically backgrounded: the process keeps running but control returns to you with the PID and a temp file where output accumulates. Pass background=true to background immediately after spawning. Pass the "await" parameter (seconds greater than 0) to change how long to wait before backgrounding; do not combine background and await. Pass "max_output_chars" to limit inline output; larger output is saved to a temp file with a compact preview.`,
  display: {
    label: "$",
    color: "#d19a66",  // muted amber
  },
  summarize,
  execute: executeBash,
};
