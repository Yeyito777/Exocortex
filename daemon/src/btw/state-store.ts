import { log } from "../log";
import type { ConversationBtw } from "../messages";
import {
  BTW_PERSIST_DEBOUNCE_MS,
  BTW_PERSIST_RETRY_MS,
  BTW_RESTART_ERROR,
} from "./constants";
import type { BtwPersistenceDependencies } from "./types";
import { cloneBtw } from "./blocks";

/**
 * Owns durable panel state and accepted-session receipts.
 *
 * The manager deliberately performs optimistic mutations against this store and
 * rolls them back when persistNow() fails, so acknowledgements are never emitted
 * for state that was not durably accepted.
 */
export class BtwStateStore {
  private readonly states: Map<string, ConversationBtw>;
  private readonly seenSessionIds: Map<string, Set<string>>;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly dependencies: BtwPersistenceDependencies) {
    const persisted = dependencies.loadConversationBtwState();
    this.states = new Map(
      [...persisted.btws].map(([convId, btw]) => [convId, cloneBtw(btw)]),
    );
    this.seenSessionIds = new Map(
      [...persisted.seenSessionIds].map(([convId, ids]) => [convId, new Set(ids)]),
    );
    this.recoverInterruptedSessions();
  }

  /** Mutable internal state used by the manager while a session is streaming. */
  get(convId: string): ConversationBtw | undefined {
    return this.states.get(convId);
  }

  getSnapshot(convId: string): ConversationBtw | null {
    const btw = this.states.get(convId);
    return btw ? cloneBtw(btw) : null;
  }

  set(convId: string, btw: ConversationBtw): void {
    this.states.set(convId, btw);
  }

  delete(convId: string): boolean {
    return this.states.delete(convId);
  }

  hasSeen(convId: string, sessionId: string): boolean {
    return this.seenSessionIds.get(convId)?.has(sessionId) ?? false;
  }

  /** Add a durable operation receipt and return the value needed to roll it back. */
  remember(convId: string, sessionId: string): Set<string> | null {
    const previous = this.seenSessionIds.get(convId);
    const snapshot = previous ? new Set(previous) : null;
    const next = previous ?? new Set<string>();
    next.add(sessionId);
    this.seenSessionIds.set(convId, next);
    return snapshot;
  }

  restoreRemembered(convId: string, previous: Set<string> | null): void {
    if (previous) this.seenSessionIds.set(convId, previous);
    else this.seenSessionIds.delete(convId);
  }

  persistSoon(delay = BTW_PERSIST_DEBOUNCE_MS): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.save();
    }, delay);
    this.persistTimer.unref?.();
  }

  persistNow(): boolean {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    return this.save();
  }

  dispose(): void {
    this.disposed = true;
    this.persistNow();
  }

  private recoverInterruptedSessions(): void {
    // Provider calls cannot survive a daemon process restart. Retain their latest
    // durable text as an error panel rather than dropping the conversation's BTW.
    let recovered = false;
    const recoveredAt = Date.now();
    for (const [convId, btw] of this.states) {
      if (!this.hasSeen(convId, btw.sessionId)) {
        this.remember(convId, btw.sessionId);
        recovered = true;
      }
      if (btw.phase !== "running") continue;
      btw.phase = "error";
      btw.status = BTW_RESTART_ERROR;
      btw.endedAt = recoveredAt;
      recovered = true;
    }
    if (recovered) this.persistNow();
  }

  private save(): boolean {
    try {
      this.dependencies.saveConversationBtwState({
        btws: this.states,
        seenSessionIds: this.seenSessionIds,
      });
      return true;
    } catch (error) {
      log("error", `btw: failed to persist conversation panels: ${error instanceof Error ? error.message : String(error)}`);
      if (!this.disposed) this.persistSoon(BTW_PERSIST_RETRY_MS);
      return false;
    }
  }
}
