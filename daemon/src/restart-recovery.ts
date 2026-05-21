import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { runtimeDir } from "@exocortex/shared/paths";
import { log } from "./log";
import { orchestrateGoalContinuation, orchestrateReplayConversation } from "./orchestrator";
import type { DaemonServer } from "./server";
import * as convStore from "./conversations";
import { handleUsageHeaders, refreshUsage } from "./usage";
import { getDefaultProvider } from "./providers/registry";
import { getTokenStatsSnapshot } from "./token-stats";

const INTERRUPTED_STREAMS_FILE_VERSION = 1;

interface InterruptedStreamsFile {
  version: typeof INTERRUPTED_STREAMS_FILE_VERSION;
  createdAt: number;
  reason: "restart";
  convIds: string[];
}

export interface PrepareShutdownReplayResult {
  convIds: string[];
  stillStreaming: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function interruptedStreamsPath(): string {
  return join(runtimeDir(), "interrupted-streams.json");
}

function normalizeConvIds(convIds: Iterable<string>): string[] {
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

/**
 * Preserve active stream progress before this daemon exits because of a
 * catchable shutdown signal.
 *
 * This is the in-process sibling of the `prepare-restart` control command: it
 * records running conversations in the restart-recovery file, aborts their
 * active jobs with the daemon-restart reason so orchestrators persist
 * salvageable partial turns, and waits briefly for those orchestrators to run
 * their normal cleanup path. If a stream refuses to stop before the deadline,
 * the recovery file is still enough for the next daemon to replay from the
 * persisted history.
 */
export async function prepareCatchableShutdownForReplay(timeoutMs = 30_000): Promise<PrepareShutdownReplayResult> {
  const interrupted = new Set<string>();
  try {
    for (const id of readInterruptedStreamIds()) interrupted.add(id);
  } catch {
    // If the file is corrupt, overwrite it below with the currently observed streams.
  }

  const record = (ids: string[]): void => {
    if (ids.length === 0) return;
    for (const id of ids) interrupted.add(id);
    writeInterruptedStreamIds(interrupted);
  };

  const abortRunning = (ids: string[]): void => {
    for (const id of ids) {
      const ac = convStore.getActiveJob(id);
      if (!ac || ac.signal.aborted) continue;
      ac.abort("daemon-restart");
    }
  };

  let stillStreaming = convStore.listRunningConversationIds();
  record(stillStreaming);
  abortRunning(stillStreaming);

  const deadline = Date.now() + timeoutMs;
  while (stillStreaming.length > 0 && Date.now() < deadline) {
    const delayMs = Math.min(250, Math.max(0, deadline - Date.now()));
    if (delayMs > 0) await sleep(delayMs);
    stillStreaming = convStore.listRunningConversationIds();
    record(stillStreaming);
    abortRunning(stillStreaming);
  }

  if (interrupted.size > 0) writeInterruptedStreamIds(interrupted);

  return {
    convIds: [...interrupted],
    stillStreaming,
  };
}

function buildRecoveryCallbacks(server: DaemonServer, convId: string) {
  const broadcastUsage = (provider: import("./messages").ProviderId, usage: import("./messages").UsageData | null) => {
    server.broadcast({ type: "usage_update", provider, usage });
  };
  const broadcastTokenStats = () => {
    server.broadcast({ type: "token_stats", stats: getTokenStatsSnapshot() });
  };

  return {
    onHeaders: (headers: Headers) => {
      const provider = convStore.get(convId)?.provider ?? getDefaultProvider().id;
      handleUsageHeaders(provider, headers, (usage) => broadcastUsage(provider, usage));
    },
    onComplete: () => {
      const provider = convStore.get(convId)?.provider ?? getDefaultProvider().id;
      refreshUsage(provider, (usage) => broadcastUsage(provider, usage));
      broadcastTokenStats();
    },
  };
}

export function recoverInterruptedStreams(server: DaemonServer): string[] {
  let convIds: string[];
  try {
    convIds = readInterruptedStreamIds();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", `restart-recovery: cannot read interrupted streams file: ${message}`);
    clearInterruptedStreamIds();
    return [];
  }

  if (convIds.length === 0) {
    clearInterruptedStreamIds();
    return [];
  }

  // Clear once we have captured the work list. This avoids an infinite replay
  // loop if a recovered replay itself errors or the daemon is restarted again.
  clearInterruptedStreamIds();

  const scheduled: string[] = [];
  for (const convId of convIds) {
    if (!convStore.get(convId)) {
      log("warn", `restart-recovery: interrupted conversation ${convId} no longer exists; skipping`);
      continue;
    }
    if (convStore.isStreaming(convId)) {
      log("warn", `restart-recovery: interrupted conversation ${convId} is already streaming; skipping`);
      continue;
    }

    scheduled.push(convId);
    const conv = convStore.get(convId);
    const callbacks = buildRecoveryCallbacks(server, convId);
    if (conv?.goal?.status === "active") {
      log("info", `restart-recovery: continuing interrupted active goal ${convId}`);
      void orchestrateGoalContinuation(server, convId, callbacks).then((outcome) => {
        if (outcome.ok) {
          log("info", `restart-recovery: goal continuation completed for ${convId}`);
        } else {
          log("warn", `restart-recovery: goal continuation did not complete for ${convId}: ${outcome.error ?? "unknown error"}`);
        }
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log("error", `restart-recovery: goal continuation failed for ${convId}: ${message}`);
      });
    } else {
      log("info", `restart-recovery: replaying interrupted conversation ${convId}`);
      void orchestrateReplayConversation(
        server,
        null,
        undefined,
        convId,
        Date.now(),
        callbacks,
      ).then((outcome) => {
        if (outcome.ok) {
          log("info", `restart-recovery: replay completed for ${convId}`);
        } else {
          log("warn", `restart-recovery: replay did not complete for ${convId}: ${outcome.error ?? "unknown error"}`);
        }
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log("error", `restart-recovery: replay failed for ${convId}: ${message}`);
      });
    }
  }

  if (scheduled.length > 0) {
    log("info", `restart-recovery: scheduled ${scheduled.length} interrupted conversation replay(s): ${scheduled.join(", ")}`);
  }

  return scheduled;
}

export function recoverActiveGoals(server: DaemonServer, excludeConvIds: Iterable<string> = []): string[] {
  const excluded = new Set(excludeConvIds);
  const scheduled: string[] = [];

  for (const summary of convStore.listSummaries()) {
    const convId = summary.id;
    if (excluded.has(convId)) continue;
    const conv = convStore.get(convId);
    if (conv?.goal?.status !== "active") continue;
    if (convStore.isStreaming(convId)) continue;
    if (convStore.getQueuedMessages(convId).length > 0) continue;

    scheduled.push(convId);
    log("info", `restart-recovery: resuming active goal ${convId}`);
    void orchestrateGoalContinuation(server, convId, buildRecoveryCallbacks(server, convId)).then((outcome) => {
      if (outcome.ok) {
        log("info", `restart-recovery: resumed goal completed for ${convId}`);
      } else {
        log("warn", `restart-recovery: resumed goal did not complete for ${convId}: ${outcome.error ?? "unknown error"}`);
      }
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log("error", `restart-recovery: resumed goal failed for ${convId}: ${message}`);
    });
  }

  if (scheduled.length > 0) {
    log("info", `restart-recovery: scheduled ${scheduled.length} active goal continuation(s): ${scheduled.join(", ")}`);
  }

  return scheduled;
}
