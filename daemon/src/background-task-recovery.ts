import {
  backgroundTaskCompletion,
  backgroundTasksDir,
  isBackgroundTaskNotificationSuppressed,
  listBackgroundTaskRecordPaths,
  processIdentityMatches,
  readBackgroundTaskRecord,
  removeBackgroundTaskRecord,
  suppressBackgroundTaskNotification,
  writeBackgroundTaskRecord,
  type PersistedBackgroundTask,
} from "./background-task-state";
import {
  setBackgroundTaskActive,
} from "./conversation-activity";
import * as convStore from "./conversations";
import { log } from "./log";
import { killProcessGroup, trackRecoveredBackgroundProcess, untrackRecoveredBackgroundProcess } from "./tools/bash";
import type { BackgroundTaskCompletion } from "./tools/types";

export interface BackgroundTaskRecoveryCallbacks {
  onConversationChanged(convId: string): void;
  onComplete(convId: string, completion: BackgroundTaskCompletion): void;
}

export interface BackgroundTaskRecoveryOptions {
  directory?: string;
  daemonPid?: number;
  pollMs?: number;
  hasConversation?: (convId: string) => boolean;
  hasDeliveredCompletion?: (convId: string, taskId: string) => boolean;
}

interface AdoptedTask {
  recordPath: string;
  record: PersistedBackgroundTask;
}

const CURRENT_DAEMON_COMPLETION_GRACE_MS = 1_000;

/**
 * Rebuilds the daemon's ephemeral task catalog from independently-owned runners.
 * Completion delivery is explicitly enabled after interrupted streams have been
 * scheduled, so a task that finishes during downtime cannot race its parent replay.
 */
export class BackgroundTaskRecovery {
  private readonly directory: string;
  private readonly daemonPid: number;
  private readonly pollMs: number;
  private readonly hasConversation: (convId: string) => boolean;
  private readonly hasDeliveredCompletion: (convId: string, taskId: string) => boolean;
  private readonly adopted = new Map<string, AdoptedTask>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private deliveryEnabled = false;
  private scanning = false;

  constructor(
    private readonly callbacks: BackgroundTaskRecoveryCallbacks,
    options: BackgroundTaskRecoveryOptions = {},
  ) {
    this.directory = options.directory ?? backgroundTasksDir();
    this.daemonPid = options.daemonPid ?? process.pid;
    this.pollMs = options.pollMs ?? 250;
    this.hasConversation = options.hasConversation ?? ((convId) => convStore.hasConversation(convId));
    this.hasDeliveredCompletion = options.hasDeliveredCompletion ?? ((convId, taskId) => {
      const conversation = convStore.get(convId);
      if (conversation?.messages.some(message => (
        message.metadata?.automation?.kind === "background_task_completion"
        && message.metadata.automation.sourceId === taskId
      ))) return true;
      return convStore.getQueuedMessages(convId).some(message => (
        message.automation?.kind === "background_task_completion"
        && message.automation.sourceId === taskId
      ));
    });
  }

  start(): number {
    this.scan();
    if (!this.timer) {
      this.timer = setInterval(() => this.scan(), this.pollMs);
      this.timer.unref?.();
    }
    return this.adopted.size;
  }

  enableCompletionDelivery(): void {
    this.deliveryEnabled = true;
    this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  scan(): void {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const present = new Set<string>();
      for (const recordPath of listBackgroundTaskRecordPaths(this.directory)) {
        present.add(recordPath);
        let record = readBackgroundTaskRecord(recordPath);
        if (!record) {
          log("warn", `background-task-recovery: removing malformed task record ${recordPath}`);
          removeBackgroundTaskRecord(recordPath);
          continue;
        }

        // The originating daemon still has the runner's live IPC channel and
        // owns its normal completion callback. Adoption starts only after PID
        // generation changes.
        if (record.originDaemonPid === this.daemonPid) {
          if (record.state === "running") continue;
          const endedAt = record.completion?.endedAt ?? Date.now();
          if (Date.now() - endedAt < CURRENT_DAEMON_COMPLETION_GRACE_MS) continue;
        }

        if (!this.hasConversation(record.ownerConversationId)) {
          this.stopOrphan(recordPath, record);
          continue;
        }

        if (record.state === "running") {
          const runnerAlive = processIdentityMatches(record.runnerPid, record.runnerStartTime);
          const commandAlive = processIdentityMatches(record.pid, record.processStartTime);
          if (runnerAlive && commandAlive) {
            this.adopt(recordPath, record);
            continue;
          }

          if (commandAlive) killProcessGroup(record.pid);
          record = {
            ...record,
            state: "completed",
            completion: {
              endedAt: Date.now(),
              exitCode: null,
              signal: null,
              byteTruncated: false,
              failure: runnerAlive
                ? "background command disappeared while its runner was still active"
                : "background runner exited before recording command completion",
            },
          };
          try { writeBackgroundTaskRecord(recordPath, record); }
          catch (err) {
            log("warn", `background-task-recovery: could not persist failed task ${record.taskId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        this.finish(recordPath, record);
      }

      // A live daemon may have consumed and removed a record through its direct
      // runner channel between scans. Clear any adopted projection left behind.
      for (const [recordPath, task] of this.adopted) {
        if (present.has(recordPath)) continue;
        this.clearAdopted(task);
      }
    } finally {
      this.scanning = false;
    }
  }

  private adopt(recordPath: string, record: PersistedBackgroundTask): void {
    const existing = this.adopted.get(recordPath);
    if (existing) {
      existing.record = record;
      return;
    }

    const stop = (suppressCompletionNotification: boolean): boolean => {
      const current = readBackgroundTaskRecord(recordPath) ?? record;
      if (!processIdentityMatches(current.pid, current.processStartTime)) return false;
      if (suppressCompletionNotification) {
        try { suppressBackgroundTaskNotification(recordPath); }
        catch (err) {
          log("warn", `background-task-recovery: could not suppress notification for ${current.taskId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return killProcessGroup(current.pid);
    };

    this.adopted.set(recordPath, { recordPath, record });
    trackRecoveredBackgroundProcess(record.pid, record.ownerConversationId, record.taskId, recordPath);
    if (setBackgroundTaskActive(record.ownerConversationId, record.taskId, true, {
      title: record.title,
      startedAt: record.startedAt,
      toolName: record.toolName,
      pid: record.pid,
      backgroundedAt: record.backgroundedAt,
      outputPath: record.outputPath,
      cwd: record.cwd,
      stop,
    })) {
      this.callbacks.onConversationChanged(record.ownerConversationId);
    }
    log("info", `background-task-recovery: adopted ${record.taskId} for ${record.ownerConversationId}`);
  }

  private finish(recordPath: string, record: PersistedBackgroundTask): void {
    const adopted = this.adopted.get(recordPath);
    if (adopted) this.clearAdopted(adopted);

    if (!this.deliveryEnabled) {
      return;
    }

    const completion = backgroundTaskCompletion(record);
    if (completion
        && !isBackgroundTaskNotificationSuppressed(recordPath)
        && !this.hasDeliveredCompletion(record.ownerConversationId, record.taskId)) {
      this.callbacks.onComplete(record.ownerConversationId, completion);
      log("info", `background-task-recovery: delivered completion for ${record.taskId} to ${record.ownerConversationId}`);
    }
    removeBackgroundTaskRecord(recordPath);
  }

  private clearAdopted(task: AdoptedTask): void {
    this.adopted.delete(task.recordPath);
    untrackRecoveredBackgroundProcess(task.record.pid);
    if (setBackgroundTaskActive(task.record.ownerConversationId, task.record.taskId, false)) {
      this.callbacks.onConversationChanged(task.record.ownerConversationId);
    }
  }

  private stopOrphan(recordPath: string, record: PersistedBackgroundTask): void {
    const adopted = this.adopted.get(recordPath);
    if (adopted) this.clearAdopted(adopted);
    if (record.state === "running" && processIdentityMatches(record.pid, record.processStartTime)) {
      killProcessGroup(record.pid);
    }
    removeBackgroundTaskRecord(recordPath);
    log("warn", `background-task-recovery: stopped task ${record.taskId} for missing conversation ${record.ownerConversationId}`);
  }
}
