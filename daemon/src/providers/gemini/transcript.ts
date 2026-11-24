/**
 * The Antigravity CLI's own log of a session,
 * `brain/<session>/.system_generated/logs/transcript.jsonl` in its state
 * directory: one JSON line per step. ACP reports usage only when a prompt
 * ends, and says nothing when a command moves to the background; this log has
 * both, so a turn reads what the CLI appends to it while it runs:
 *
 * - each model call (`PLANNER_RESPONSE`) with its `output_tokens`, so tool
 *   rounds carry their tokens and the live tokens/s reads true;
 * - `Tool is running as a background task with task id: <id>` (a `GENERIC`
 *   step), with the command and the task's log file.
 *
 * Only appended bytes are read. A missing or unreadable file reads as empty.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { agyStateDir } from "./cli";

export interface AgyTranscriptStep {
  type?: string;
  output_tokens?: number;
  content?: string;
  /** When the step started, to the second (ISO). */
  created_at?: string;
}

export interface AgyBackgroundTask {
  taskId: string;
  description: string;
  logPath: string | null;
}

export function agyTranscriptPath(sessionId: string): string {
  return join(agyStateDir(), "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

const READ_CAP = 4 * 1024 * 1024;

export class AgyTranscriptReader {
  private offset: number;
  private rest = "";

  /** Starts at the file's current end: only steps after this point are read. */
  constructor(private readonly path: string) {
    this.offset = fileSize(path);
  }

  /** Steps appended since the last read. */
  read(): AgyTranscriptStep[] {
    const size = fileSize(this.path);
    if (size < this.offset) {
      // Rewritten (a compaction): read on from its new end.
      this.offset = size;
      this.rest = "";
      return [];
    }
    if (size === this.offset) return [];
    let text = "";
    let fd: number | null = null;
    try {
      fd = openSync(this.path, "r");
      const length = Math.min(size - this.offset, READ_CAP);
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, this.offset);
      this.offset += read;
      text = buffer.subarray(0, read).toString("utf8");
    } catch {
      return [];
    } finally {
      if (fd !== null) closeSync(fd);
    }
    const lines = (this.rest + text).split("\n");
    this.rest = lines.pop() ?? "";
    const steps: AgyTranscriptStep[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const step = JSON.parse(line) as unknown;
        if (step && typeof step === "object") steps.push(step as AgyTranscriptStep);
      } catch { /* a partial or foreign line */ }
    }
    return steps;
  }
}

export function modelCallTokens(step: AgyTranscriptStep): number {
  return step.type === "PLANNER_RESPONSE" && typeof step.output_tokens === "number" && step.output_tokens > 0 ? step.output_tokens : 0;
}

/** When a step started (ms), or null. The CLI logs it to the second. */
export function stepStartedAt(step: AgyTranscriptStep): number | null {
  const at = typeof step.created_at === "string" ? Date.parse(step.created_at) : NaN;
  return Number.isFinite(at) ? at : null;
}

const BACKGROUND_RE = /Tool is running as a background task with task id: (\S+)/;

/** The background task a step announces, if it does. */
export function backgroundTaskOf(step: AgyTranscriptStep): AgyBackgroundTask | null {
  if (typeof step.content !== "string") return null;
  const match = BACKGROUND_RE.exec(step.content);
  if (!match) return null;
  const after = step.content.slice(match.index + match[0].length);
  const description = /\nTask Description: ([\s\S]*?)(?:\nTask logs are available at: |\nLog output:|$)/.exec(after)?.[1]?.trim() ?? "";
  const log = /Task logs are available at: file:\/\/(\S+)/.exec(after)?.[1] ?? null;
  return { taskId: match[1], description, logPath: log };
}
