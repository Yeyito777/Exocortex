import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { runtimeDir } from "@exocortex/shared/paths";
import { log } from "./log";
import { orchestrateGoalContinuation, orchestrateReplayConversation, orchestrateSendMessage } from "./orchestrator";
import type { DaemonServer } from "./server";
import * as convStore from "./conversations";
import { handleUsageHeaders, refreshUsage } from "./usage";
import { getDefaultProvider } from "./providers/registry";
import { getTokenStatsSnapshot } from "./token-stats";
import { getExocortexToolRuntime } from "./exocortex-tool-runtime";
import { broadcastConversationUpdated } from "./conversation-events";
import { setSubagentActive } from "./conversation-activity";
import {
  clearPendingSubagentNotifications,
  completedSubagentOutcomeFromHistory,
  getSubagentNotificationRuntime,
  hasSubagentTaskStarted,
  listPendingSubagentNotifications,
  settlePendingSubagentNotifications,
} from "./subagent-notifications";

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

export function activeGoalRestartPath(): string {
  return join(runtimeDir(), "active-goal-restart.json");
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

/** Cancel every daemon-owned source of autonomous work on a later startup. */
export function clearRestartRecoveryForStop(): number {
  clearInterruptedStreamIds();
  clearActiveGoalRestartMarker();
  return clearPendingSubagentNotifications();
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

/**
 * Stop the daemon without scheduling any autonomous work for its next start.
 * Active turns are still aborted through the normal orchestrator cleanup path
 * so salvageable transcript state is flushed, but restart markers, queues,
 * goals-after-stream requests, and durable subagent deliveries are cancelled.
 */
export async function prepareCatchableShutdownWithoutReplay(timeoutMs = 5_000): Promise<PrepareShutdownReplayResult> {
  clearRestartRecoveryForStop();

  const interrupted = new Set<string>();
  const stopRunning = (ids: string[]): void => {
    for (const id of ids) {
      interrupted.add(id);
      convStore.clearQueuedMessages(id);
      convStore.clearGoalContinuationAfterStream(id);
      const ac = convStore.getActiveJob(id);
      if (ac && !ac.signal.aborted) ac.abort("daemon-stop");
    }
  };

  let stillStreaming = convStore.listRunningConversationIds();
  stopRunning(stillStreaming);
  const deadline = Date.now() + timeoutMs;
  while (stillStreaming.length > 0 && Date.now() < deadline) {
    const delayMs = Math.min(250, Math.max(0, deadline - Date.now()));
    if (delayMs > 0) await sleep(delayMs);
    stillStreaming = convStore.listRunningConversationIds();
    stopRunning(stillStreaming);
  }

  // A stop always wins over stale/partially prepared restart state.
  clearRestartRecoveryForStop();
  return { convIds: [...interrupted], stillStreaming };
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
    exocortex: getExocortexToolRuntime(server),
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
    // Durable subagent records below remain independently recoverable even if
    // the generic interrupted-stream marker was damaged.
    convIds = [];
  }

  const persistedRunningNotifications = listPendingSubagentNotifications({ state: "running" });
  const completedBeforeSettlement = new Set<string>();
  const runningNotifications = persistedRunningNotifications.filter((record) => {
    const completedOutcome = completedSubagentOutcomeFromHistory(record);
    if (!completedOutcome) return true;
    settlePendingSubagentNotifications(record.childConvId, completedOutcome);
    completedBeforeSettlement.add(record.childConvId);
    log("info", `restart-recovery: recovered completed subagent outcome from durable history for ${record.childConvId}`);
    return false;
  });
  if (completedBeforeSettlement.size > 0) {
    convIds = convIds.filter((convId) => !completedBeforeSettlement.has(convId));
  }
  convIds = normalizeConvIds([...convIds, ...runningNotifications.map((record) => record.childConvId)]);
  for (const record of runningNotifications) {
    if (setSubagentActive(record.parentConvId, record.childConvId, true)) {
      broadcastConversationUpdated(server, record.parentConvId);
    }
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
      const orphaned = runningNotifications.find((record) => record.childConvId === convId);
      if (orphaned) {
        settlePendingSubagentNotifications(convId, {
          ok: false,
          blocks: [],
          error: `Subagent conversation ${convId} no longer exists after restart.`,
        });
        if (setSubagentActive(orphaned.parentConvId, convId, false)) {
          broadcastConversationUpdated(server, orphaned.parentConvId);
        }
      }
      continue;
    }
    if (convStore.isStreaming(convId)) {
      log("warn", `restart-recovery: interrupted conversation ${convId} is already streaming; skipping`);
      continue;
    }

    scheduled.push(convId);
    const conv = convStore.get(convId);
    const callbacks = buildRecoveryCallbacks(server, convId);
    const pendingNotification = runningNotifications.find((record) => record.childConvId === convId);
    if (pendingNotification) {
      const taskAlreadyStarted = hasSubagentTaskStarted(pendingNotification);
      log("info", `restart-recovery: ${taskAlreadyStarted ? "replaying" : "restoring"} interrupted subagent ${convId} for parent ${pendingNotification.parentConvId}`);
      const turn = taskAlreadyStarted
        ? orchestrateReplayConversation(
            server,
            null,
            undefined,
            convId,
            Date.now(),
            callbacks,
            { subagentMaxDepth: pendingNotification.subagentMaxDepth },
          )
        : orchestrateSendMessage(
            server,
            null,
            undefined,
            convId,
            pendingNotification.task,
            pendingNotification.childStartedAt,
            callbacks,
            undefined,
            { subagentMaxDepth: pendingNotification.subagentMaxDepth },
          );
      void turn.then((outcome) => {
        getSubagentNotificationRuntime(server)?.complete(convId, outcome);
        if (outcome.ok) {
          log("info", `restart-recovery: subagent replay completed for ${convId}`);
        } else {
          log("warn", `restart-recovery: subagent replay did not complete for ${convId}: ${outcome.error ?? "unknown error"}`);
        }
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log("error", `restart-recovery: subagent replay failed for ${convId}: ${message}`);
        getSubagentNotificationRuntime(server)?.complete(convId, {
          ok: false,
          blocks: [],
          error: `✗ ${message}`,
        });
      });
      continue;
    }
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

/** Queue/send every completed child notification after interrupted parents start replaying. */
export function deliverPendingSubagentNotifications(server: DaemonServer): number {
  const ready = listPendingSubagentNotifications({ state: "ready" });
  getSubagentNotificationRuntime(server)?.deliverReady();
  return ready.length;
}

export function recoverActiveGoals(server: DaemonServer, excludeConvIds: Iterable<string> = []): string[] {
  if (!consumeActiveGoalRestartMarker()) return [];

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
