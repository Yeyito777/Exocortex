/**
 * Page updates for history_push (docs/ssh-history-cache.md). The daemon keeps
 * a PageBase of each page it sent a watching client and sends the next version
 * against it: unchanged entries by index, and a changed AI entry (a running
 * turn's, one round longer; one whose last tool call shows while a turn runs)
 * as its new blocks, the rest by index into the base entry's.
 */
import { historyEntryHash, type HistoryResponse } from "./history-delta";
import { entryBlockHashes } from "./live-delta";
import type { DisplayEntry } from "./protocol";

export interface PageBase {
  hashes: string[];
  /** Per-block hashes of each AI entry (null for others). */
  blocks: Array<string[] | null>;
}

export function pageBase(entries: DisplayEntry[]): PageBase {
  return { hashes: entries.map(entry => historyEntryHash(JSON.stringify(entry))), blocks: entries.map(entryBlockHashes) };
}

/** `event` against `base`: always in entryOrder form, so the client rebuilds from its copy alone. */
export function encodePagePush<T extends HistoryResponse>(event: T, base: PageBase): T {
  const byHash = new Map<string, number>();
  base.hashes.forEach((hash, index) => { if (!byHash.has(hash)) byHash.set(hash, index); });
  // Where each block of the base's AI entries is: a changed entry is mostly blocks it already had.
  const blockHome = new Map<string, number>();
  base.blocks.forEach((blocks, entryIndex) => blocks?.forEach(hash => blockHome.set(hash, entryIndex)));
  const entries: DisplayEntry[] = [];
  const entryBlocks: Array<[number, number, number[]]> = [];
  const entryOrder = event.entries.map(entry => {
    const known = byHash.get(historyEntryHash(JSON.stringify(entry)));
    if (known !== undefined) return -known - 1;
    const hashes = entryBlockHashes(entry);
    if (entry.type === "ai" && hashes) {
      // The base entry holding most of its blocks.
      const votes = new Map<number, number>();
      for (const hash of hashes) {
        const home = blockHome.get(hash);
        if (home !== undefined) votes.set(home, (votes.get(home) ?? 0) + 1);
      }
      const [baseIndex] = [...votes].sort((a, b) => b[1] - a[1])[0] ?? [];
      if (baseIndex !== undefined) {
        const baseBlocks = new Map(base.blocks[baseIndex]!.map((hash, index) => [hash, index]));
        const fresh: typeof entry.blocks = [];
        const order = entry.blocks.map((block, index) => {
          const reused = baseBlocks.get(hashes[index]!);
          return reused !== undefined ? -reused - 1 : fresh.push(block) - 1;
        });
        entryBlocks.push([entries.length, baseIndex, order]);
        return entries.push({ ...entry, blocks: fresh }) - 1;
      }
    }
    return entries.push(entry) - 1;
  });
  return { ...event, entries, entryOrder, ...(entryBlocks.length ? { entryBlocks } : {}) };
}

/** Rebuild a pushed page from the copy's entries it was encoded against. Throws when they cannot hold it. */
export function decodePagePush<T extends HistoryResponse>(event: T, baseEntries: DisplayEntry[]): T {
  if (!Array.isArray(event.entryOrder)) return event;
  const rebuilt = new Map<number, [number, number[]]>();
  for (const [fresh, baseIndex, order] of event.entryBlocks ?? []) {
    if (baseEntries[baseIndex]?.type !== "ai" || !Array.isArray(order)) throw new Error("Invalid entry blocks");
    rebuilt.set(fresh, [baseIndex, order]);
  }
  const entries = event.entryOrder.map(index => {
    if (!Number.isSafeInteger(index)) throw new Error("Invalid push index");
    if (index < 0) {
      const entry = baseEntries[-index - 1];
      if (entry === undefined) throw new Error("Missing base entry");
      return structuredClone(entry);
    }
    const entry = event.entries[index];
    if (entry === undefined) throw new Error("Missing fresh entry");
    const blocks = rebuilt.get(index);
    if (!blocks) return entry;
    if (entry.type !== "ai") throw new Error("Invalid entry blocks");
    const baseEntry = baseEntries[blocks[0]] as Extract<DisplayEntry, { type: "ai" }>;
    return {
      ...entry,
      blocks: blocks[1].map(position => {
        const block = position < 0 ? baseEntry.blocks[-position - 1] : entry.blocks[position];
        if (block === undefined || !Number.isSafeInteger(position)) throw new Error("Missing block");
        return structuredClone(block);
      }),
    };
  });
  const { entryOrder: _order, entryBlocks: _blocks, ...rest } = event;
  return { ...rest, entries } as T;
}
