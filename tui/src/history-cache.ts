import type { Command, Event } from "./protocol";
import { historyEntryHash, MAX_CACHED_HISTORY_ENTRIES, type HistoryResponse } from "@exocortex/shared/history-delta";

type HistoryRequest = Extract<Command, { type: "load_conversation" | "load_conversation_history" }>;
interface Page {
  entries: string[];
  hashes: string[];
  bytes: number;
}
interface Pending {
  command: HistoryRequest;
  key: string;
  base?: Page;
  /** A load's initialBackfill page, pending under its own reqId until the load answers. */
  backfillReqId?: string;
  /** This entry is that pushed page: its retry asks for it from the cursor it reports. */
  pushed?: boolean;
}

function requestKey(command: HistoryRequest): string {
  return JSON.stringify([command.type, command.convId, command.turns,
    command.type === "load_conversation_history" ? command.beforeEntryIndex : null,
    command.type === "load_conversation_history" ? command.beforeBlockIndex ?? 0 : null]);
}

function initialBackfillKey(convId: string, turns: number): string {
  return JSON.stringify(["initial_backfill", convId, turns]);
}

/** Transport-only cache. Never displays stale state or retains mutable UI objects.
 * LRU storage and request-pinned bases each have a separate memory budget. */
export class HistoryCache {
  private pages = new Map<string, Page>();
  private pending = new Map<string, Pending>();
  private bytes = 0;
  private pinnedBytes = 0;

  constructor(private readonly budget = 8 * 1024 * 1024, private readonly maxPages = 64) {}

  clear(): void {
    this.pages.clear();
    this.bytes = 0;
    this.resetPending();
  }

  resetPending(): void {
    this.pending.clear();
    this.pinnedBytes = 0;
  }

  /**
   * Bases for an open from pages kept elsewhere (the on-disk view cache, see
   * viewcache.ts), which pushes and peeks keep newer than the last answer
   * here: a TUI that just started, or reopening a conversation that changed
   * since, still gets a small delta. Hashes match by content, so a stale
   * page costs bytes only.
   */
  seed(command: Extract<HistoryRequest, { type: "load_conversation" }>, loaded: HistoryResponse, backfill: HistoryResponse | null): void {
    this.remember(requestKey(command), loaded);
    if (backfill && command.initialBackfill) this.remember(initialBackfillKey(command.convId, command.initialBackfill.turns), backfill);
  }

  prepare<T extends HistoryRequest>(command: T): T {
    if (!command.reqId || this.pending.has(command.reqId) || this.pending.size >= 64) return command;
    const key = requestKey(command);
    const base = this.pin(key);
    const backfill = command.type === "load_conversation" ? command.initialBackfill : undefined;
    let prepared: T = base ? { ...command, cachedEntryHashes: base.hashes } : command;
    if (backfill && !this.pending.has(backfill.reqId) && this.pending.size < 63) {
      // Its cursor is unknown until the load answers, so the cached base is
      // this conversation's last opening backfill; hashes match by content.
      const backfillKey = initialBackfillKey(command.convId, backfill.turns);
      const backfillBase = this.pin(backfillKey);
      this.pending.set(backfill.reqId, {
        command: {
          type: "load_conversation_history", reqId: backfill.reqId, convId: command.convId, beforeEntryIndex: 0, turns: backfill.turns, requestSource: "initial-backfill",
          ...(command.type === "load_conversation" && command.viewport?.folded ? { folded: true } : {}),
        },
        key: backfillKey,
        base: backfillBase,
        pushed: true,
      });
      prepared = { ...prepared, initialBackfill: backfillBase ? { ...backfill, cachedEntryHashes: backfillBase.hashes } : backfill };
    }
    this.pending.set(command.reqId, { command, key, base, ...(backfill ? { backfillReqId: backfill.reqId } : {}) });
    return prepared;
  }

  /** The cached page under `key`, pinned for an outstanding request, if the pin budget allows. */
  private pin(key: string): Page | undefined {
    const base = this.pages.get(key);
    if (!base || this.pinnedBytes + base.bytes > this.budget) return undefined;
    this.pages.delete(key);
    this.pages.set(key, base);
    this.pinnedBytes += base.bytes;
    return base;
  }

  private release(reqId: string): void {
    const pending = this.pending.get(reqId);
    if (!pending) return;
    this.pending.delete(reqId);
    this.pinnedBytes -= pending.base?.bytes ?? 0;
  }

  /** Returns a full event, or retries a rejected delta with the original request.
   * The request id is preserved so history cursors and opening diagnostics work. */
  receive(event: Event, retry: (command: HistoryRequest) => void): Event | null {
    if (event.type !== "conversation_loaded" && event.type !== "conversation_history_loaded" && event.type !== "error") return event;
    const pending = event.reqId ? this.pending.get(event.reqId) : undefined;
    if (!pending) {
      // A delta cannot be safely interpreted without its exact request base.
      return event.type !== "error" && event.entryOrder ? null : event;
    }
    if (event.type !== "error" && (event.convId !== pending.command.convId
        || (event.type === "conversation_loaded") !== (pending.command.type === "load_conversation"))) return null;
    this.pending.delete(event.reqId!);
    this.pinnedBytes -= pending.base?.bytes ?? 0;
    // A daemon that does not follow this load with its backfill (no older
    // history, or it predates initialBackfill) never answers that reqId.
    if (pending.backfillReqId && (event.type !== "conversation_loaded" || event.initialBackfillReqId !== pending.backfillReqId)) {
      this.release(pending.backfillReqId);
    }
    if (event.type === "error") return event;

    let full: HistoryResponse = event;
    if (event.entryOrder) {
      try {
        if (!pending.base || !Array.isArray(event.entryOrder)) throw new Error("Missing cache base");
        const entries = event.entryOrder.map(index => {
          if (!Number.isSafeInteger(index)) throw new Error("Invalid cache index");
          if (index >= 0) {
            if (!event.entries[index]) throw new Error("Missing fresh entry");
            return event.entries[index];
          }
          const serialized = pending.base!.entries[-index - 1];
          if (serialized === undefined) throw new Error("Missing cached entry");
          return JSON.parse(serialized);
        });
        const { entryOrder: _, ...rest } = event;
        full = { ...rest, entries };
      } catch {
        if (pending.base) {
          this.pending.set(event.reqId!, { ...pending, base: undefined });
          // A pushed backfill is asked for again as an ordinary page from its own cursor.
          retry(pending.pushed && event.type === "conversation_history_loaded" && pending.command.type === "load_conversation_history"
            ? {
              ...pending.command,
              beforeEntryIndex: event.historyEndIndex,
              ...(event.historyEndBlockIndex ? { beforeBlockIndex: event.historyEndBlockIndex } : {}),
            }
            : pending.command);
        } else {
          return { type: "error", reqId: event.reqId, convId: event.convId, message: "Invalid conversation history delta" };
        }
        return null;
      }
    }
    this.remember(pending.key, full);
    return full;
  }

  private remember(key: string, event: HistoryResponse): void {
    // Serialize before UI handlers can mutate blocks (e.g. expanded tool output).
    const old = this.pages.get(key);
    if (old) { this.pages.delete(key); this.bytes -= old.bytes; }
    // A 64-character hash in the request is not worthwhile for tiny entries.
    const entries = event.entries.map(entry => JSON.stringify(entry)).filter(entry => entry.length > 256);
    if (!entries.length || entries.length > MAX_CACHED_HISTORY_ENTRIES) return;
    const bytes = entries.reduce((total, entry) => total + entry.length * 2 + 128, 0);
    if (bytes > this.budget) return;
    const page = { entries, bytes, hashes: entries.map(historyEntryHash) };
    while (this.pages.size && (this.bytes + bytes > this.budget || this.pages.size >= this.maxPages)) {
      const oldest = this.pages.keys().next().value!;
      this.bytes -= this.pages.get(oldest)!.bytes;
      this.pages.delete(oldest);
    }
    this.pages.set(key, page);
    this.bytes += bytes;
  }
}
