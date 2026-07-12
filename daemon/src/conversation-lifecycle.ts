/** Lightweight lifecycle hooks that avoid coupling the conversation store to services. */

type RemovedListener = (conversationId: string) => void;
const removedListeners = new Set<RemovedListener>();

export function onConversationRemoved(listener: RemovedListener): () => void {
  removedListeners.add(listener);
  return () => removedListeners.delete(listener);
}

export function notifyConversationRemoved(conversationId: string): void {
  for (const listener of removedListeners) listener(conversationId);
}
