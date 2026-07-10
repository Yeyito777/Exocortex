/**
 * Ephemeral work spawned by a conversation.
 *
 * Subagents are keyed by their child conversation id. Background tasks are
 * keyed by a tool-owned id (currently bash:<pid>). Counts are intentionally not
 * persisted: after a daemon restart there is no managed task lifecycle left to
 * observe reliably.
 */

export interface ConversationActivityCounts {
  subagentCount: number;
  backgroundTaskCount: number;
}

const subagentsByParent = new Map<string, Set<string>>();
/** Last parent that spawned each child during this daemon session. */
const subagentParentByChild = new Map<string, string>();
const backgroundTasksByConversation = new Map<string, Set<string>>();

function setEntry(map: Map<string, Set<string>>, ownerId: string, taskId: string, active: boolean): boolean {
  if (active) {
    let tasks = map.get(ownerId);
    if (!tasks) {
      tasks = new Set();
      map.set(ownerId, tasks);
    }
    const before = tasks.size;
    tasks.add(taskId);
    return tasks.size !== before;
  }

  const tasks = map.get(ownerId);
  if (!tasks || !tasks.delete(taskId)) return false;
  if (tasks.size === 0) map.delete(ownerId);
  return true;
}

export function setSubagentActive(parentConvId: string, childConvId: string, active: boolean): boolean {
  if (active) subagentParentByChild.set(childConvId, parentConvId);
  return setEntry(subagentsByParent, parentConvId, childConvId, active);
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

export function setBackgroundTaskActive(convId: string, taskId: string, active: boolean): boolean {
  return setEntry(backgroundTasksByConversation, convId, taskId, active);
}

export function getConversationActivityCounts(convId: string): ConversationActivityCounts {
  return {
    subagentCount: subagentsByParent.get(convId)?.size ?? 0,
    backgroundTaskCount: backgroundTasksByConversation.get(convId)?.size ?? 0,
  };
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
