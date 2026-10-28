import { describe, expect, test } from "bun:test";
import type { DisplayEntry } from "./display";
import type { HistoryUpdatedEvent } from "./protocol";
import {
  budgetHistoryUpdatedEvent,
  buildHistoryUpdatedEvents,
  buildStoredHistoryUpdatedEvent,
  elideFoldedWork,
  estimateEntryRows,
  estimateFoldedEntryRows,
  isValidHistoryViewport,
  OPENING_WINDOW_VIEWPORTS,
  pageDisplayHistory,
  type DisplayHistoryPage,
  type HistoryViewport,
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

describe("viewport-sized opening windows", () => {
  const viewport: HistoryViewport = { rows: 40, cols: 100 };
  const target = viewport.rows * OPENING_WINDOW_VIEWPORTS;
  const open = (entries: DisplayEntry[], byteBudget = 128 * 1024) =>
    pageDisplayHistory(entries, 100, undefined, { byteBudget, viewport });
  const rows = (entries: DisplayEntry[]) => entries.reduce((total, entry) => total + estimateEntryRows(entry, viewport.cols), 0);
  const shortTurns = (count: number) =>
    Array.from({ length: count }, (_, turn) => [user(`u${turn}`), ai(`a${turn}`)]).flat();
  const image = (bytes: number) => ({
    mediaType: "image/png" as const,
    base64: "A".repeat(bytes),
    sizeBytes: bytes,
    imageId: `img-${bytes}`,
    width: 800,
    height: 600,
  });

  test("returns a short conversation whole", () => {
    const entries = shortTurns(4);
    expect(open(entries)).toMatchObject({ entries, startIndex: 0, startBlockIndex: 0, hasOlder: false });
  });

  test("covers two screens of rendered rows and stops there", () => {
    const entries = shortTurns(200);
    const page = open(entries);
    expect(rows(page.entries)).toBeGreaterThanOrEqual(target);
    // Without its oldest entry the window would fall short: no more than needed.
    expect(rows(page.entries.slice(1))).toBeLessThan(target);
    expect(page.hasOlder).toBe(true);
    // Far more turns than the 5-turn default, far fewer than the 100 allowed.
    expect(page.startUserIndex).toBeLessThan(200 - 5);
    expect(page.startUserIndex).toBeGreaterThan(100);
  });

  test("counts a tool-heavy turn by its collapsed calls, not its tool payloads", () => {
    const toolTurn = (rounds: number): DisplayEntry => ({
      type: "ai",
      blocks: Array.from({ length: rounds }, (_, round) => [
        { type: "tool_call" as const, toolCallId: `c${round}`, toolName: "apply_patch", input: { patch: "x".repeat(800) }, summary: "Edit src/a.ts" },
        // Display entries never carry tool outputs; they are fetched on expansion.
        { type: "tool_result" as const, toolCallId: `c${round}`, toolName: "apply_patch", output: "", isError: false },
      ]).flat(),
      metadata: null,
    });
    // One summary row per call; patch bodies and results add no rows.
    expect(estimateEntryRows(toolTurn(10), viewport.cols)).toBe(10 + 1);
    const entries = Array.from({ length: 30 }, (_, turn) => [user(`u${turn}`), toolTurn(10)]).flat();
    const page = open(entries);
    // Six whole 13-row turns, then the rounds of the next reply that complete the target.
    expect(rows(page.entries)).toBeGreaterThanOrEqual(target);
    expect(rows(page.entries)).toBeLessThan(target + 2);
    expect(page.entries.filter((entry) => entry.type === "user")).toHaveLength(6);
    expect(page.startBlockIndex % 2).toBe(0);
    expect(page.startBlockIndex).toBeGreaterThan(0);
  });

  test("counts a long non-shell tool call as the TUI's collapsed rows", () => {
    const call = (toolName: string, lines: number): DisplayEntry => ({
      type: "ai",
      blocks: [{ type: "tool_call", toolCallId: "c", toolName, input: {}, summary: Array.from({ length: lines }, (_, i) => `line ${i}`).join("\n") }],
      metadata: null,
    });
    // A long subagent prompt shows 8 rows and an expand hint; shell commands show in full.
    expect(estimateEntryRows(call("exo", 80), viewport.cols)).toBe(9 + 1);
    expect(estimateEntryRows(call("exo", 12), viewport.cols)).toBe(12 + 1);
    expect(estimateEntryRows(call("Bash", 80), viewport.cols)).toBe(80 + 1);
  });

  test("cuts a newest turn taller than two screens at the round that fills them", () => {
    const entries: DisplayEntry[] = [user("u1"), ai("a1"), user("u2"), agentTurn(100, 500)];
    const page = open(entries);
    expect(page).toMatchObject({ startIndex: 3, hasOlder: true });
    expect(page.startBlockIndex).toBeGreaterThan(0);
    expect(page.entries).toHaveLength(1);
    expect(rows(page.entries)).toBeGreaterThanOrEqual(target);
    // Each round is several rows, so starting one round later would fall short.
    const tail = page.entries[0]!;
    if (tail.type === "ai") expect(rows([{ ...tail, blocks: tail.blocks.slice(3) }])).toBeLessThan(target);
    expect(JSON.stringify(page.entries).length).toBeLessThan(32 * 1024);
    // Older pages continue from the cut and the turn reassembles exactly.
    const pages = [page];
    while (pages.at(-1)!.hasOlder) {
      const newest = pages.at(-1)!;
      pages.push(pageDisplayHistory(entries, 15, newest.startIndex, { byteBudget: 128 * 1024, beforeBlockIndex: newest.startBlockIndex }));
    }
    expect(reassemble(pages)).toEqual(entries);
  });

  test("keeps the byte budget when rows would need more", () => {
    const entries = Array.from({ length: 50 }, (_, turn) => [user(`u${turn}`), ai(`a${turn} ${"x".repeat(20_000)}`)]).flat();
    const page = open(entries, 64 * 1024);
    expect(JSON.stringify(page.entries).length).toBeLessThanOrEqual(64 * 1024);
    expect(page.hasOlder).toBe(true);
  });

  test("a large pasted image no longer crowds out the turns around it", () => {
    const screenshot: DisplayEntry = { type: "user", text: "look", images: [image(600_000)] };
    const small: DisplayEntry = { type: "user", text: "icon", images: [image(2_000)] };
    const entries = [...shortTurns(40), small, ai("seen"), screenshot, ai("I see it")];
    const page = open(entries);
    expect(rows(page.entries)).toBeGreaterThanOrEqual(target);
    expect(JSON.stringify(page.entries).length).toBeLessThanOrEqual(128 * 1024);
    const users = page.entries.filter((entry) => entry.type === "user");
    // The screenshot keeps its id and size for a preview, without its bytes;
    // the small image still fits the budget and keeps them.
    expect(users.at(-1)).toEqual({ ...screenshot, images: [{ ...image(600_000), base64: "" }] });
    expect(users.at(-2)).toEqual(small);
  });

  test("backfill pages drop image bytes that do not fit instead of shrinking to one entry", () => {
    const entries = [...shortTurns(20), { type: "user", text: "look", images: [image(600_000)] } as DisplayEntry, ...shortTurns(2)];
    const page = pageDisplayHistory(entries, 10, entries.length - 4, { byteBudget: 128 * 1024 });
    expect(page.entries.filter((entry) => entry.type === "user")).toHaveLength(10);
  });

  test("canonical refreshes keep image payloads as before", () => {
    const screenshot: DisplayEntry = { type: "user", text: "look", images: [image(200_000)] };
    const event: HistoryUpdatedEvent = {
      type: "history_updated",
      convId: "conv-1",
      entries: [user("u1"), ai("a1"), screenshot, ai("a2")],
      historyStartIndex: 0,
      historyStartUserIndex: 0,
      historyTotalEntries: 4,
      hasOlderHistory: false,
      contextTokens: null,
      toolOutputsIncluded: false,
    };
    expect(budgetHistoryUpdatedEvent(event, 128 * 1024).entries).toEqual([ai("a2")]);
  });

  test("estimates a folding client's turns by their final replies and notification markers", () => {
    const toolTurn: DisplayEntry = {
      type: "ai",
      blocks: [
        { type: "thinking", text: "plan" },
        ...Array.from({ length: 10 }, (_, round) => [
          { type: "tool_call" as const, toolCallId: `c${round}`, toolName: "Bash", input: {}, summary: `ls ${round}` },
          { type: "tool_result" as const, toolCallId: `c${round}`, toolName: "Bash", output: "", isError: false },
        ]).flat(),
        { type: "text", text: "Done." },
      ],
      metadata: { startedAt: 1, endedAt: 2, model: "m", tokens: 1 },
    };
    // Metadata and its gap plus the one-row reply; the folded calls count nothing.
    expect(estimateFoldedEntryRows(toolTurn, viewport.cols, false)).toBe(3);
    // An older fragment of the same turn shows nothing once a newer one holds the reply.
    expect(estimateFoldedEntryRows(toolTurn, viewport.cols, true)).toBe(0);
    const notification: DisplayEntry = { type: "user", text: "[notification] Subagent completed\n\nlong\nreport", metadata: { startedAt: 1, endedAt: 1, model: "m", tokens: 0, automation: { kind: "subagent_completion" } } };
    // A notification has no row of its own (it leads its turn's work row); a parent conversation's prompt is a bubble.
    expect(estimateFoldedEntryRows(notification, viewport.cols, false)).toBe(0);
    const delegation: DisplayEntry = { ...notification, metadata: { startedAt: 1, endedAt: 1, model: "m", tokens: 0, automation: { kind: "exo_send" } } };
    expect(estimateFoldedEntryRows(delegation, viewport.cols, false)).toBe(estimateEntryRows(delegation, viewport.cols));
    // A top-level conversation folds its own subagents' messages away; another sender's still reads as a prompt.
    const fromChild: DisplayEntry = { ...notification, metadata: { startedAt: 1, endedAt: 1, model: "m", tokens: 0, automation: { kind: "exo_send", sourceId: "child" } } };
    const fromOther: DisplayEntry = { ...notification, metadata: { startedAt: 1, endedAt: 1, model: "m", tokens: 0, automation: { kind: "exo_send", sourceId: "other" } } };
    const isOwnSubagent = (id: string) => id === "child";
    expect(estimateFoldedEntryRows(fromChild, viewport.cols, false, isOwnSubagent)).toBe(0);
    expect(estimateFoldedEntryRows(fromOther, viewport.cols, false, isOwnSubagent)).toBe(estimateEntryRows(fromOther, viewport.cols));
    expect(estimateFoldedEntryRows(fromChild, viewport.cols, false)).toBe(estimateEntryRows(fromChild, viewport.cols));
    const silent: DisplayEntry = { ...toolTurn, blocks: toolTurn.blocks.slice(0, -1) };
    expect(estimateFoldedEntryRows(silent, viewport.cols, false)).toBe(0);
    expect(estimateFoldedEntryRows(user("a real\nmultiline\nprompt"), viewport.cols, false)).toBe(estimateEntryRows(user("a real\nmultiline\nprompt"), viewport.cols));

    // A folding client gets proportionally more of these turns in its opening window.
    const entries = Array.from({ length: 60 }, (_, turn) => [user(`u${turn}`), toolTurn]).flat();
    const unfolded = open(entries);
    const folded = pageDisplayHistory(entries, 100, undefined, { byteBudget: 128 * 1024, viewport: { ...viewport, folded: true } });
    const turns = (page: DisplayHistoryPage) => page.entries.filter((entry) => entry.type === "user").length;
    expect(turns(folded)).toBeGreaterThan(2 * turns(unfolded));
    expect(turns(folded)).toBe(Math.ceil(target / 5));
  });

  test("validates the viewport a client sends", () => {
    expect(isValidHistoryViewport({ rows: 50, cols: 200, folded: true })).toBe(true);
    expect(isValidHistoryViewport({ rows: 50, cols: 200, folded: "yes" })).toBe(false);
    expect(isValidHistoryViewport({ rows: 50, cols: 200 })).toBe(true);
    expect(isValidHistoryViewport({ rows: 0, cols: 200 })).toBe(false);
    expect(isValidHistoryViewport({ rows: 50.5, cols: 200 })).toBe(false);
    expect(isValidHistoryViewport({ rows: 50 })).toBe(false);
    expect(isValidHistoryViewport(null)).toBe(false);
  });
});

/**
 * One message holding `rounds` tool rounds with real-sized inputs (a long
 * subagent turn: ~1000 blocks, ~800 KB), then a short reply.
 */
function hugeAgentTurn(rounds: number): Extract<DisplayEntry, { type: "ai" }> {
  const blocks: Extract<DisplayEntry, { type: "ai" }>["blocks"] = [];
  for (let round = 0; round < rounds; round++) {
    const command = `cd /work && sed -n ${round},+80p src/file-${round}.ts && git status`.padEnd(800, " #");
    blocks.push(
      { type: "thinking", text: `Looking at round ${round}. `.repeat(10) },
      { type: "tool_call", toolCallId: `toolu_${round}`, toolName: "Bash", input: { command }, summary: command },
      { type: "tool_result", toolCallId: `toolu_${round}`, toolName: "", output: "", isError: false },
    );
    if (round % 4 === 3) blocks.push({ type: "text", text: `Progress note ${round}.` });
  }
  blocks.push({ type: "text", text: "All done: the summary." });
  return { type: "ai", blocks, metadata: { startedAt: 1, endedAt: 2, model: "claude-opus-5-5", tokens: 99 } };
}

describe("folded-work elision", () => {
  test("empties the tool calls and thinking before the last tool call, with where they live", () => {
    const entry = agentTurn(3);
    const elided = elideFoldedWork(entry, 7, true);
    if (elided.type !== "ai" || entry.type !== "ai") throw new Error("not ai");
    expect(elided.blocks.map(block => ("elided" in block ? block.elided : null))).toEqual([
      { entry: 7, block: 0 }, { entry: 7, block: 1 }, null,
      { entry: 7, block: 3 }, { entry: 7, block: 4 }, null,
      // The last round's thinking goes too; its call (the live turn's newest step), result and the reply stay.
      { entry: 7, block: 6 }, null, null, null,
    ]);
    expect(elided.blocks[1]).toEqual({ type: "tool_call", toolCallId: "call-0", toolName: "Bash", input: {}, summary: "", elided: { entry: 7, block: 1 } });
    expect(elided.blocks[0]).toEqual({ type: "thinking", text: "", elided: { entry: 7, block: 0 } });
    expect(elided.blocks.slice(7)).toEqual(entry.blocks.slice(7));
    expect(entry.blocks[1]).toMatchObject({ summary: "ls" });

    // No turn shows it as its newest step: the last call goes as well.
    const finished = elideFoldedWork(entry, 7, false);
    if (finished.type !== "ai") throw new Error("not ai");
    expect(finished.blocks[7]).toEqual({ type: "tool_call", toolCallId: "call-2", toolName: "Bash", input: {}, summary: "", elided: { entry: 7, block: 7 } });
    expect(finished.blocks.slice(8)).toEqual(entry.blocks.slice(8));
  });

  test("leaves entries with nothing to elide as they are", () => {
    const prompt = user("u");
    const reply = ai("reply");
    const oneCall: DisplayEntry = { type: "ai", metadata: null, blocks: [
      { type: "text", text: "Checking." },
      { type: "tool_call", toolCallId: "call-0", toolName: "Bash", input: { command: "ls" }, summary: "ls" },
      { type: "tool_result", toolCallId: "call-0", toolName: "Bash", output: "", isError: false },
      { type: "text", text: "Done." },
    ] };
    for (const entry of [prompt, reply, oneCall]) expect(elideFoldedWork(entry, 3, true)).toBe(entry);
    for (const entry of [prompt, reply]) expect(elideFoldedWork(entry, 3, false)).toBe(entry);
  });

  test("keeps last tool calls only where a running turn may show one", () => {
    const entries: DisplayEntry[] = [user("u0"), agentTurn(3), user("u1"), agentTurn(3), user("u2"), agentTurn(3)];
    const lastCall = (entry: DisplayEntry | undefined) => entry?.type === "ai" ? entry.blocks[7] : null;
    const kept = (page: DisplayHistoryPage) => page.entries.filter(entry => entry.type === "ai").map(entry => {
      const call = lastCall(entry);
      return call?.type === "tool_call" && !call.elided;
    });
    // Idle: only the window's newest entry keeps it (a turn resumed after a restart continues it).
    const idle = pageDisplayHistory(entries, 100, undefined, { byteBudget: 128 * 1024, elideFoldedWork: true });
    expect(kept(idle)).toEqual([false, false, true]);
    const older = pageDisplayHistory(entries, 100, 4, { byteBudget: 128 * 1024, elideFoldedWork: true });
    expect(kept(older)).toEqual([false, true]);
    // A turn running: every entry keeps it, as before.
    const running = pageDisplayHistory(entries, 100, undefined, { byteBudget: 128 * 1024, elideFoldedWork: true, turnRunning: true });
    expect(kept(running)).toEqual([true, true, true]);
    expect(lastCall(running.entries[1])).toEqual(lastCall(entries[1]));
  });

  test("a conversation that delegates opens folded in one window: its subagents' messages and finished calls cost nothing", () => {
    // A top-level conversation whose turns are split by its subagents' messages
    // (1793172749114-og7m06): each fragment ends on a big apply_patch and shows
    // nothing folded; only the owner's prompt and the final reply have rows.
    const patch = "*** Begin Patch\n".padEnd(20_000, "+ line\n");
    const fragment = (n: number): DisplayEntry => ({ type: "ai", metadata: null, blocks: [
      { type: "tool_call", toolCallId: `read-${n}`, toolName: "exec_command", input: { cmd: "cat x" }, summary: "cat x" },
      { type: "tool_result", toolCallId: `read-${n}`, toolName: "", output: "", isError: false },
      { type: "tool_call", toolCallId: `patch-${n}`, toolName: "apply_patch", input: { input: patch }, summary: "x.swift" },
      { type: "tool_result", toolCallId: `patch-${n}`, toolName: "", output: "", isError: false },
    ] });
    const report = (n: number): DisplayEntry => ({ type: "user", text: `Report ${n}: `.padEnd(800, "found things. "), metadata: { startedAt: n, endedAt: n, model: "m", tokens: 0, automation: { kind: "exo_send", sourceId: `child-${n % 3}` } } });
    const entries: DisplayEntry[] = [user("Build the feature.\n".repeat(20))];
    for (let n = 0; n < 40; n++) entries.push(fragment(n), report(n));
    entries.push({ type: "ai", metadata: { startedAt: 1, endedAt: 2, model: "m", tokens: 1 }, blocks: [{ type: "text", text: "Committed it." }] });
    const viewport: HistoryViewport = { rows: 60, cols: 79, folded: true };
    const isOwnSubagent = (id: string) => id.startsWith("child-");

    const before = pageDisplayHistory(entries, 100, undefined, { byteBudget: 128 * 1024, viewport, elideFoldedWork: true, turnRunning: true });
    expect(before.hasOlder).toBe(true);
    const after = pageDisplayHistory(entries, 100, undefined, { byteBudget: 128 * 1024, viewport, elideFoldedWork: true, isOwnSubagent });
    expect(after).toMatchObject({ startIndex: 0, hasOlder: false });
    expect(JSON.stringify(after.entries).length).toBeLessThan(128 * 1024);
  });

  test("a huge single message opens folded in one page instead of many", () => {
    const entries: DisplayEntry[] = [user("Do the big job."), hugeAgentTurn(320)];
    const byteBudget = 128 * 1024;
    const viewport: HistoryViewport = { rows: 40, cols: 160, folded: true };
    expect(JSON.stringify(entries[1]).length).toBeGreaterThan(600 * 1024);

    // Without elision a folded client pages through every round it never shows.
    const full = walkPages(entries, 100, byteBudget);
    expect(full.length).toBeGreaterThan(4);

    const open = pageDisplayHistory(entries, 100, undefined, { byteBudget, viewport, elideFoldedWork: true });
    expect(open).toMatchObject({ startIndex: 0, startBlockIndex: 0, hasOlder: false });
    expect(JSON.stringify(open.entries).length).toBeLessThan(byteBudget);
    const turn = open.entries[1];
    if (turn?.type !== "ai" || entries[1]!.type !== "ai") throw new Error("not ai");
    const source = entries[1]!.blocks;
    expect(turn.blocks).toHaveLength(source.length);
    turn.blocks.forEach((block, index) => {
      expect(block.type).toBe(source[index]!.type);
      if ("elided" in block && block.elided) expect(block.elided).toEqual({ entry: 1, block: index });
      else expect(block).toEqual(source[index]!);
    });
    // What folded history shows survives: the reply and interim text, and the newest call.
    expect(turn.blocks.at(-1)).toEqual({ type: "text", text: "All done: the summary." });
    expect(turn.blocks.filter(block => block.type === "text")).toHaveLength(source.filter(block => block.type === "text").length);
    const lastCall = source.findLastIndex(block => block.type === "tool_call");
    expect(turn.blocks[lastCall]).toEqual(source[lastCall]!);
  });

  test("elided pages still cut a message too big for the budget at round starts, with absolute references", () => {
    const entries: DisplayEntry[] = [user("Do the big job."), hugeAgentTurn(4000)];
    const pages: DisplayHistoryPage[] = [pageDisplayHistory(entries, 15, undefined, { byteBudget: 128 * 1024, elideFoldedWork: true })];
    while (pages.at(-1)!.hasOlder) {
      const newest = pages.at(-1)!;
      pages.push(pageDisplayHistory(entries, 15, newest.startIndex, { byteBudget: 128 * 1024, beforeBlockIndex: newest.startBlockIndex, elideFoldedWork: true }));
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.length).toBeLessThan(walkPages(entries, 15, 128 * 1024).length / 4);
    const joined = reassemble(pages)[1];
    if (joined?.type !== "ai") throw new Error("not ai");
    joined.blocks.forEach((block, index) => {
      if ("elided" in block && block.elided) expect(block.elided).toEqual({ entry: 1, block: index });
    });
    expect(joined.blocks).toHaveLength(entries[1]!.type === "ai" ? entries[1]!.blocks.length : 0);
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
