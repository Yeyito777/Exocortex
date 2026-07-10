import { describe, expect, test } from "bun:test";
import type { DisplayEntry } from "./display";
import { buildHistoryUpdatedEvents, pageDisplayHistory } from "./history-pagination";

function user(text: string): DisplayEntry {
  return { type: "user", text };
}

function ai(text: string): DisplayEntry {
  return { type: "ai", blocks: [{ type: "text", text }], metadata: null };
}

describe("pageDisplayHistory", () => {
  test("returns the newest requested user turns and pins instructions", () => {
    const entries: DisplayEntry[] = [
      { type: "system_instructions", text: "rules" },
      user("u1"), ai("a1"), user("u2"), ai("a2"), user("u3"), ai("a3"),
    ];

    expect(pageDisplayHistory(entries, 2)).toEqual({
      pinnedEntries: [{ type: "system_instructions", text: "rules" }],
      entries: [user("u2"), ai("a2"), user("u3"), ai("a3")],
      startIndex: 2,
      startUserIndex: 1,
      endIndex: 6,
      totalEntries: 6,
      hasOlder: true,
    });
  });

  test("loads the page immediately before an absolute cursor", () => {
    const entries: DisplayEntry[] = [
      user("u1"), ai("a1"),
      { type: "system", text: "between" },
      user("u2"), ai("a2"), user("u3"), ai("a3"),
    ];

    const newest = pageDisplayHistory(entries, 1);
    const older = pageDisplayHistory(entries, 1, newest.startIndex);

    expect(newest.entries).toEqual([user("u3"), ai("a3")]);
    expect(older.entries).toEqual([user("u2"), ai("a2")]);
    expect(older).toMatchObject({ startIndex: 3, endIndex: 5, hasOlder: true });
  });

  test("includes a pre-turn prefix when the oldest page is reached", () => {
    const entries: DisplayEntry[] = [
      { type: "system", text: "created" }, user("u1"), ai("a1"), user("u2"), ai("a2"),
    ];

    expect(pageDisplayHistory(entries, 10)).toMatchObject({
      entries,
      startIndex: 0,
      endIndex: entries.length,
      hasOlder: false,
    });
  });
});

describe("buildHistoryUpdatedEvents", () => {
  test("keeps legacy subscribers full while bounding pagination-aware subscribers", () => {
    const entries: DisplayEntry[] = [];
    for (let turn = 1; turn <= 20; turn++) entries.push(user(`u${turn}`), ai(`a${turn}`));

    const events = buildHistoryUpdatedEvents({
      convId: "conv-1",
      provider: "openai",
      model: "gpt-5.4",
      effort: "high",
      fastMode: false,
      entries,
      contextTokens: 123,
      toolOutputsIncluded: false,
    });

    expect(events.legacy.entries).toHaveLength(40);
    expect(events.legacy).not.toHaveProperty("historyStartIndex");
    expect(events.paginated.entries).toHaveLength(30);
    expect(events.paginated).toMatchObject({
      historyStartIndex: 10,
      historyStartUserIndex: 5,
      historyTotalEntries: 40,
      hasOlderHistory: true,
    });
  });
});
