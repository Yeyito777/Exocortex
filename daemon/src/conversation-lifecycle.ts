/** Lightweight lifecycle hooks that avoid coupling the conversation store to services. */

type RemovedListener = (conversationId: string) => void;
type RemovingListener = (conversationId: string) => void;
const removedListeners = new Set<RemovedListener>();
const removingListeners = new Set<RemovingListener>();

/** Register a non-destructive quiesce hook run before workspace movement. */
export function onConversationRemoving(listener: RemovingListener): () => void {
  removingListeners.add(listener);
  return () => removingListeners.delete(listener);
}

export function notifyConversationRemoving(conversationId: string): void {
  for (const listener of removingListeners) listener(conversationId);
}

export function onConversationRemoved(listener: RemovedListener): () => void {
  removedListeners.add(listener);
  return () => removedListeners.delete(listener);
}

export function notifyConversationRemoved(conversationId: string): void {
  for (const listener of removedListeners) listener(conversationId);
}
