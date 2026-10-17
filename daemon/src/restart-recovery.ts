import { log } from "./log";
import {
  clearActiveGoalRestartMarker,
  clearInterruptedStreamIds,
  consumeActiveGoalRestartMarker,
  normalizeConvIds,
  PREPARE_RESTART_MAX_SETTLE_MS,
  readInterruptedStreamIds,
  writeInterruptedStreamIds,
} from "./restart-markers";
import { orchestrateGoalCycle, orchestrateReplayConversation, orchestrateSendMessage } from "./orchestrator";
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

export {
  activeGoalRestartPath,
  clearActiveGoalRestartMarker,
  clearInterruptedStreamIds,
  consumeActiveGoalRestartMarker,
  hasActiveGoalRestartMarker,
  interruptedStreamsPath,
  readInterruptedStreamIds,
  writeActiveGoalRestartMarker,
  writeInterruptedStreamIds,
} from "./restart-markers";

export interface PrepareShutdownReplayResult {
  convIds: string[];
  stillStreaming: string[];
}

/**
 * Interrupted turns usually settle within tens of milliseconds and these
 * checks are in-memory, so poll finely: the old 250ms step was most of the
 * graceful-restart time whenever anything was streaming.
 */
const SHUTDOWN_SETTLE_POLL_MS = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cancel every daemon-owned source of autonomous work on a later startup. */
export function clearRestartRecoveryForStop(): number {
  clearInterruptedStreamIds();
  clearActiveGoalRestartMarker();
  return clearPendingSubagentNotifications();
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
export async function prepareCatchableShutdownForReplay(timeoutMs = PREPARE_RESTART_MAX_SETTLE_MS): Promise<PrepareShutdownReplayResult> {
  const interrupted = new Set<string>();
  try {
    for (const id of readInterruptedStreamIds()) interrupted.add(id);
  } catch {
    // If the file is corrupt, overwrite it below with the currently observed streams.
  }

  const record = (ids: string[]): void => {
    const before = interrupted.size;
    for (const id of ids) interrupted.add(id);
    if (interrupted.size > before) writeInterruptedStreamIds(interrupted);
  };

  const abortRunning = (ids: string[]): void => {
    for (const id of ids) {
      const ac = convStore.getActiveJob(id);
      if (!ac || ac.signal.aborted) continue;
      ac.abort("daemon-restart");
    }
  };

  let stillStreaming = convStore.listRunningConversationIds();
  record(convStore.listRestartRecoverableConversationIds());
  abortRunning(stillStreaming);

  const deadline = Date.now() + timeoutMs;
  while (stillStreaming.length > 0 && Date.now() < deadline) {
    const delayMs = Math.min(SHUTDOWN_SETTLE_POLL_MS, Math.max(0, deadline - Date.now()));
    if (delayMs > 0) await sleep(delayMs);
    stillStreaming = convStore.listRunningConversationIds();
    record(convStore.listRestartRecoverableConversationIds());
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
      // Queued user intent is durable and survives both stop and restart. Only
      // autonomous continuation requests are intentionally discarded here.
      convStore.clearGoalContinuationAfterStream(id);
      const ac = convStore.getActiveJob(id);
      if (ac && !ac.signal.aborted) ac.abort("daemon-stop");
    }
  };

  let stillStreaming = convStore.listRunningConversationIds();
  stopRunning(stillStreaming);
  const deadline = Date.now() + timeoutMs;
  while (stillStreaming.length > 0 && Date.now() < deadline) {
    const delayMs = Math.min(SHUTDOWN_SETTLE_POLL_MS, Math.max(0, deadline - Date.now()));
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
    server.broadcastLegacyTokenStats(getTokenStatsSnapshot);
  };

  return {
    onHeaders: (headers: Headers) => {
      const provider = convStore.getIndexedSummary(convId)?.provider ?? getDefaultProvider().id;
      handleUsageHeaders(provider, headers, (usage) => broadcastUsage(provider, usage));
    },
    onComplete: () => {
      const provider = convStore.getIndexedSummary(convId)?.provider ?? getDefaultProvider().id;
      refreshUsage(provider, (usage) => broadcastUsage(provider, usage));
      broadcastTokenStats();
    },
    exocortex: getExocortexToolRuntime(server),
  };
}

/** `alsoReplay`: conversations to replay even if no stream was recorded as interrupted. */
export function recoverInterruptedStreams(server: DaemonServer, alsoReplay: readonly string[] = []): string[] {
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
  convIds = normalizeConvIds([...convIds, ...alsoReplay]);

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
    if (!record.trackAsSubagent) continue;
    const childTitle = convStore.getIndexedSummary(record.childConvId)?.title.trim()
      || record.task.split("\n")[0].replace(/\s+/g, " ").trim()
      || "Subagent task";
    if (setSubagentActive(record.parentConvId, record.childConvId, true, {
      title: childTitle,
      startedAt: record.childStartedAt,
    })) {
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
    if (!convStore.hasConversation(convId)) {
      log("warn", `restart-recovery: interrupted conversation ${convId} no longer exists; skipping`);
      const orphaned = runningNotifications.find((record) => record.childConvId === convId);
      if (orphaned) {
        settlePendingSubagentNotifications(convId, {
          ok: false,
          blocks: [],
          error: `Subagent conversation ${convId} no longer exists after restart.`,
        });
        if (orphaned.trackAsSubagent && setSubagentActive(orphaned.parentConvId, convId, false)) {
          broadcastConversationUpdated(server, orphaned.parentConvId);
        }
      }
      continue;
    }
    if (convStore.isStreaming(convId)) {
      // E.g. a queued message admitted into an adopted Claude Code process. A
      // pending subagent notification still completes when that turn ends: the
      // orchestrator hands every turn's outcome to the notification runtime.
      log("warn", `restart-recovery: interrupted conversation ${convId} is already streaming; skipping`);
      continue;
    }

    scheduled.push(convId);
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
            {
              subagentMaxDepth: pendingNotification.subagentMaxDepth,
              automation: {
                kind: "exo_send",
                sourceId: pendingNotification.parentConvId,
              },
            },
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
    // Always restore the interrupted turn itself first, including when the
    // conversation has an active goal. A successful replay will schedule the
    // ordinary post-turn continuation from the orchestrator finalizer.
    // Starting with a fresh goal continuation here would instead skip the interrupted
    // worker turn entirely.
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
    // The summary index already carries goal state. Do not parse every canonical
    // transcript on boot just to reject virtually all of them.
    if (summary.goal?.status !== "active") continue;
    if (convStore.getIndexedSummary(convId)?.goal?.status !== "active") continue;
    if (convStore.isStreaming(convId)) continue;
    if (convStore.getQueuedMessages(convId).length > 0) continue;

    scheduled.push(convId);
    log("info", `restart-recovery: resuming active goal ${convId}`);
    void orchestrateGoalCycle(server, convId, buildRecoveryCallbacks(server, convId)).then((outcome) => {
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
