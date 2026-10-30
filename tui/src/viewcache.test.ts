import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryCache } from "./history-cache";
import { encodeHistoryDelta } from "@exocortex/shared/history-delta";
import type { Command, DisplayEntry, Event } from "./protocol";
import { ViewCache, ViewCacheStore, type CachedView, type ViewCacheContext } from "./viewcache";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "viewcache-"));
  dirs.push(dir);
  return dir;
}

const entry = (text: string, repeat = 300): DisplayEntry => ({ type: "user", text: text.repeat(repeat), metadata: null });
type Loaded = Extract<Event, { type: "conversation_loaded" }>;
type Page = Extract<Event, { type: "conversation_history_loaded" }>;
const loaded = (convId: string, reqId: string, rev: string, entries = [entry("a"), entry("b")], extra: Partial<Loaded> = {}): Loaded => ({
  type: "conversation_loaded", reqId, convId, provider: "openai", model: "gpt-5.4", effort: "high", fastMode: false,
  entries, historyStartIndex: 4, historyStartUserIndex: 2, historyTotalEntries: 6, hasOlderHistory: true,
  contextTokens: 10, toolOutputsIncluded: false, historyRev: rev, ...extra,
});
const page = (convId: string, reqId: string, rev: string, entries = [entry("o")]): Page => ({
  type: "conversation_history_loaded", reqId, convId, requestSource: "initial-backfill", entries,
  historyStartIndex: 0, historyStartUserIndex: 0, historyEndIndex: 4, historyTotalEntries: 6, hasOlderHistory: false, historyRev: rev,
});
const view = (convId: string, rev: string | null = "e.1", entries = [entry("a")]): CachedView => {
  const { reqId: _r, ...rest } = loaded(convId, "x", rev ?? "", entries);
  return { convId, rev, folded: true, loaded: rest as Loaded, backfill: null, live: null };
};
const open = (convId: string, reqId: string, peek = false): Extract<Command, { type: "load_conversation" }> => ({
  type: "load_conversation", reqId, convId, turns: 5, viewport: { rows: 40, cols: 100, folded: true },
  initialBackfill: { reqId: `${reqId}-b`, turns: 10 }, ...(peek ? { peek: true as const } : {}),
});

describe("on-disk view store", () => {
  test("keeps views across TUI restarts, keyed by conversation, revision and fold", async () => {
    const dir = tempDir();
    const store = new ViewCacheStore(dir);
    store.put(view("c1", "e.4"));
    store.put(view("c1", "e.5", [entry("new")]));
    await store.flush();
    expect(readdirSync(dir)).toEqual(["c1@e.5@f.json"]);
    const reopened = new ViewCacheStore(dir);
    expect(reopened.rev("c1")).toBe("e.5");
    expect(reopened.get("c1")!.loaded.entries).toEqual([entry("new")]);
    // Each get is its own copy: handlers mutate what they are given.
    (reopened.get("c1")!.loaded.entries[0] as { text: string }).text = "mutated";
    expect(reopened.get("c1")!.loaded.entries).toEqual([entry("new")]);
  });

  test("evicts the least recently used by count and bytes, and never keeps an oversized view", async () => {
    const dir = tempDir();
    const store = new ViewCacheStore(dir, { maxEntries: 2, maxBytes: 1_000_000, maxEntryBytes: 100_000 });
    store.put(view("old"), 1);
    store.put(view("mid"), 2);
    store.touch("old");
    store.put(view("new"), 3);
    expect(store.ids()).toEqual(["old", "new"]);
    store.put(view("huge", "e.1", [entry("x", 200_000)]));
    expect(store.has("huge")).toBe(false);
    await store.flush();
    expect(readdirSync(dir).sort()).toEqual(["new@e.1@f.json", "old@e.1@f.json"]);

    const small = new ViewCacheStore(tempDir(), { maxEntries: 10, maxBytes: 1_000, maxEntryBytes: 100_000 });
    small.put(view("a"), 1);
    small.put(view("b"), 2);
    expect(small.ids()).toEqual(["b"]);
  });

  test("drops damaged files, leftovers and duplicates instead of trusting them", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bad@e.1@f.json"), "{not json");
    writeFileSync(join(dir, "c@e.1@f.json.tmp-123"), "partial");
    writeFileSync(join(dir, "dup@e.1@f.json"), JSON.stringify({ format: 1, convId: "dup", loaded: view("dup").loaded, backfill: null }));
    writeFileSync(join(dir, "dup@e.2@f.json"), JSON.stringify({ format: 1, convId: "dup", loaded: view("dup").loaded, backfill: null }));
    utimesSync(join(dir, "dup@e.1@f.json"), new Date(1_000), new Date(1_000));
    writeFileSync(join(dir, "other@e.1@f.json"), JSON.stringify({ format: 1, convId: "someone-else", loaded: view("x").loaded }));
    const store = new ViewCacheStore(dir);
    expect(store.rev("dup")).toBe("e.2");
    expect(store.get("bad")).toBeNull();
    expect(store.get("other")).toBeNull();
    await store.flush();
    expect(readdirSync(dir)).toEqual(["dup@e.2@f.json"]);
  });
});

function session(options: { summaries?: Record<string, { streaming: boolean }>; openConvId?: string | null } = {}) {
  const store = new ViewCacheStore(tempDir());
  const cache = new ViewCache(store, 1);
  const sent: Command[] = [];
  const context: ViewCacheContext = {
    openConvId: options.openConvId ?? null,
    request: () => ({ turns: 5, viewport: { rows: 40, cols: 100, folded: true }, backfillTurns: 10 }),
    summary: id => options.summaries?.[id] ?? { streaming: false },
  };
  cache.setContext(() => context);
  const send = (command: Command) => { sent.push(command); cache.sent(command); };
  return { store, cache, sent, send, context };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(2);
  expect(done()).toBe(true);
}

describe("view cache session", () => {
  test("keeps an open's answer and its backfill as one view, current while the revision holds", () => {
    const { cache, store, send } = session();
    cache.connected(send);
    send(open("c", "r1"));
    expect(cache.receive(loaded("c", "r1", "e.7", undefined, { initialBackfillReqId: "r1-b", queuedMessages: [] }))).toBe(false);
    expect(store.has("c")).toBe(false);
    expect(cache.receive(page("c", "r1-b", "e.7"))).toBe(false);
    const kept = cache.view("c", true)!;
    expect(kept.rev).toBe("e.7");
    expect(kept.backfill?.entries).toEqual([entry("o")]);
    expect(kept.loaded).not.toHaveProperty("queuedMessages");
    expect(kept.loaded).not.toHaveProperty("reqId");
    expect(kept.live).toBeNull();
    expect(cache.view("c", false)).toBeNull();
    expect(cache.isCurrent(kept)).toBe(true);
    // Any change the daemon pushes makes it stale.
    cache.receive({ type: "history_revisions", revs: { c: "e.8" } });
    expect(cache.isCurrent(kept)).toBe(false);
  });

  test("pairs an older daemon's backfill too, which never makes its copy current", () => {
    const { cache, send } = session();
    cache.connected(send);
    send(open("c", "r1"));
    const { historyRev: _rev, ...legacy } = loaded("c", "r1", "", undefined, { initialBackfillReqId: "r1-b" });
    const { historyRev: _pageRev, ...legacyPage } = page("c", "r1-b", "");
    cache.receive(legacy);
    cache.receive(legacyPage);
    const kept = cache.view("c", true)!;
    expect(kept.rev).toBeNull();
    expect(kept.backfill?.entries).toEqual([entry("o")]);
    expect(cache.isCurrent(kept)).toBe(false);
  });

  test("never pairs a backfill built at another revision, and is never current while streaming", () => {
    const { cache, send } = session({ summaries: { c: { streaming: true } } });
    cache.connected(send);
    send(open("c", "r1"));
    cache.receive(loaded("c", "r1", "e.7", undefined, { initialBackfillReqId: "r1-b" }));
    cache.receive(page("c", "r1-b", "e.8"));
    const kept = cache.view("c", true)!;
    expect(kept.backfill).toBeNull();
    expect(cache.isCurrent(kept)).toBe(false);
  });

  test("a new connection forgets revisions, asks for the cached ones', and refreshes the stale working set with peeks", async () => {
    const { cache, store, sent, send } = session({ summaries: { busy: { streaming: true }, a: { streaming: false }, b: { streaming: false }, same: { streaming: false } }, openConvId: "open" });
    for (const id of ["a", "b", "busy", "open", "same"]) store.put(view(id, "e.1"), 1);
    store.touch("a");
    cache.connected(send);
    const ask = sent.find(command => command.type === "get_history_revisions") as Extract<Command, { type: "get_history_revisions" }>;
    expect(new Set(ask.convIds)).toEqual(new Set(["a", "b", "busy", "open", "same"]));
    expect(cache.receive({ type: "history_revisions", reqId: ask.reqId, revs: { a: "e.2", b: "e.1", busy: "e.1", open: "e.2", same: "e.1" } })).toBe(true);
    // The stale one, and the running one the daemon does not keep current yet; never the open or a current one.
    await until(() => sent.filter(command => command.type === "load_conversation").length === 2);
    const peeks = sent.filter(command => command.type === "load_conversation") as Array<Extract<Command, { type: "load_conversation" }>>;
    expect(peeks.map(peek => peek.convId).sort()).toEqual(["a", "busy"]);
    expect(peeks.every(peek => peek.peek === true && peek.watch === true && peek.viewport?.folded === true && peek.initialBackfill)).toBe(true);
    // A peek's pages are the cache's own and update the copy without making it look used.
    const before = store.ids();
    const peekA = peeks.find(peek => peek.convId === "a")!;
    expect(cache.receive(loaded("a", peekA.reqId!, "e.2", [entry("fresh")], { initialBackfillReqId: peekA.initialBackfill!.reqId }))).toBe(true);
    expect(cache.receive(page("a", peekA.initialBackfill!.reqId, "e.2"))).toBe(true);
    expect(cache.view("a", true)!.loaded.entries).toEqual([entry("fresh")]);
    expect(cache.isCurrent(cache.view("a", true)!)).toBe(true);
    expect(store.ids()).toEqual(before);
  });

  test("an older daemon gets no peeks and its copies are never current", async () => {
    const { cache, store, sent, send } = session();
    store.put(view("a", null));
    cache.connected(send);
    const ask = sent[0] as Extract<Command, { type: "get_history_revisions" }>;
    expect(cache.receive({ type: "error", reqId: ask.reqId, message: "Unknown command: get_history_revisions" })).toBe(true);
    cache.poke();
    await Bun.sleep(5);
    expect(sent).toHaveLength(1);
    expect(cache.isCurrent(cache.view("a", true)!)).toBe(false);
  });

  test("a deleted conversation's copy goes", () => {
    const { cache, store, sent, send } = session();
    store.put(view("gone"));
    store.put(view("missing"));
    store.put(view("deleted-while-away"));
    cache.connected(send);
    const ask = sent[0] as Extract<Command, { type: "get_history_revisions" }>;
    cache.receive({ type: "history_revisions", reqId: ask.reqId, revs: { gone: "e.1", missing: "e.1" } });
    expect(store.has("deleted-while-away")).toBe(false);
    cache.receive({ type: "conversation_deleted", convId: "gone" });
    send(open("missing", "r2"));
    cache.receive({ type: "error", reqId: "r2", convId: "missing", message: "Conversation missing not found" });
    expect(store.has("gone")).toBe(false);
    expect(store.has("missing")).toBe(false);
  });

  test("seeds the transport cache, so a fresh TUI's open still gets a delta", () => {
    const history = new HistoryCache();
    const kept = view("c", "e.1", [entry("a"), entry("b")]);
    const command = open("c", "r1");
    history.seed(command, kept.loaded, null);
    const prepared = history.prepare(command);
    expect(prepared.cachedEntryHashes).toHaveLength(2);
    const answer = loaded("c", "r1", "e.2", [entry("a"), entry("b"), entry("c")]);
    const delta = encodeHistoryDelta(answer, prepared.cachedEntryHashes);
    expect(delta.entries).toEqual([entry("c")]);
    expect(history.receive(delta, () => { throw new Error("retry"); })).toEqual(answer);
    // A copy kept newer than the last answer (pushes, peeks) replaces it as the base.
    const newer = view("c", "e.3", [entry("a"), entry("b"), entry("c"), entry("d")]);
    history.seed(open("c", "r2"), newer.loaded, null);
    expect(history.prepare(open("c", "r2")).cachedEntryHashes).toHaveLength(4);
  });
});

describe("copies kept current by pushes", () => {
  const thinking = (text: string) => ({ type: "thinking" as const, text });
  const live = (blocks: Array<ReturnType<typeof thinking>>) => ({ blocks, blockOffset: 0, metadata: null });

  /** An open answered with copy number `copySeq`, a running turn's live part included. */
  function watched(copySeq = 1) {
    const s = session({ summaries: { c: { streaming: true } } });
    s.cache.connected(s.send);
    s.send(s.cache.prepare(open("c", "r1")));
    s.cache.receive(loaded("c", "r1", "e.1", [entry("a"), entry("b")], { copySeq, initialBackfillReqId: "r1-b",
      pendingAI: { blocks: [thinking("Look"), { type: "tool_result", toolCallId: "t", toolName: "bash", output: "big", isError: false }], blockOffset: 2, metadata: null } }));
    s.cache.receive(page("c", "r1-b", "e.1"));
    return s;
  }

  test("keep a running turn's live part without tool output; current while the daemon keeps it so and the turn runs", () => {
    const { cache } = watched();
    const kept = cache.view("c", true)!;
    expect(kept.live).toEqual({ blocks: [thinking("Look"), { type: "tool_result", toolCallId: "t", toolName: "bash", output: "", isError: false }], blockOffset: 2, metadata: null });
    expect(cache.isCurrent(kept)).toBe(true);
    // Left after being open: current again once the daemon's push confirms it.
    cache.left("c");
    expect(cache.isCurrent(cache.view("c", true)!)).toBe(false);
    cache.receive({ type: "history_push", convId: "c", base: 1, copySeq: 2 });
    expect(cache.isCurrent(cache.view("c", true)!)).toBe(true);
    cache.receive({ type: "history_push", convId: "c", unwatched: true });
    expect(cache.isCurrent(kept)).toBe(false);
  });

  test("apply pushes to the copy they were built against: page, backfill and live text", () => {
    const { cache } = watched(1);
    expect(cache.receive({ type: "history_push", convId: "c", base: 1, copySeq: 2, live: { blocksBase: { keep: 0, extend: "ing closer" }, blocks: [], blockOffset: 2, metadata: null } })).toBe(true);
    expect(cache.view("c", true)!.live!.blocks).toEqual([thinking("Looking closer")]);
    const nextPage = { ...loaded("c", "", "e.2", [entry("c")]), entryOrder: [-2, 0], reqId: undefined };
    cache.receive({ type: "history_push", convId: "c", base: 2, copySeq: 3, rev: "e.2", loaded: nextPage, backfill: null, live: null });
    const after = cache.view("c", true)!;
    expect(after.loaded.entries).toEqual([entry("b"), entry("c")]);
    expect(after.backfill).toBeNull();
    expect(after.live).toBeNull();
    expect(after.rev).toBe("e.2");
  });

  test("refresh a copy whose push cannot apply, and ask again for a live part that cannot be rebuilt", async () => {
    const { cache, sent, send, store } = watched(1);
    cache.receive({ type: "history_push", convId: "c", base: 7, copySeq: 8, live: null });
    expect(cache.isCurrent(cache.view("c", true)!)).toBe(false);
    cache.receive({ type: "history_revisions", revs: { c: "e.1" } });
    await until(() => sent.some(command => command.type === "load_conversation" && command.peek));
    const peek = sent.find(command => command.type === "load_conversation" && command.peek) as Extract<Command, { type: "load_conversation" }>;
    expect(peek.watch).toBe(true);
    expect(peek.liveBase?.hashes).toHaveLength(2);

    const retried: Command[] = [];
    send(cache.prepare(open("c", "r9")));
    const bad = loaded("c", "r9", "e.1", undefined, { pendingAI: { blocksBase: { keep: 5 }, blocks: [], blockOffset: 2, metadata: null } });
    expect(cache.receive(bad, command => retried.push(command))).toBe(true);
    expect(retried).toHaveLength(1);
    expect(retried[0]).not.toHaveProperty("liveBase");
    expect(store.get("c")!.live).toBeNull();
  });

  test("an open's live part comes against the copy's and is rebuilt before anything sees it", () => {
    const { cache, send } = watched(1);
    const command = cache.prepare(open("c", "r2"));
    expect(command.liveBase?.tailChars).toBeUndefined();
    send(command);
    const answer = loaded("c", "r2", "e.1", undefined, { copySeq: 4, pendingAI: { blocksBase: { keep: 2 }, blocks: [thinking("more")], blockOffset: 2, metadata: null } });
    expect(cache.receive(answer)).toBe(false);
    expect(answer.pendingAI!.blocks.map(block => block.type)).toEqual(["thinking", "tool_result", "thinking"]);
    expect(answer.pendingAI).not.toHaveProperty("blocksBase");
  });

  test("an open names a watched copy by number, and its answer is rebuilt from that copy first", () => {
    const { cache, send } = watched(1);
    const command = cache.prepare(open("c", "r3"));
    expect(command.baseCopy).toBe(1);
    expect(command).not.toHaveProperty("liveBase");
    send(command);
    const fromCopy = { ...loaded("c", "r3", "e.1", []), entryOrder: [-1, -2], baseCopy: 1, initialBackfillReqId: "r3-b",
      pendingAI: { blocksBase: { keep: 1 }, blocks: [], blockOffset: 2, metadata: null } };
    const rebuilt = cache.decodeCopyAnswer(fromCopy) as Loaded;
    expect(rebuilt.entries).toEqual([entry("a"), entry("b")]);
    expect(rebuilt).not.toHaveProperty("baseCopy");
    expect(cache.receive(rebuilt)).toBe(false);
    expect(rebuilt.pendingAI!.blocks).toEqual([thinking("Look")]);
    const backfill = cache.decodeCopyAnswer({ ...page("c", "r3-b", "e.1", []), entryOrder: [-1], baseCopy: 1 }) as Page;
    expect(backfill.entries).toEqual([entry("o")]);
    // One that cannot be rebuilt is asked for again plainly, and the copy is no longer named.
    const retried: Command[] = [];
    send(cache.prepare(open("c", "r4")));
    expect(cache.decodeCopyAnswer({ ...loaded("c", "r4", "e.1", []), entryOrder: [-9], baseCopy: 1 }, command => retried.push(command))).toBeNull();
    expect(retried[0]).not.toHaveProperty("baseCopy");
    expect(cache.prepare(open("c", "r5"))).not.toHaveProperty("baseCopy");
  });

  test("write pushed copies lazily, and all of them on exit; a restarted TUI reads them as not known current", async () => {
    const dir = tempDir();
    const store = new ViewCacheStore(dir, undefined, 60_000);
    store.put(view("c"));
    await store.flush();
    store.put({ ...view("c", "e.2"), live: live([thinking("streaming")]) }, 0, true);
    expect(store.get("c")!.live!.blocks).toEqual([thinking("streaming")]);
    expect(readdirSync(dir)).toEqual(["c@e.1@f.json"]);
    store.flushSync();
    expect(readdirSync(dir)).toEqual(["c@e.2@f.json"]);
    const restarted = new ViewCache(new ViewCacheStore(dir));
    restarted.setContext(() => ({ openConvId: null, request: () => ({ backfillTurns: 0 }), summary: () => ({ streaming: true }) }));
    const reread = restarted.view("c", true)!;
    expect(reread.live!.blocks).toEqual([thinking("streaming")]);
    expect(restarted.isCurrent(reread)).toBe(false);
  });
});
