import { createHash } from "node:crypto";
import type { ConversationLoadedEvent, ConversationHistoryLoadedEvent } from "./protocol";

export type HistoryResponse = ConversationLoadedEvent | ConversationHistoryLoadedEvent;
export const MAX_CACHED_HISTORY_ENTRIES = 2048;

export function historyEntryHash(serialized: string): string {
  return createHash("sha256").update(serialized).digest("hex");
}

/** Stateless, content-checked reuse: edits, trims and shifted windows need no
 * invalidation/version bookkeeping. Metadata and pendingAI are always fresh. */
export function encodeHistoryDelta<T extends HistoryResponse>(event: T, hashes?: string[]): T {
  if (!Array.isArray(hashes) || hashes.length === 0 || hashes.length > MAX_CACHED_HISTORY_ENTRIES
      || hashes.some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) return event;
  const cached = new Map(hashes.map((hash, index) => [hash, index]));
  const entries: T["entries"] = [];
  let savedBytes = 0;
  const entryOrder = event.entries.map(entry => {
    const serialized = JSON.stringify(entry);
    // Tiny entries are cheaper to send than to hash/reuse.
    const index = serialized.length > 80 ? cached.get(historyEntryHash(serialized)) : undefined;
    if (index === undefined) return entries.push(entry) - 1;
    savedBytes += Buffer.byteLength(serialized);
    return -index - 1;
  });
  if (savedBytes <= JSON.stringify(entryOrder).length + 32) return event;
  return { ...event, entries, entryOrder };
}
