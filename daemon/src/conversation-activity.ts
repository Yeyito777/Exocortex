/**
 * Ephemeral work spawned by a conversation.
 *
 * Subagents are keyed by their child conversation id. Background tasks are
 * keyed by a tool-owned stable id. The richer background records in this
 * module are the daemon's canonical catalog for task inspection and control;
 * conversation summaries receive only the compact UI projection.
 *
 * Activity is normally ephemeral. Restart recovery reconstructs
 * notification-linked subagents and their task details from its durable
 * lifecycle sidecar before replaying them. Managed background processes are
 * stopped during graceful daemon shutdown and are not recovered after a crash.
 */

import type { ConversationTaskSummary } from "@exocortex/shared/messages";

export interface ConversationActivityCounts {
  subagentCount: number;
  backgroundTaskCount: number;
}

type TaskDetails = Pick<ConversationTaskSummary, "title" | "startedAt" | "dueAt" | "chronoMode">;
type BackgroundTaskStop = (suppressCompletionNotification: boolean) => boolean;

export interface BackgroundTaskRuntimeDetails extends TaskDetails {
  toolName: string;
  pid: number;
  backgroundedAt: number;
  outputPath?: string;
  cwd?: string;
  stop?: BackgroundTaskStop;
}

interface InternalTaskRecord extends ConversationTaskSummary {
  status: "running" | "stopping";
  toolName?: string;
  pid?: number;
  backgroundedAt?: number;
  outputPath?: string;
  cwd?: string;
  stop?: BackgroundTaskStop;
}

export interface ActiveConversationTask extends ConversationTaskSummary {
  ownerConversationId: string;
  status: "running" | "stopping";
  toolName?: string;
  pid?: number;
  backgroundedAt?: number;
  outputPath?: string;
  cwd?: string;
}

type TaskMap = Map<string, InternalTaskRecord>;

const subagentsByParent = new Map<string, TaskMap>();
/** Last parent that spawned each child during this daemon session. */
const subagentParentByChild = new Map<string, string>();
const backgroundTasksByConversation = new Map<string, TaskMap>();
const chronoTasksByConversation = new Map<string, TaskMap>();
const taskCompletionWaiters = new Map<string, Set<() => void>>();

function recordsEqual(a: InternalTaskRecord, b: InternalTaskRecord): boolean {
  return a.id === b.id
    && a.kind === b.kind
    && a.title === b.title
    && a.startedAt === b.startedAt
    && a.dueAt === b.dueAt
    && a.chronoMode === b.chronoMode
    && a.status === b.status
    && a.toolName === b.toolName
    && a.pid === b.pid
    && a.backgroundedAt === b.backgroundedAt
    && a.outputPath === b.outputPath
    && a.cwd === b.cwd
    && a.stop === b.stop;
}

function setEntry(
  map: Map<string, TaskMap>,
  ownerId: string,
  taskId: string,
  kind: ConversationTaskSummary["kind"],
  active: boolean,
  details?: TaskDetails | BackgroundTaskRuntimeDetails,
): boolean {
  if (active) {
    let tasks = map.get(ownerId);
    if (!tasks) {
      tasks = new Map();
      map.set(ownerId, tasks);
    }
    const existing = tasks.get(taskId);
    const background = kind === "background" ? details as BackgroundTaskRuntimeDetails | undefined : undefined;
    const task: InternalTaskRecord = {
      id: taskId,
      kind,
      title: details?.title ?? existing?.title ?? taskId,
      startedAt: details?.startedAt ?? existing?.startedAt ?? Date.now(),
      ...(details?.dueAt !== undefined ? { dueAt: details.dueAt } : existing?.dueAt !== undefined ? { dueAt: existing.dueAt } : {}),
      ...(details?.chronoMode ? { chronoMode: details.chronoMode } : existing?.chronoMode ? { chronoMode: existing.chronoMode } : {}),
      status: existing?.status ?? "running",
      ...(background?.toolName ? { toolName: background.toolName } : existing?.toolName ? { toolName: existing.toolName } : {}),
      ...(background?.pid !== undefined ? { pid: background.pid } : existing?.pid !== undefined ? { pid: existing.pid } : {}),
      ...(background?.backgroundedAt !== undefined
        ? { backgroundedAt: background.backgroundedAt }
        : existing?.backgroundedAt !== undefined ? { backgroundedAt: existing.backgroundedAt } : {}),
      ...(background?.outputPath ? { outputPath: background.outputPath } : existing?.outputPath ? { outputPath: existing.outputPath } : {}),
      ...(background?.cwd ? { cwd: background.cwd } : existing?.cwd ? { cwd: existing.cwd } : {}),
      ...(background?.stop ? { stop: background.stop } : existing?.stop ? { stop: existing.stop } : {}),
    };
    if (existing && recordsEqual(existing, task)) return false;
    tasks.set(taskId, task);
    return true;
  }

  const tasks = map.get(ownerId);
  if (!tasks || !tasks.delete(taskId)) return false;
  if (tasks.size === 0) map.delete(ownerId);
  const waiters = taskCompletionWaiters.get(taskId);
  if (waiters) {
    taskCompletionWaiters.delete(taskId);
    for (const resolve of waiters) resolve();
  }
  return true;
}

export function setSubagentActive(
  parentConvId: string,
  childConvId: string,
  active: boolean,
  details?: TaskDetails,
): boolean {
  if (active) subagentParentByChild.set(childConvId, parentConvId);
  return setEntry(subagentsByParent, parentConvId, childConvId, "subagent", active, details);
}

/**
 * Child conversations spawned by a parent during this daemon session.
 *
 * Unlike the active count, this relationship remains after a child finishes so
 * the parent's native exo jobs/list calls can still find completed work.
 */
export function getSubagentConversationIds(parentConvId: string): string[] {
  const ids: string[] = [];
  for (const [childConvId, parentId] of subagentParentByChild) {
    if (parentId === parentConvId) ids.push(childConvId);
  }
  return ids;
}

/** Last known parent for a child, including after the active count was cleared. */
export function getSubagentParentConversationId(childConvId: string): string | undefined {
  return subagentParentByChild.get(childConvId);
}

export function setBackgroundTaskActive(
  convId: string,
  taskId: string,
  active: boolean,
  details?: BackgroundTaskRuntimeDetails | TaskDetails,
): boolean {
  return setEntry(backgroundTasksByConversation, convId, taskId, "background", active, details);
}

export function setChronoTaskActive(
  convId: string,
  taskId: string,
  active: boolean,
  details?: TaskDetails,
): boolean {
  return setEntry(chronoTasksByConversation, convId, taskId, "chrono", active, details);
}

function findActiveTask(taskId: string): InternalTaskRecord | undefined {
  for (const catalog of [subagentsByParent, backgroundTasksByConversation, chronoTasksByConversation]) {
    for (const tasks of catalog.values()) {
      const task = tasks.get(taskId);
      if (task) return task;
    }
  }
  return undefined;
}

/** Event-driven wait for an active task to leave the daemon task catalog. */
export function waitForConversationTask(taskId: string, signal?: AbortSignal): Promise<ConversationTaskSummary> {
  const task = findActiveTask(taskId);
  if (!task) return Promise.reject(new Error(`Active task not found: ${taskId}`));
  const snapshot = summaryProjection(task);
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve(snapshot);
    };
    const abort = () => {
      const waiters = taskCompletionWaiters.get(taskId);
      waiters?.delete(finish);
      if (waiters?.size === 0) taskCompletionWaiters.delete(taskId);
      reject(new DOMException("Aborted", "AbortError"));
    };
    let waiters = taskCompletionWaiters.get(taskId);
    if (!waiters) {
      waiters = new Set();
      taskCompletionWaiters.set(taskId, waiters);
    }
    waiters.add(finish);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export function getConversationActivityCounts(convId: string): ConversationActivityCounts {
  return {
    subagentCount: subagentsByParent.get(convId)?.size ?? 0,
    backgroundTaskCount: backgroundTasksByConversation.get(convId)?.size ?? 0,
  };
}

function byStart(a: InternalTaskRecord, b: InternalTaskRecord): number {
  return a.startedAt - b.startedAt || a.id.localeCompare(b.id);
}

function summaryProjection(task: InternalTaskRecord): ConversationTaskSummary {
  return {
    id: task.id,
    kind: task.kind,
    title: task.title,
    startedAt: task.startedAt,
    ...(task.dueAt !== undefined ? { dueAt: task.dueAt } : {}),
    ...(task.chronoMode ? { chronoMode: task.chronoMode } : {}),
  };
}

/** Compact task details for the focused-conversation activity panel. */
export function getConversationTasks(convId: string): ConversationTaskSummary[] {
  return [
    ...[...(subagentsByParent.get(convId)?.values() ?? [])].sort(byStart),
    ...[...(backgroundTasksByConversation.get(convId)?.values() ?? [])].sort(byStart),
    ...[...(chronoTasksByConversation.get(convId)?.values() ?? [])].sort(byStart),
  ].map(summaryProjection);
}

function publicRecord(ownerConversationId: string, task: InternalTaskRecord): ActiveConversationTask {
  return {
    ownerConversationId,
    ...summaryProjection(task),
    status: task.status,
    ...(task.toolName ? { toolName: task.toolName } : {}),
    ...(task.pid !== undefined ? { pid: task.pid } : {}),
    ...(task.backgroundedAt !== undefined ? { backgroundedAt: task.backgroundedAt } : {}),
    ...(task.outputPath ? { outputPath: task.outputPath } : {}),
    ...(task.cwd ? { cwd: task.cwd } : {}),
  };
}

/** Rich active-task snapshots for native daemon inspection. */
export function listActiveConversationTasks(ownerConversationId?: string): ActiveConversationTask[] {
  const records: ActiveConversationTask[] = [];
  const append = (ownerId: string, tasks: TaskMap | undefined) => {
    for (const task of tasks?.values() ?? []) records.push(publicRecord(ownerId, task));
  };

  if (ownerConversationId) {
    append(ownerConversationId, subagentsByParent.get(ownerConversationId));
    append(ownerConversationId, backgroundTasksByConversation.get(ownerConversationId));
    append(ownerConversationId, chronoTasksByConversation.get(ownerConversationId));
  } else {
    for (const [ownerId, tasks] of subagentsByParent) append(ownerId, tasks);
    for (const [ownerId, tasks] of backgroundTasksByConversation) append(ownerId, tasks);
    for (const [ownerId, tasks] of chronoTasksByConversation) append(ownerId, tasks);
  }

  return records.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

export type StopBackgroundTaskResult = "stopping" | "already-stopping" | "failed" | "not-found" | "not-stoppable";

/** Request an exact managed background process to stop without accepting raw PIDs. */
export function stopBackgroundTask(
  taskId: string,
  suppressCompletionNotification: boolean,
): { result: StopBackgroundTaskResult; task?: ActiveConversationTask } {
  for (const [ownerId, tasks] of backgroundTasksByConversation) {
    const task = tasks.get(taskId);
    if (!task) continue;
    const snapshot = publicRecord(ownerId, task);
    if (task.status === "stopping") return { result: "already-stopping", task: snapshot };
    if (!task.stop) return { result: "not-stoppable", task: snapshot };
    task.status = "stopping";
    try {
      if (!task.stop(suppressCompletionNotification)) {
        task.status = "running";
        return { result: "failed", task: publicRecord(ownerId, task) };
      }
      return { result: "stopping", task: publicRecord(ownerId, task) };
    } catch {
      task.status = "running";
      return { result: "failed", task: publicRecord(ownerId, task) };
    }
  }
  return { result: "not-found" };
}

/** Stop every background process owned by a conversation, e.g. before deletion. */
export function stopBackgroundTasksForConversation(convId: string): number {
  const ids = [...(backgroundTasksByConversation.get(convId)?.keys() ?? [])];
  for (const id of ids) stopBackgroundTask(id, true);
  return ids.length;
}

/** Stop every managed background process during graceful daemon shutdown. */
export function stopAllBackgroundTasks(): number {
  const ids = [...backgroundTasksByConversation.values()].flatMap(tasks => [...tasks.keys()]);
  for (const id of ids) stopBackgroundTask(id, true);
  return ids.length;
}

/** Wait briefly for close listeners to clear the active background catalog. */
export async function waitForBackgroundTasksToStop(timeoutMs = 1_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = [...backgroundTasksByConversation.values()].reduce((sum, tasks) => sum + tasks.size, 0);
    if (remaining === 0) return 0;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return [...backgroundTasksByConversation.values()].reduce((sum, tasks) => sum + tasks.size, 0);
}

export function getActiveSubagentCount(): number {
  let count = 0;
  for (const children of subagentsByParent.values()) count += children.size;
  return count;
}

/** Test-only reset for isolated runtime-state assertions. */
export function resetConversationActivityForTest(): void {
  subagentsByParent.clear();
  subagentParentByChild.clear();
  backgroundTasksByConversation.clear();
  chronoTasksByConversation.clear();
  taskCompletionWaiters.clear();
}
