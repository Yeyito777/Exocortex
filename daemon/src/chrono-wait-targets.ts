/**
 * What a chrono wait can watch: a daemon task (background command, subagent,
 * chrono task) by its id, or a systemd user unit as `unit:NAME`. Connected
 * and suspended waits share these, so a unit wait survives a daemon restart
 * the same way a task wait does.
 */

import { getWaitableConversationTask, waitForConversationTask } from "./conversation-activity";
import { completedChronoWaitOutput } from "./tools/chrono-output";
import {
  checkSystemdUnit,
  looksLikeSystemdUnitName,
  SYSTEMD_UNIT_TARGET_PREFIX,
  systemdUnitTargetName,
  systemdUnitWaitOutput,
  waitForSystemdUnit,
} from "./systemd-unit-wait";

export interface ChronoWaitOutcome {
  output: string;
  endedAt: number;
}

/** Agents pass bare unit names as task ids; point them at the unit target. */
function withUnitHint(err: unknown, taskId: string): unknown {
  if (!(err instanceof Error) || !err.message.startsWith("Task not found") || !looksLikeSystemdUnitName(taskId)) return err;
  return new Error(`${err.message}. If it is a systemd user unit, use task_id "${SYSTEMD_UNIT_TARGET_PREFIX}${taskId}".`);
}

/** The outcome of a target that already finished, or null while it runs. Rejects when it cannot be waited on. */
export async function checkChronoWaitTarget(taskId: string, ownerConversationId?: string): Promise<ChronoWaitOutcome | null> {
  const unit = systemdUnitTargetName(taskId);
  if (unit !== null) {
    const completion = await checkSystemdUnit(unit);
    return completion ? { output: systemdUnitWaitOutput(taskId, completion), endedAt: completion.endedAt } : null;
  }
  try {
    const task = getWaitableConversationTask(taskId, ownerConversationId);
    return task.status === "completed" ? { output: completedChronoWaitOutput(task), endedAt: task.endedAt } : null;
  } catch (err) {
    throw withUnitHint(err, taskId);
  }
}

/** Resolve when the target finishes; reject on abort or when it cannot be waited on. */
export function waitForChronoWaitTarget(taskId: string, signal: AbortSignal, ownerConversationId?: string): Promise<ChronoWaitOutcome> {
  const unit = systemdUnitTargetName(taskId);
  if (unit !== null) {
    return waitForSystemdUnit(unit, signal)
      .then(completion => ({ output: systemdUnitWaitOutput(taskId, completion), endedAt: completion.endedAt }));
  }
  return waitForConversationTask(taskId, signal, ownerConversationId).then(
    completed => ({ output: completedChronoWaitOutput(completed), endedAt: completed.endedAt }),
    err => { throw withUnitHint(err, taskId); },
  );
}
