/**
 * "Something about the Claude accounts changed": a sign-in check, usage or a
 * limit, or a turn starting or ending. The Accounts screen's watchers listen
 * (accounts-watch.ts); its own module so usage.ts and auth-cache.ts can
 * report without importing the pool.
 */

const listeners = new Set<() => void>();

export function onClaudeAccountsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitClaudeAccountsChanged(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener's failure must not break the turn or check that reported it.
    }
  }
}
