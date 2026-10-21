import { describe, expect, spyOn, test } from "bun:test";
import { buildMessageLines, invalidateCommittedHistoryCache, type BuildMessageLinesResult } from "./conversation";
import { createInitialState, focusHistory, type RenderState } from "./state";
import type { Message } from "./messages";
import { toggleHistoryItemPreservingViewport } from "./chatscroll";
import { handleFocusedKey } from "./focus";
import { stripAnsi } from "./historycursor";
import { handleSearchBarKey, openSearchBar } from "./search";

// The default folded look: no work or notification rows, a faint mark in the gutter.

const MODEL = "gpt-6-astra";

function user(text: string, automation?: NonNullable<Message["metadata"]>["automation"]): Extract<Message, { role: "user" }> {
  return { role: "user", text, metadata: { startedAt: 500, endedAt: 500, model: MODEL, tokens: 0, ...(automation ? { automation } : {}) } };
}

function assistant(blocks: Extract<Message, { role: "assistant" }>["blocks"]): Extract<Message, { role: "assistant" }> {
  return { role: "assistant", blocks, metadata: { startedAt: 1_000, endedAt: 3_000, model: MODEL, tokens: 10 } };
}

function call(id: string, command: string): Extract<Message, { role: "assistant" }>["blocks"] {
  return [
    { type: "tool_call", toolCallId: id, toolName: "bash", input: { command }, summary: command },
    { type: "tool_result", toolCallId: id, toolName: "bash", output: "ok", isError: false },
  ];
}

const wake = (n: number) => user(`[chrono hard wake: chrono:${n}] Scheduled command failed`, { kind: "chrono_hard_wake" });
const note = (n: number) => user(`[notification] Subagent completed: exo:${n}`, { kind: "subagent_completion" });
const silent = (id: string) => assistant([{ type: "text", text: `checking ${id}` }, ...call(`${id}a`, `look ${id}`)]);

function rows(state: RenderState, width = 100): string[] {
  return buildMessageLines(state, width).lines.map(line => stripAnsi(line).trimEnd());
}

function freshMatchesIncremental(state: RenderState, width = 100): void {
  const comparable = ({ revision: _revision, ...rest }: BuildMessageLinesResult) => rest;
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    const incremental = comparable(buildMessageLines(state, width, { reuseArrays: true }));
    invalidateCommittedHistoryCache(state);
    expect(incremental).toEqual(comparable(buildMessageLines(state, width)));
  } finally {
    clock.mockRestore();
  }
}

describe("gutter folding (default)", () => {
  test("a turn's work leaves no row: a faint mark in the gutter of its reply", () => {
    const state = createInitialState();
    state.messages.push(user("what changed?"), assistant([{ type: "text", text: "Checking." }, ...call("c1", "git log"), { type: "text", text: "Two files changed." }]));
    const shown = rows(state).filter(Boolean);
    expect(shown).toEqual([expect.stringContaining("what changed?"), "▸ Two files changed.", expect.stringContaining("GPT-6-Astra")]);
    freshMatchesIncremental(state);
  });

  test("notifications and silent background turns vanish; the next reply's mark opens them", () => {
    const state = createInitialState();
    state.messages.push(
      user("start"), assistant([{ type: "text", text: "ok" }]),
      note(1), silent("s1"),
      wake(2), silent("s2"),
      wake(3), assistant([...call("r", "restart"), { type: "text", text: "Restarted live." }]),
    );
    const shown = rows(state);
    expect(shown.filter(Boolean).slice(3)).toEqual(["▸ Restarted live.", expect.stringContaining("GPT-6-Astra")]);
    expect(shown.some(row => /Subagent|Chrono|tool call|checking/.test(row))).toBe(false);
    // One blank row separates the replies, as in a plain chat.
    const restarted = shown.indexOf("▸ Restarted live.");
    expect(shown[restarted - 1]).toBe("");
    expect(shown[restarted - 2]).toContain("GPT-6-Astra");

    const built = buildMessageLines(state, 100);
    const anchor = built.lineAnchors[restarted];
    expect(anchor.toggleCols).toBe(1);
    toggleHistoryItemPreservingViewport(state, anchor.toggle!);
    const open = rows(state);
    expect(open.some(row => row.startsWith("▾ "))).toBe(true);
    expect(open.filter(row => row.trim() === "Subagent completion")).toHaveLength(1);
    expect(open.filter(row => row.trim() === "Chrono hard wake")).toHaveLength(2);
    expect(open.some(row => row.includes("checking s1"))).toBe(true);
    freshMatchesIncremental(state);
  });

  test("with nothing after them, they leave one faint row; before a prompt, its blank margin carries the mark", () => {
    const state = createInitialState();
    state.messages.push(user("start"), assistant([{ type: "text", text: "ok" }]), wake(1), silent("s1"));
    expect(rows(state).filter(Boolean).slice(-1)).toEqual(["▸"]);
    state.messages.push(user("next prompt"));
    const shown = rows(state);
    const prompt = shown.findIndex(row => row.includes("next prompt"));
    expect(shown[prompt - 1]).toBe("▸");
    expect(shown.filter(row => row === "▸")).toHaveLength(1);
  });

  test("Enter on the mark's column opens it; elsewhere on the row it does not", () => {
    const state = createInitialState();
    state.messages.push(user("q"), assistant([...call("c", "ls"), { type: "text", text: "Done." }]));
    const built = buildMessageLines(state, 100);
    state.historyLines = built.lines;
    state.historyLineAnchors = built.lineAnchors;
    focusHistory(state);
    const row = built.lines.findIndex(line => stripAnsi(line).includes("Done."));
    state.historyCursor = { row, col: 4 };
    handleFocusedKey({ type: "enter" }, state);
    expect(rows(state)).toContain("▸ Done.");
    state.historyCursor = { row, col: 0 };
    handleFocusedKey({ type: "enter" }, state);
    // Open, the mark sits on the first row of what opened.
    expect(rows(state)).toContain("▾ bash ls");
  });

  test("search opens the stretch holding the match", () => {
    const state = createInitialState();
    state.cols = 100;
    state.messages.push(user("start"), assistant([{ type: "text", text: "ok" }]), wake(1), silent("s1"), wake(2), assistant([...call("r", "restart"), { type: "text", text: "Restarted." }]));
    const built = buildMessageLines(state, 100);
    Object.assign(state, { historyLines: built.lines, historyLineAnchors: built.lineAnchors, historyWrapContinuation: built.wrapContinuation });
    state.layout.totalLines = built.lines.length;
    state.layout.messageAreaHeight = built.lines.length;
    state.panelFocus = "chat";
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.historyCursor = { row: 0, col: 0 };
    openSearchBar(state, "forward");
    for (const char of "look s1") handleSearchBarKey(state, { type: "char", char });
    handleSearchBarKey(state, { type: "enter" });
    expect(stripAnsi(state.historyLines[state.historyCursor.row])).toContain("look s1");
  });

  test("with marks off nothing shows, clicks and Enter pass through, and search still opens it", () => {
    const state = createInitialState();
    state.foldMarks = false;
    state.messages.push(user("start"), assistant([{ type: "text", text: "ok" }]), wake(1), silent("s1"), wake(2), assistant([...call("r", "restart"), { type: "text", text: "Restarted." }]), wake(3), silent("s3"));
    const shown = rows(state).filter(Boolean);
    expect(shown.slice(3)).toEqual(["  Restarted.", expect.stringContaining("GPT-6-Astra")]);
    const built = buildMessageLines(state, 100);
    const anchor = built.lineAnchors[built.lines.findIndex(line => stripAnsi(line).includes("Restarted."))];
    expect(anchor.toggle).toBeDefined();
    expect(anchor.toggleCols).toBe(0);
  });

  test("Ctrl+O shows every notification left-aligned, and the queue only the owner's own messages until then", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push(user("start"), assistant([{ type: "text", text: "ok" }]), note(1), silent("s1"));
    state.queuedMessages.push(
      { convId: "conv-1", text: "[notification] Gmail · new mail", timing: "next-turn", automation: { kind: "external_notification" } },
      { convId: "conv-1", text: "my own follow-up", timing: "next-turn" },
    );
    const folded = rows(state);
    expect(folded.some(row => row.includes("my own follow-up"))).toBe(true);
    expect(folded.some(row => row.includes("Gmail"))).toBe(false);
    state.showTurnWork = true;
    const all = rows(state);
    expect(all.some(row => row.includes("Gmail"))).toBe(true);
    expect(all).toContain("  Subagent completion");
    expect(all).toContain("  ▎ [notification] Subagent completed: exo:1");
  });

  test("the hidden rows style is still there", () => {
    const state = createInitialState();
    state.foldStyle = "rows";
    state.messages.push(user("q"), assistant([...call("c", "ls"), { type: "text", text: "Done." }]));
    expect(rows(state)).toContain("  ▸ 1 tool call");
  });
});

test("a notification delivered mid-turn adds no blank row between the prompt and its reply", () => {
  const state = createInitialState();
  state.messages.push(user("run it"), assistant([...call("c", "sleep 75")]), note(1), assistant([{ type: "text", text: "done" }]));
  const shown = rows(state);
  const prompt = shown.findIndex(row => row.includes("run it"));
  expect(shown.slice(prompt + 1, prompt + 3)).toEqual(["", "▸ done"]);
});
