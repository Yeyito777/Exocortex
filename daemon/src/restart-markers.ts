/**
 * Restart-recovery marker files in the runtime directory.
 *
 * Kept free of daemon imports: the service wrapper's control process writes
 * these too, and loading the daemon's module graph there cost ~200ms of every
 * restart.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { runtimeDir } from "@exocortex/shared/paths";
import { log } from "./log";

/** Longest a restart waits for interrupted turns to settle before replaying from saved history. */
export const PREPARE_RESTART_MAX_SETTLE_MS = 30_000;

const INTERRUPTED_STREAMS_FILE_VERSION = 1;
const ACTIVE_GOAL_RESTART_FILE_VERSION = 1;

interface InterruptedStreamsFile {
  version: typeof INTERRUPTED_STREAMS_FILE_VERSION;
  createdAt: number;
  reason: "restart";
  convIds: string[];
}

interface ActiveGoalRestartFile {
  version: typeof ACTIVE_GOAL_RESTART_FILE_VERSION;
  createdAt: number;
  reason: "daemon-restart";
}

export function interruptedStreamsPath(): string {
  return join(runtimeDir(), "interrupted-streams.json");
}

export function activeGoalRestartPath(): string {
  return join(runtimeDir(), "active-goal-restart.json");
}

export function normalizeConvIds(convIds: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of convIds) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function readInterruptedStreamIds(): string[] {
  const path = interruptedStreamsPath();
  if (!existsSync(path)) return [];

  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<InterruptedStreamsFile>;
  if (!Array.isArray(parsed.convIds)) {
    throw new Error(`Malformed interrupted streams file at ${path}: missing convIds array`);
  }
  return normalizeConvIds(parsed.convIds);
}

export function writeInterruptedStreamIds(convIds: Iterable<string>): string[] {
  const ids = normalizeConvIds(convIds);
  const path = interruptedStreamsPath();

  if (ids.length === 0) {
    clearInterruptedStreamIds();
    return ids;
  }

  mkdirSync(dirname(path), { recursive: true });
  const payload: InterruptedStreamsFile = {
    version: INTERRUPTED_STREAMS_FILE_VERSION,
    createdAt: Date.now(),
    reason: "restart",
    convIds: ids,
  };
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n");
  renameSync(tmpPath, path);
  return ids;
}

export function clearInterruptedStreamIds(): void {
  try { unlinkSync(interruptedStreamsPath()); } catch { /* absent */ }
}

export function writeActiveGoalRestartMarker(): void {
  const path = activeGoalRestartPath();
  mkdirSync(dirname(path), { recursive: true });
  const payload: ActiveGoalRestartFile = {
    version: ACTIVE_GOAL_RESTART_FILE_VERSION,
    createdAt: Date.now(),
    reason: "daemon-restart",
  };
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n");
  renameSync(tmpPath, path);
}

export function clearActiveGoalRestartMarker(): void {
  try { unlinkSync(activeGoalRestartPath()); } catch { /* absent */ }
}

export function hasActiveGoalRestartMarker(): boolean {
  const path = activeGoalRestartPath();
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ActiveGoalRestartFile>;
    return parsed.version === ACTIVE_GOAL_RESTART_FILE_VERSION && parsed.reason === "daemon-restart";
  } catch (err) {
    log("warn", `restart-recovery: cannot read active-goal restart marker: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

export function consumeActiveGoalRestartMarker(): boolean {
  const path = activeGoalRestartPath();
  if (!existsSync(path)) return false;

  try {
    return hasActiveGoalRestartMarker();
  } finally {
    clearActiveGoalRestartMarker();
  }
}
