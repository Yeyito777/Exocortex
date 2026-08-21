import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { runtimeDir } from "@exocortex/shared/paths";
import type { BackgroundTaskCompletion } from "./tools/types";

const RECORD_VERSION = 1;

export interface PersistedBackgroundTaskCompletion {
  endedAt: number;
  exitCode: number | null;
  signal: string | null;
  byteTruncated: boolean;
  outputError?: string;
  failure?: string;
}

export interface PersistedBackgroundTask {
  version: typeof RECORD_VERSION;
  state: "running" | "completed";
  taskId: string;
  ownerConversationId: string;
  toolName: "bash";
  title: string;
  startedAt: number;
  backgroundedAt: number;
  originDaemonPid: number;
  runnerPid: number;
  runnerStartTime?: string;
  pid: number;
  processStartTime?: string;
  outputPath: string;
  cwd: string;
  timeoutAt?: number;
  completion?: PersistedBackgroundTaskCompletion;
}

export interface BackgroundTaskRecoveryMetadata {
  recordPath: string;
  taskId: string;
  ownerConversationId: string;
  title: string;
  startedAt: number;
  backgroundedAt: number;
  originDaemonPid: number;
  outputPath: string;
  cwd: string;
  timeoutAt?: number;
}

export function backgroundTasksDir(): string {
  return join(runtimeDir(), "background-tasks");
}

function recordFileName(taskId: string): string {
  const readable = taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const digest = createHash("sha256").update(taskId).digest("hex").slice(0, 16);
  return `${readable}-${digest}.json`;
}

export function backgroundTaskRecordPath(taskId: string, directory = backgroundTasksDir()): string {
  return join(directory, recordFileName(taskId));
}

export function backgroundTaskSuppressionPath(recordPath: string): string {
  return `${recordPath}.suppress`;
}

export function suppressBackgroundTaskNotification(recordPath: string): void {
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(backgroundTaskSuppressionPath(recordPath), "suppressed\n", { mode: 0o600 });
}

export function restoreBackgroundTaskNotification(recordPath: string): void {
  try { rmSync(backgroundTaskSuppressionPath(recordPath), { force: true }); } catch { /* best effort */ }
}

export function isBackgroundTaskNotificationSuppressed(recordPath: string): boolean {
  return existsSync(backgroundTaskSuppressionPath(recordPath));
}

export function writeBackgroundTaskRecord(recordPath: string, record: PersistedBackgroundTask): void {
  mkdirSync(dirname(recordPath), { recursive: true });
  const temporaryPath = `${recordPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, recordPath);
}

function isRecord(value: unknown): value is PersistedBackgroundTask {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PersistedBackgroundTask>;
  return record.version === RECORD_VERSION
    && (record.state === "running" || record.state === "completed")
    && typeof record.taskId === "string"
    && typeof record.ownerConversationId === "string"
    && record.toolName === "bash"
    && typeof record.title === "string"
    && typeof record.startedAt === "number"
    && typeof record.backgroundedAt === "number"
    && typeof record.originDaemonPid === "number"
    && typeof record.runnerPid === "number"
    && typeof record.pid === "number"
    && typeof record.outputPath === "string"
    && typeof record.cwd === "string";
}

export function readBackgroundTaskRecord(recordPath: string): PersistedBackgroundTask | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function listBackgroundTaskRecordPaths(directory = backgroundTasksDir()): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
      .map(entry => join(directory, entry.name));
  } catch {
    return [];
  }
}

export function removeBackgroundTaskRecord(recordPath: string): void {
  try { rmSync(recordPath, { force: true }); } catch { /* best effort */ }
  restoreBackgroundTaskNotification(recordPath);
}

/** Linux process start ticks make persisted PIDs safe to act on after a restart. */
export function readProcessStartTime(pid: number): string | undefined {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    // The first token after comm is field 3 (state); starttime is field 22.
    return stat.slice(commandEnd + 2).trim().split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

export function processIdentityMatches(pid: number, expectedStartTime?: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === "linux") {
    const actual = readProcessStartTime(pid);
    return actual !== undefined && expectedStartTime !== undefined && actual === expectedStartTime;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function backgroundTaskCompletion(record: PersistedBackgroundTask): BackgroundTaskCompletion | null {
  if (record.state !== "completed" || !record.completion) return null;
  const completion = record.completion;
  return {
    taskId: record.taskId,
    toolName: record.toolName,
    title: record.title,
    startedAt: record.startedAt,
    endedAt: completion.endedAt,
    exitCode: completion.exitCode,
    signal: completion.signal,
    ...(completion.outputError || completion.failure ? {} : { outputPath: record.outputPath }),
    ...(completion.outputError ? { outputError: completion.outputError } : {}),
    ...(completion.failure ? { failure: completion.failure } : {}),
  };
}
