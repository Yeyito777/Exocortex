/**
 * Ephemeral work spawned by a conversation.
 *
 * Subagents are keyed by their child conversation id. Background tasks are
 * keyed by a tool-owned id (currently bash:<pid>). Task details are intentionally
 * not persisted: after a daemon restart there is no managed task lifecycle left
 * to observe reliably.
 */

import type { ConversationTaskSummary } from "@exocortex/shared/messages";

export interface ConversationActivityCounts {
  subagentCount: number;
  backgroundTaskCount: number;
}

type TaskDetails = Pick<ConversationTaskSummary, "title" | "startedAt">;
type TaskMap = Map<string, ConversationTaskSummary>;

const subagentsByParent = new Map<string, TaskMap>();
/** Last parent that spawned each child during this daemon session. */
const subagentParentByChild = new Map<string, string>();
const backgroundTasksByConversation = new Map<string, TaskMap>();

function setEntry(
  map: Map<string, TaskMap>,
  ownerId: string,
  taskId: string,
  kind: ConversationTaskSummary["kind"],
  active: boolean,
  details?: TaskDetails,
): boolean {
  if (active) {
    let tasks = map.get(ownerId);
    if (!tasks) {
      tasks = new Map();
      map.set(ownerId, tasks);
    }
    const existing = tasks.get(taskId);
    const task: ConversationTaskSummary = {
      id: taskId,
      kind,
      title: details?.title ?? existing?.title ?? taskId,
      startedAt: details?.startedAt ?? existing?.startedAt ?? Date.now(),
    };
    if (existing
        && existing.kind === task.kind
        && existing.title === task.title
        && existing.startedAt === task.startedAt) return false;
    tasks.set(taskId, task);
    return true;
  }

  const tasks = map.get(ownerId);
  if (!tasks || !tasks.delete(taskId)) return false;
  if (tasks.size === 0) map.delete(ownerId);
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

export function setBackgroundTaskActive(
  convId: string,
  taskId: string,
  active: boolean,
  details?: TaskDetails,
): boolean {
  return setEntry(backgroundTasksByConversation, convId, taskId, "background", active, details);
}

export function getConversationActivityCounts(convId: string): ConversationActivityCounts {
  return {
    subagentCount: subagentsByParent.get(convId)?.size ?? 0,
    backgroundTaskCount: backgroundTasksByConversation.get(convId)?.size ?? 0,
  };
}

/** Task details for the focused-conversation activity panel. */
export function getConversationTasks(convId: string): ConversationTaskSummary[] {
  const byStart = (a: ConversationTaskSummary, b: ConversationTaskSummary) =>
    a.startedAt - b.startedAt || a.id.localeCompare(b.id);
  return [
    ...[...(subagentsByParent.get(convId)?.values() ?? [])].sort(byStart),
    ...[...(backgroundTasksByConversation.get(convId)?.values() ?? [])].sort(byStart),
  ].map(task => ({ ...task }));
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
}
