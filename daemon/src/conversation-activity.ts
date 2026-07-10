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
  return setEntry(subagentsByParent, parentConvId, childConvId, active);
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

/** Test-only reset for isolated runtime-state assertions. */
export function resetConversationActivityForTest(): void {
  subagentsByParent.clear();
  backgroundTasksByConversation.clear();
}
