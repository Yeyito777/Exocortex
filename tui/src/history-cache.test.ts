import { describe, expect, test } from "bun:test";
import { encodeHistoryDelta, historyEntryHash } from "@exocortex/shared/history-delta";
import type { HistoryResponse } from "@exocortex/shared/history-delta";
import type { DisplayEntry, LoadConversationCommand, LoadConversationHistoryCommand } from "./protocol";
import { HistoryCache } from "./history-cache";

const entry = (text: string): DisplayEntry => ({ type: "user", text: text.repeat(1024), metadata: null });
const request = (reqId: string, convId = "a"): LoadConversationCommand => ({ type: "load_conversation", reqId, convId, turns: 5 });
const response = (reqId: string, entries = [entry("a"), entry("b")], convId = "a"): HistoryResponse => ({
  type: "conversation_loaded", reqId, convId, provider: "openai", model: "gpt-5.4", effort: "high",
  fastMode: false, entries, contextTokens: 123, toolOutputsIncluded: false,
  historyStartIndex: 10, historyTotalEntries: 12, hasOlderHistory: true,
});
const noRetry = () => { throw new Error("unexpected retry"); };

describe("content-checked remote history cache", () => {
  test("reuses entries but always applies fresh metadata and pending streaming blocks", () => {
    const cache = new HistoryCache();
    expect(cache.prepare(request("1")).cachedEntryHashes).toBeUndefined();
    cache.receive(response("1"), noRetry);
    const cmd = cache.prepare(request("2"));
    const fresh = { ...response("2"), contextTokens: 999, goalReviewing: true,
      pendingAI: { blocks: [{ type: "text" as const, text: "fresh stream" }], metadata: null } };
    const delta = encodeHistoryDelta(fresh, cmd.cachedEntryHashes);
    expect(delta.entries).toEqual([]);
    expect(delta.entryOrder).toEqual([-1, -2]);
    expect(cache.receive(delta, noRetry)).toEqual(fresh);
  });

  test("incrementally handles appends, edits, window shifts, truncation and duplicate entries", () => {
    const cache = new HistoryCache();
    const windows = [[entry("a"), entry("b")], [entry("a"), entry("b"), entry("c")],
      [entry("edited"), entry("b"), entry("c")], [entry("b"), entry("c")],
      [entry("b")], [entry("b"), entry("b")], []];
    for (const [i, entries] of windows.entries()) {
      const cmd = cache.prepare(request(String(i)));
      const full = response(String(i), entries);
      expect(cache.receive(encodeHistoryDelta(full, cmd.cachedEntryHashes), noRetry)).toEqual(full);
    }
  });

  test("caches initial backfill and viewport pages separately from opening windows", () => {
    const cache = new HistoryCache();
    const cmd: LoadConversationHistoryCommand = { type: "load_conversation_history", reqId: "1", convId: "a",
      beforeEntryIndex: 10, turns: 10, requestSource: "initial-backfill" };
    const full: HistoryResponse = { type: "conversation_history_loaded", reqId: "1", convId: "a",
      entries: [entry("older")], historyStartIndex: 0, historyStartUserIndex: 0,
      historyEndIndex: 10, historyTotalEntries: 12, hasOlderHistory: false, requestSource: "initial-backfill" };
    cache.prepare(cmd);
    cache.receive(full, noRetry);
    const second = cache.prepare({ ...cmd, reqId: "2", requestSource: "viewport" });
    const updated = { ...full, reqId: "2", requestSource: "viewport" as const };
    expect(encodeHistoryDelta(updated, second.cachedEntryHashes).entries).toEqual([]);
    expect(cache.receive(encodeHistoryDelta(updated, second.cachedEntryHashes), noRetry)).toEqual(updated);
    expect(cache.prepare(request("3")).cachedEntryHashes).toBeUndefined();
    expect(cache.prepare({ ...cmd, reqId: "4", beforeEntryIndex: 9 }).cachedEntryHashes).toBeUndefined();
  });

  test("pins exact bases across concurrent responses, LRU eviction and UI mutation", () => {
    const cache = new HistoryCache(100_000, 1);
    const first = response("1");
    cache.prepare(request("1"));
    cache.receive(first, noRetry);
    (first.entries[0] as { text: string }).text = "mutated by UI";
    const a = cache.prepare(request("2"));
    const b = cache.prepare(request("3"));
    cache.prepare(request("4", "b"));
    cache.receive(response("4", [entry("other")], "b"), noRetry);
    const updated = response("3", [entry("new"), entry("b")]);
    expect(cache.receive(encodeHistoryDelta(updated, b.cachedEntryHashes), noRetry)).toEqual(updated);
    expect(cache.receive(encodeHistoryDelta(response("2"), a.cachedEntryHashes), noRetry)).toEqual(response("2"));
  });

  test("bounds memory and pending requests; clears endpoint state; preserves cache across reconnect", () => {
    const tiny = new HistoryCache(20);
    tiny.prepare(request("1")); tiny.receive(response("1"), noRetry);
    expect(tiny.prepare(request("2")).cachedEntryHashes).toBeUndefined();
    const cache = new HistoryCache();
    cache.prepare(request("1")); cache.receive(response("1"), noRetry);
    for (let i = 0; i < 64; i++) expect(cache.prepare(request(`pending-${i}`)).cachedEntryHashes).toBeDefined();
    expect(cache.prepare(request("overflow")).cachedEntryHashes).toBeUndefined();
    cache.resetPending();
    expect(cache.prepare(request("reconnect")).cachedEntryHashes).toBeDefined();
    cache.clear();
    expect(cache.prepare(request("route-switch")).cachedEntryHashes).toBeUndefined();
  });

  test("limits pinned bytes even when LRU pages fit; errors release pins", () => {
    const cache = new HistoryCache(5000);
    cache.prepare(request("1")); cache.receive(response("1"), noRetry);
    expect(cache.prepare(request("2")).cachedEntryHashes).toBeDefined();
    expect(cache.prepare(request("3")).cachedEntryHashes).toBeUndefined();
    cache.receive({ type: "error", reqId: "2", message: "deleted" }, noRetry);
    expect(cache.prepare(request("4")).cachedEntryHashes).toBeDefined();
  });

  test("falls back once on invalid delta using the same request id", () => {
    const cache = new HistoryCache();
    cache.prepare(request("1")); cache.receive(response("1"), noRetry);
    cache.prepare(request("2"));
    const retried: LoadConversationCommand[] = [];
    const bad = { ...response("2", []), entryOrder: [-999] };
    expect(cache.receive(bad, cmd => retried.push(cache.prepare(cmd) as LoadConversationCommand))).toBeNull();
    expect(retried).toEqual([request("2")]);
    expect(cache.receive(response("2"), noRetry)).toEqual(response("2"));
  });

  test("legacy responses work and unsolicited refreshes cannot overwrite request bases", () => {
    const cache = new HistoryCache();
    cache.prepare(request("1")); cache.receive(response("1"), noRetry);
    cache.prepare(request("2"));
    const unsolicited = { ...response("unknown"), entries: [entry("not cached")] };
    expect(cache.receive(unsolicited, noRetry)).toBe(unsolicited);
    expect(cache.receive(response("2"), noRetry)).toEqual(response("2"));
    expect(encodeHistoryDelta(response("2"))).not.toHaveProperty("entryOrder");
    for (const invalid of [["bad"], Array(2049).fill("a".repeat(64)), [42]]) {
      expect(encodeHistoryDelta(response("2"), invalid as string[])).not.toHaveProperty("entryOrder");
    }
  });

  test("avoids caching tiny entries and omits deltas that do not save bytes", () => {
    const full = response("1", [{ type: "user", text: "hi", metadata: null }]);
    const cache = new HistoryCache();
    cache.prepare(request("1")); cache.receive(full, noRetry);
    expect(cache.prepare(request("2")).cachedEntryHashes).toBeUndefined();
    expect(encodeHistoryDelta(full, full.entries.map(e => historyEntryHash(JSON.stringify(e))))).toBe(full);
  });

  test("large unchanged windows avoid over 99% of transcript bytes including request hashes", () => {
    const cache = new HistoryCache();
    const entries = Array.from({ length: 15 }, (_, i) => entry(`${i}:` + "x".repeat(100)));
    cache.prepare(request("1")); cache.receive(response("1", entries), noRetry);
    const cmd = cache.prepare(request("2"));
    const full = response("2", entries);
    const delta = encodeHistoryDelta(full, cmd.cachedEntryHashes);
    const wireBytes = JSON.stringify(delta).length + JSON.stringify(cmd).length;
    expect(wireBytes).toBeLessThan(JSON.stringify(full).length / 100);
    expect(cache.receive(delta, noRetry)).toEqual(full);
  });
});
