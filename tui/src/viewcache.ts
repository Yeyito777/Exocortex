/**
 * Opened conversations kept on disk over /ssh, so opening one paints at once.
 * See docs/ssh-history-cache.md.
 *
 * Each file holds the canonical opening page of one conversation and its
 * initial backfill, as the daemon last sent them, and the history revision
 * they were built at. The daemon pushes revision changes (history_revisions),
 * so the cache knows which copies are current; stale ones in the working set
 * (the most recently opened) are refreshed in the background with peeks,
 * which fetch only what changed (cached entry hashes, see history-cache.ts).
 * A copy is only ever a first paint: the open still asks the daemon, and its
 * answer replaces whatever differs.
 */

import { readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeDir } from "@exocortex/shared/paths";
import type { Command, Event } from "./protocol";

export type LoadedEvent = Extract<Event, { type: "conversation_loaded" }>;
export type HistoryPageEvent = Extract<Event, { type: "conversation_history_loaded" }>;
type LoadCommand = Extract<Command, { type: "load_conversation" }>;

export interface CachedView {
  convId: string;
  /** History revision of these pages; null from daemons that predate revisions. */
  rev: string | null;
  /** Pages requested folded (viewport.folded): they elide the folded work. */
  folded: boolean;
  /** The opening page, without its request ids, live turn or queue. */
  loaded: LoadedEvent;
  /** Its initial backfill page, when the daemon sent one. */
  backfill: HistoryPageEvent | null;
}

export interface ViewCacheLimits {
  maxEntries: number;
  maxBytes: number;
  maxEntryBytes: number;
}

export const DEFAULT_VIEW_CACHE_LIMITS: ViewCacheLimits = {
  maxEntries: 64,
  maxBytes: 64 * 1024 * 1024,
  maxEntryBytes: 8 * 1024 * 1024,
};

const FORMAT = 1;

interface StoredEntry {
  file: string;
  rev: string | null;
  folded: boolean;
  bytes: number;
  usedAt: number;
}

/** The cache directory for one SSH alias. */
export function viewCacheDir(alias: string): string {
  return join(runtimeDir(), "ssh-view-cache", encodeURIComponent(alias));
}

function fileName(convId: string, rev: string | null, folded: boolean): string {
  return `${encodeURIComponent(convId)}@${encodeURIComponent(rev ?? "")}@${folded ? "f" : "u"}.json`;
}

function parseFileName(name: string): { convId: string; rev: string | null; folded: boolean } | null {
  const match = /^([^@]+)@([^@]*)@([fu])\.json$/.exec(name);
  if (!match) return null;
  try {
    return { convId: decodeURIComponent(match[1]!), rev: match[2] ? decodeURIComponent(match[2]) : null, folded: match[3] === "f" };
  } catch {
    return null;
  }
}

/**
 * The files of one alias's cache. The directory is the index: each name
 * carries its conversation, revision and fold, and its mtime the last use, so
 * nothing else needs keeping in step (two TUIs may share it). Bounded by count
 * and bytes, least recently used first out.
 */
export class ViewCacheStore {
  private entries: Map<string, StoredEntry> | null = null;
  /** File texts, newest last; a few, for reopening without a read. Parsed per use: handlers mutate views. */
  private texts = new Map<string, string>();
  private writes = new Map<string, Promise<void>>();
  private bytes = 0;

  constructor(readonly dir: string, private readonly limits: ViewCacheLimits = DEFAULT_VIEW_CACHE_LIMITS) {}

  private scan(): Map<string, StoredEntry> {
    if (this.entries) return this.entries;
    const entries = new Map<string, StoredEntry>();
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch { /* none yet */ }
    for (const name of names) {
      const parsed = parseFileName(name);
      if (!parsed) {
        // A write that never got renamed into place.
        if (name.includes(".tmp-")) rmSync(join(this.dir, name), { force: true });
        continue;
      }
      let stat;
      try { stat = statSync(join(this.dir, name)); } catch { continue; }
      const entry = { file: name, rev: parsed.rev, folded: parsed.folded, bytes: stat.size, usedAt: stat.mtimeMs };
      const existing = entries.get(parsed.convId);
      if (existing && existing.usedAt >= entry.usedAt) {
        rmSync(join(this.dir, name), { force: true });
        continue;
      }
      if (existing) rmSync(join(this.dir, existing.file), { force: true });
      entries.set(parsed.convId, entry);
    }
    this.entries = entries;
    this.bytes = [...entries.values()].reduce((total, entry) => total + entry.bytes, 0);
    this.evict();
    return entries;
  }

  /** Conversation ids, most recently used first. */
  ids(): string[] {
    return [...this.scan()].sort((a, b) => b[1].usedAt - a[1].usedAt).map(([id]) => id);
  }

  has(convId: string): boolean {
    return this.scan().has(convId);
  }

  rev(convId: string): string | null | undefined {
    return this.scan().get(convId)?.rev;
  }

  /** The stored view, read from disk if needed; a damaged file is dropped. */
  get(convId: string): CachedView | null {
    const entry = this.scan().get(convId);
    if (!entry) return null;
    try {
      const text = this.texts.get(convId) ?? readFileSync(join(this.dir, entry.file), "utf8");
      const data = JSON.parse(text) as { format?: number } & Partial<CachedView>;
      if (data.format !== FORMAT || data.convId !== convId || data.loaded?.type !== "conversation_loaded"
          || data.loaded.convId !== convId || !Array.isArray(data.loaded.entries)
          || (data.backfill && (data.backfill.type !== "conversation_history_loaded" || !Array.isArray(data.backfill.entries)))) {
        throw new Error("invalid");
      }
      this.remember(convId, text);
      return { convId, rev: entry.rev, folded: entry.folded, loaded: data.loaded, backfill: data.backfill ?? null };
    } catch {
      this.remove(convId);
      return null;
    }
  }

  /** Mark a view used now (opened), so it is the last to go. */
  touch(convId: string): void {
    const entry = this.scan().get(convId);
    if (!entry) return;
    entry.usedAt = Date.now();
    try { utimesSync(join(this.dir, entry.file), new Date(), new Date(entry.usedAt)); } catch { /* gone */ }
  }

  /**
   * Keep `view`. Serialized now, before UI handlers can mutate the events it
   * holds; written in the background. `usedAt` keeps a refresh from making
   * the view look recently opened.
   */
  put(view: CachedView, usedAt = Date.now()): void {
    const entries = this.scan();
    const json = JSON.stringify({ format: FORMAT, convId: view.convId, loaded: view.loaded, backfill: view.backfill });
    const bytes = Buffer.byteLength(json);
    const previous = entries.get(view.convId);
    if (bytes > this.limits.maxEntryBytes) {
      if (previous) this.remove(view.convId);
      return;
    }
    const file = fileName(view.convId, view.rev, view.folded);
    if (previous) this.bytes -= previous.bytes;
    const entry = { file, rev: view.rev, folded: view.folded, bytes, usedAt: Math.max(usedAt, previous?.usedAt ?? 0) };
    entries.set(view.convId, entry);
    this.bytes += bytes;
    this.remember(view.convId, json);
    const stale = previous && previous.file !== file ? previous.file : null;
    this.queueWrite(view.convId, async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = join(this.dir, `${file}.tmp-${process.pid}`);
      await writeFile(tmp, json);
      const time = new Date(entry.usedAt);
      await rename(tmp, join(this.dir, file));
      try { utimesSync(join(this.dir, file), time, time); } catch { /* replaced meanwhile */ }
      if (stale) await rm(join(this.dir, stale), { force: true });
    });
    this.evict();
  }

  remove(convId: string): void {
    const entry = this.scan().get(convId);
    this.texts.delete(convId);
    if (!entry) return;
    this.entries!.delete(convId);
    this.bytes -= entry.bytes;
    this.queueWrite(convId, () => rm(join(this.dir, entry.file), { force: true }));
  }

  /** Writes still in flight (tests, and a clean exit). */
  async flush(): Promise<void> {
    await Promise.all([...this.writes.values()]);
  }

  private queueWrite(convId: string, write: () => Promise<unknown>): void {
    const previous = this.writes.get(convId) ?? Promise.resolve();
    const next = previous.then(write).then(() => {}, () => {});
    this.writes.set(convId, next);
    void next.then(() => { if (this.writes.get(convId) === next) this.writes.delete(convId); });
  }

  private remember(convId: string, text: string): void {
    this.texts.delete(convId);
    this.texts.set(convId, text);
    while (this.texts.size > 4) this.texts.delete(this.texts.keys().next().value!);
  }

  private evict(): void {
    const entries = this.entries!;
    while (entries.size > this.limits.maxEntries || (entries.size > 0 && this.bytes > this.limits.maxBytes)) {
      let oldest: string | null = null;
      for (const [id, entry] of entries) if (oldest === null || entry.usedAt < entries.get(oldest)!.usedAt) oldest = id;
      this.remove(oldest!);
    }
  }
}

/** What the TUI is showing, for picking what to refresh and how to ask for it. */
export interface ViewCacheContext {
  /** The open conversation: it is kept current by its own subscription. */
  openConvId: string | null;
  /** The opening request a real open would send now, so a refreshed copy matches it. */
  request(convId: string): Pick<LoadCommand, "turns" | "viewport"> & { backfillTurns: number };
  /** The sidebar's summary flags; a conversation it does not list is not refreshed. */
  summary(convId: string): { streaming: boolean } | null;
}

/** Background refreshes in flight at once. */
const PEEK_CONCURRENCY = 2;
/** Most recently opened conversations kept current. */
const WARM_SET = 12;
/** Changes are refreshed this long after the last one, so a burst costs one fetch. */
const REFRESH_DELAY_MS = 1_500;
/** A peek unanswered this long (its answer was dropped) no longer holds its conversation back. */
const PEEK_TIMEOUT_MS = 30_000;

interface TrackedLoad {
  convId: string;
  folded: boolean;
  peek: boolean;
  backfillReqId: string | null;
}

/**
 * The session side of the cache for one remote route: which revisions are
 * current, which loads to record, and the background refreshes.
 */
export class ViewCache {
  /** Latest revision this connection has heard of, per conversation. */
  private latest = new Map<string, string>();
  /** Whether the daemon answers get_history_revisions (null: not yet known). */
  private supported: boolean | null = null;
  private revisionsReqId: string | null = null;
  private loads = new Map<string, TrackedLoad>();
  /** A load's answer waiting for its backfill page, by the backfill's reqId. */
  private awaitingBackfill = new Map<string, { loadReqId: string; view: CachedView }>();
  /** Peeks in flight: conversation → request id and when it was sent. */
  private peeks = new Map<string, { reqId: string; at: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextReqId = 0;
  private context: (() => ViewCacheContext) | null = null;
  private send: ((command: Command) => void) | null = null;

  constructor(readonly store: ViewCacheStore, private readonly refreshDelayMs = REFRESH_DELAY_MS) {}

  setContext(context: (() => ViewCacheContext) | null): void {
    this.context = context;
  }

  /** A new connection: revisions from the last one may be stale. Asks for the cached ones'. */
  connected(send: (command: Command) => void): void {
    this.reset();
    this.send = send;
    const ids = this.store.ids();
    if (ids.length === 0) return;
    this.revisionsReqId = `view_revs_${++this.nextReqId}_${Date.now()}`;
    send({ type: "get_history_revisions", reqId: this.revisionsReqId, convIds: ids.slice(0, 512) });
  }

  /** The connection ended: its answers will never come. */
  disconnected(): void {
    this.reset();
    this.loads.clear();
    this.awaitingBackfill.clear();
  }

  /** Forget what the last connection said. Loads sent ahead of this one (an SSH probe's) stay tracked. */
  private reset(): void {
    this.latest.clear();
    this.supported = null;
    this.revisionsReqId = null;
    for (const peek of this.peeks.values()) this.loads.delete(peek.reqId);
    this.peeks.clear();
    this.send = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The cached view of `convId` for a page folded like `folded`, if any. */
  view(convId: string, folded: boolean): CachedView | null {
    const view = this.store.get(convId);
    return view && view.folded === folded ? view : null;
  }

  /** Whether `view` is what the daemon would send now (as far as this connection knows). */
  isCurrent(view: CachedView): boolean {
    if (!view.rev || this.latest.get(view.convId) !== view.rev) return false;
    const summary = this.context?.().summary(view.convId);
    return summary !== null && summary !== undefined && !summary.streaming;
  }

  opened(convId: string): void {
    this.store.touch(convId);
  }

  /** Something changed what the working set should hold (left a conversation, a turn ended). */
  poke(): void {
    this.schedule();
  }

  /** Record what a load asked for, to keep its answer. */
  sent(command: Command): void {
    if (command.type !== "load_conversation" || !command.reqId) return;
    // Answers that never come (a dropped connection's) must not pile up.
    while (this.loads.size >= 64) this.loads.delete(this.loads.keys().next().value!);
    this.loads.set(command.reqId, {
      convId: command.convId,
      folded: command.viewport?.folded === true,
      peek: command.peek === true,
      backfillReqId: command.initialBackfill?.reqId ?? null,
    });
  }

  /**
   * Observe a canonical (already rebuilt) event. True when it was this
   * cache's own (a peek's pages, a revisions answer) and goes no further.
   */
  receive(event: Event): boolean {
    switch (event.type) {
      case "history_revisions": {
        if (event.reqId && event.reqId === this.revisionsReqId) {
          this.revisionsReqId = null;
          // The answer leaves out conversations deleted while this TUI was away.
          for (const convId of this.store.ids()) if (!(convId in event.revs)) this.store.remove(convId);
        }
        this.supported = true;
        for (const [convId, rev] of Object.entries(event.revs)) this.latest.set(convId, rev);
        this.schedule();
        return true;
      }
      case "error": {
        if (event.reqId && event.reqId === this.revisionsReqId) {
          // An older daemon: no revisions, so no copy is ever known current and nothing is peeked.
          this.revisionsReqId = null;
          this.supported = false;
          return true;
        }
        const load = event.reqId ? this.loads.get(event.reqId) : undefined;
        if (load) {
          this.loads.delete(event.reqId!);
          if (/not found/i.test(event.message)) this.store.remove(load.convId);
          if (load.peek) {
            this.peekDone(load.convId);
            return true;
          }
          return false;
        }
        const pending = event.reqId ? this.awaitingBackfill.get(event.reqId) : undefined;
        if (pending) {
          // Its backfill failed: keep the opening page alone.
          this.awaitingBackfill.delete(event.reqId!);
          const owner = this.loads.get(pending.loadReqId);
          this.loads.delete(pending.loadReqId);
          this.keep(pending.view, owner);
          if (owner?.peek) this.peekDone(pending.view.convId);
          return owner?.peek === true;
        }
        return false;
      }
      case "conversation_loaded": {
        const load = event.reqId ? this.loads.get(event.reqId) : undefined;
        if (!load || load.convId !== event.convId) return false;
        if (event.historyRev) {
          this.supported = true;
          this.latest.set(event.convId, event.historyRev);
        }
        const { reqId: _reqId, initialBackfillReqId, pendingAI: _pendingAI, queuedMessages: _queued, entryOrder: _order, ...loaded } = event;
        const view: CachedView = { convId: event.convId, rev: event.historyRev ?? null, folded: load.folded, loaded, backfill: null };
        if (initialBackfillReqId && initialBackfillReqId === load.backfillReqId) {
          // Kept once its backfill is here too: the pair is one view. UI
          // handlers may mutate this event before then; a peek's goes nowhere.
          this.awaitingBackfill.set(initialBackfillReqId, { loadReqId: event.reqId!, view: load.peek ? view : structuredClone(view) });
        } else {
          this.loads.delete(event.reqId!);
          this.keep(view, load);
          if (load.peek) this.peekDone(event.convId);
        }
        return load.peek;
      }
      case "conversation_history_loaded": {
        const pending = event.reqId ? this.awaitingBackfill.get(event.reqId) : undefined;
        if (!pending || pending.view.convId !== event.convId) return false;
        this.awaitingBackfill.delete(event.reqId!);
        const load = this.loads.get(pending.loadReqId);
        this.loads.delete(pending.loadReqId);
        const { reqId: _reqId, entryOrder: _order, ...backfill } = event;
        // A page built after a change is not the same snapshot as its opening page.
        if ((event.historyRev ?? null) === pending.view.rev) this.keep({ ...pending.view, backfill }, load);
        else this.keep(pending.view, load);
        if (load?.peek) {
          this.peekDone(event.convId);
          return true;
        }
        return false;
      }
      case "conversation_deleted":
        this.store.remove(event.convId);
        this.latest.delete(event.convId);
        return false;
      default:
        return false;
    }
  }

  private keep(view: CachedView, load: TrackedLoad | undefined): void {
    // A refresh is not a use: it must not keep a conversation nobody opens.
    const usedAt = load?.peek ? 0 : Date.now();
    this.store.put(view, usedAt);
  }

  private peekDone(convId: string): void {
    this.peeks.delete(convId);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || !this.send || this.supported !== true) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, this.refreshDelayMs);
    this.timer.unref?.();
  }

  /** Peek the stale views of the working set, a few at a time. */
  private refresh(): void {
    const send = this.send;
    const context = this.context?.();
    if (!send || !context || this.supported !== true) return;
    const now = Date.now();
    for (const [convId, peek] of this.peeks) {
      if (now - peek.at > PEEK_TIMEOUT_MS) {
        this.peeks.delete(convId);
        this.loads.delete(peek.reqId);
      }
    }
    for (const convId of this.store.ids().slice(0, WARM_SET)) {
      if (this.peeks.size >= PEEK_CONCURRENCY) break;
      if (this.peeks.has(convId) || convId === context.openConvId) continue;
      const latest = this.latest.get(convId);
      const rev = this.store.rev(convId);
      if (latest === undefined || latest === rev) continue;
      const summary = context.summary(convId);
      // A running turn changes it all the time; its end moves the revision again.
      if (!summary || summary.streaming) continue;
      const request = context.request(convId);
      const reqId = `view_peek_${++this.nextReqId}_${Date.now()}`;
      const command: LoadCommand = {
        type: "load_conversation",
        reqId,
        convId,
        peek: true,
        ...(request.turns !== undefined ? { turns: request.turns } : {}),
        ...(request.viewport ? { viewport: request.viewport } : {}),
        ...(request.backfillTurns > 0 ? { initialBackfill: { reqId: `view_peek_${++this.nextReqId}_${Date.now()}`, turns: request.backfillTurns } } : {}),
      };
      this.peeks.set(convId, { reqId, at: now });
      send(command);
    }
  }
}
