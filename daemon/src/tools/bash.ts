/**
 * Bash tool — execute shell commands.
 *
 * Output protection: when stdout+stderr exceeds ~30K characters, the full
 * output is saved to a temp file and a head+tail preview is returned.
 * The agent can use the read tool to paginate through the full output.
 */

import { spawn } from "child_process";
import { writeFileSync } from "fs";
import type { Tool, ToolResult, ToolSummary } from "./types";
import { MAX_OUTPUT_CHARS } from "./util";

// ── Constants ──────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 3_600_000; // 1 hour
const MAX_OUTPUT_BYTES = 1_000_000;   // 1MB process capture limit
const HEAD_BUDGET = 20_000;           // chars for head preview
const TAIL_BUDGET = 8_000;            // chars for tail preview

// ── Output limiting ───────────────────────────────────────────────

/**
 * When output is too large for the conversation context, save the full
 * text to a temp file and return a head+tail preview with the file path.
 */
function spillAndPreview(output: string, byteTruncated: boolean): string {
  const spillPath = `/tmp/exocortex-bash-${Date.now()}.txt`;
  writeFileSync(spillPath, output);

  const lines = output.split("\n");
  const totalLines = lines.length;

  // Head: lines from the start, up to HEAD_BUDGET chars
  let headEnd = 0;
  let headChars = 0;
  while (headEnd < totalLines) {
    const cost = lines[headEnd].length + 1;
    if (headChars + cost > HEAD_BUDGET && headEnd > 0) break;
    headChars += cost;
    headEnd++;
  }

  // Tail: lines from the end, up to TAIL_BUDGET chars
  let tailStart = totalLines;
  let tailChars = 0;
  while (tailStart > headEnd) {
    const cost = lines[tailStart - 1].length + 1;
    if (tailChars + cost > TAIL_BUDGET) break;
    tailStart--;
    tailChars += cost;
  }

  const omitted = tailStart - headEnd;
  const head = lines.slice(0, headEnd).join("\n");
  const tail = tailStart < totalLines ? lines.slice(tailStart).join("\n") : "";

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
 */
function killProcessGroup(pid: number): void {
  try { process.kill(-pid, "SIGTERM"); } catch {}
  setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }, KILL_GRACE_MS);
}

// ── Execution ──────────────────────────────────────────────────────

async function executeBash(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const command = input.command as string;
  if (!command) return { output: "Error: missing 'command' parameter", isError: true };

  const timeout = (input.timeout as number) ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", command], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      detached: true,   // own process group so we can kill the entire tree
    });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let byteTruncated = false;

    function collect(data: Buffer): void {
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
    if (signal) {
      const onAbort = () => { if (proc.pid) killProcessGroup(proc.pid); };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
        proc.on("close", () => signal.removeEventListener("abort", onAbort));
      }
    }

    proc.on("error", (err) => {
      resolve({ output: `Error: ${err.message}`, isError: true });
    });

    proc.on("close", (code, sig) => {
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
  const command = (input.command as string) ?? "";
  return { label: "$", detail: command.slice(0, 200) };
}

// ── Tool definition ────────────────────────────────────────────────

export const bash: Tool = {
  name: "bash",
  description: "Execute a bash command. Returns stdout and stderr.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The bash command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default 3600000)" },
    },
    required: ["command"],
  },
  systemHint: undefined,
  display: {
    label: "$",
    color: "#d19a66",  // muted amber
  },
  summarize,
  execute: executeBash,
};
