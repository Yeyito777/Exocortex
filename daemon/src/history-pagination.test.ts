import { describe, expect, test } from "bun:test";
import type { DisplayEntry } from "./display";
import type { HistoryUpdatedEvent } from "./protocol";
import {
  budgetHistoryUpdatedEvent,
  buildHistoryUpdatedEvents,
  buildStoredHistoryUpdatedEvent,
  pageDisplayHistory,
  type DisplayHistoryPage,
} from "./history-pagination";

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
      startBlockIndex: 0,
      startUserIndex: 1,
      endIndex: 6,
      endBlockIndex: 0,
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

/** One agent turn: `rounds` thinking + tool call/result rounds, then a final answer. */
function agentTurn(rounds: number, thinkingChars = 1000): DisplayEntry {
  const blocks: Extract<DisplayEntry, { type: "ai" }>["blocks"] = [];
  for (let round = 0; round < rounds; round++) {
    blocks.push(
      { type: "thinking", text: `round ${round} `.padEnd(thinkingChars, "x") },
      { type: "tool_call", toolCallId: `call-${round}`, toolName: "Bash", input: { command: "ls" }, summary: "ls" },
      { type: "tool_result", toolCallId: `call-${round}`, toolName: "Bash", output: "", isError: false },
    );
  }
  blocks.push({ type: "text", text: "done" });
  return { type: "ai", blocks, metadata: { startedAt: 1, endedAt: 2, model: "claude-opus-5-5", tokens: 99 } };
}

/** Walk every older page from the newest one, as a client scrolling up does. */
function walkPages(entries: DisplayEntry[], turns: number, byteBudget: number): DisplayHistoryPage[] {
  const pages = [pageDisplayHistory(entries, turns, undefined, { byteBudget })];
  while (pages.at(-1)!.hasOlder) {
    const newest = pages.at(-1)!;
    pages.push(pageDisplayHistory(entries, turns, newest.startIndex, { byteBudget, beforeBlockIndex: newest.startBlockIndex }));
    if (pages.length > 1_000) throw new Error("pagination did not terminate");
  }
  return pages;
}

/** Reassemble pages the way the TUI does: an end-partial entry joins the next page's first entry. */
function reassemble(pages: DisplayHistoryPage[]): DisplayEntry[] {
  let joined: DisplayEntry[] = [];
  for (const page of pages) {
    const newer = joined;
    const older = [...page.entries];
    const head = older.at(-1);
    if (page.endBlockIndex > 0 && head?.type === "ai" && newer[0]?.type === "ai") {
      older.pop();
      newer[0] = { ...newer[0], blocks: [...head.blocks, ...newer[0].blocks] };
    }
    joined = [...older, ...newer];
  }
  return joined;
}

describe("byte-budgeted pagination", () => {
  test("pages a long agent turn by tool rounds and reassembles it exactly", () => {
    const entries: DisplayEntry[] = [user("u1"), agentTurn(3), user("u2"), agentTurn(200)];
    const pages = walkPages(entries, 5, 32 * 1024);

    expect(pages.length).toBeGreaterThan(5);
    expect(reassemble(pages)).toEqual(entries);
    for (const page of pages) {
      expect(JSON.stringify(page.entries).length).toBeLessThan(40 * 1024);
      const first = page.entries[0];
      if (page.startBlockIndex > 0) {
        // Windows begin at a round start, so a tool call is never split from its result.
        expect(first?.type).toBe("ai");
        if (first?.type === "ai") expect(first.blocks[0]?.type).toBe("thinking");
      }
    }
    // The newest window keeps the turn's metadata for its footer.
    const newestTail = pages[0]!.entries.at(-1);
    expect(newestTail?.type === "ai" ? newestTail.metadata?.tokens : null).toBe(99);
  });

  test("always includes at least one round even when it exceeds the budget", () => {
    const entries: DisplayEntry[] = [user("u1"), agentTurn(4, 5000)];
    const newest = pageDisplayHistory(entries, 5, undefined, { byteBudget: 10 });
    // The final answer after the last tool result is the newest round.
    expect(newest).toMatchObject({ startIndex: 1, startBlockIndex: 12, hasOlder: true });
    const older = pageDisplayHistory(entries, 5, 1, { byteBudget: 10, beforeBlockIndex: 12 });
    expect(older).toMatchObject({ startIndex: 1, startBlockIndex: 9, endIndex: 1, endBlockIndex: 12 });
    expect(older.entries[0]?.type === "ai" ? older.entries[0].blocks.map((block) => block.type) : [])
      .toEqual(["thinking", "tool_call", "tool_result"]);
    expect(reassemble(walkPages(entries, 5, 10))).toEqual(entries);
  });

  test("still stops at the requested user-turn count", () => {
    const entries: DisplayEntry[] = [user("u1"), ai("a1"), user("u2"), ai("a2"), user("u3"), ai("a3")];

    expect(pageDisplayHistory(entries, 1, undefined, { byteBudget: 1024 * 1024 })).toMatchObject({
      entries: [user("u3"), ai("a3")],
      startIndex: 4,
      startBlockIndex: 0,
      startUserIndex: 2,
    });
  });

  test("bounds a canonical refresh while preserving pinned entries and cursors", () => {
    const pinned: DisplayEntry = { type: "system_instructions", text: "rules" };
    const event: HistoryUpdatedEvent = {
      type: "history_updated",
      convId: "conv-1",
      entries: [pinned, user("u10"), agentTurn(3), user("u11"), agentTurn(200)],
      historyStartIndex: 18,
      historyStartUserIndex: 9,
      historyTotalEntries: 22,
      hasOlderHistory: true,
      contextTokens: null,
      toolOutputsIncluded: false,
    };

    const bounded = budgetHistoryUpdatedEvent(event, 32 * 1024);

    expect(bounded.entries[0]).toEqual(pinned);
    expect(bounded.entries).toHaveLength(2);
    expect(bounded).toMatchObject({ historyStartIndex: 21, historyStartUserIndex: 11, hasOlderHistory: true });
    expect(bounded.historyStartBlockIndex).toBeGreaterThan(0);
    expect(budgetHistoryUpdatedEvent({ ...event, entries: [pinned, user("u1"), ai("a1")] })).toEqual({
      ...event,
      entries: [pinned, user("u1"), ai("a1")],
    });
  });
});

describe("buildHistoryUpdatedEvents", () => {
  test("builds a canonical refresh directly from a stored page", () => {
    const event = buildStoredHistoryUpdatedEvent({
      convId: "conv-page",
      provider: "openai",
      model: "gpt-5.4",
      effort: "medium",
      fastMode: false,
      contextTokens: 42,
      toolOutputsIncluded: false,
      pinnedEntries: [{ type: "system_instructions", text: "rules" }],
      entries: [user("u20"), ai("a20")],
      startIndex: 38,
      startBlockIndex: 0,
      startUserIndex: 19,
      endIndex: 40,
      endBlockIndex: 0,
      totalEntries: 40,
      hasOlder: true,
      source: {
        baseMtimeMs: 1,
        baseCtimeMs: 1,
        baseSize: 100,
        unwindSize: 0,
        unwindMtimeMs: 0,
        unwindHash: "none",
      },
      storedMessageCount: 40,
    });

    expect(event).toMatchObject({
      type: "history_updated",
      convId: "conv-page",
      entries: [{ type: "system_instructions", text: "rules" }, user("u20"), ai("a20")],
      historyStartIndex: 38,
      historyStartUserIndex: 19,
      historyTotalEntries: 40,
      hasOlderHistory: true,
      contextTokens: 42,
      toolOutputsIncluded: false,
      pendingAI: null,
    });
  });

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
