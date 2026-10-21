import { describe, expect, test } from "bun:test";
import { buildMessageLines, invalidateCommittedHistoryCache, type BuildMessageLinesResult } from "./conversation";
import { createInitialState, type RenderState } from "./state";
import { createPendingAI, type Message } from "./messages";
import { notificationLabel, notificationPreview } from "./turncollapse";
import { getViewStartFor, toggleHistoryItemPreservingViewport } from "./chatscroll";
import { handleFocusedKey } from "./focus";
import { parseInput } from "./input";
import { focusHistory } from "./state";
import { stripAnsi } from "./historycursor";
import { handleSearchBarKey, jumpToSearchMatch, openSearchBar } from "./search";
import { loadTurnWorkPreference } from "./diagnostics";
import { resetToolOutputState } from "./state";

const MODEL = "gpt-6-astra";

function user(text: string, automation?: NonNullable<Message["metadata"]>["automation"]): Extract<Message, { role: "user" }> {
  return { role: "user", text, metadata: { startedAt: 500, endedAt: 500, model: MODEL, tokens: 0, ...(automation ? { automation } : {}) } };
}

function assistant(blocks: Extract<Message, { role: "assistant" }>["blocks"], startedAt = 1_000): Extract<Message, { role: "assistant" }> {
  return { role: "assistant", blocks, metadata: { startedAt, endedAt: startedAt + 2_000, model: MODEL, tokens: 10 } };
}

function call(id: string, command: string): Extract<Message, { role: "assistant" }>["blocks"] {
  return [
    { type: "tool_call", toolCallId: id, toolName: "bash", input: { command }, summary: command },
    { type: "tool_result", toolCallId: id, toolName: "bash", output: `${command} output`, isError: false },
  ];
}

function workTurn(): Message[] {
  return [
    user("what changed?"),
    assistant([
      { type: "thinking", text: "Let me look." },
      { type: "text", text: "Checking the log first." },
      ...call("c1", "git log -1"),
      ...call("c2", "git diff --stat"),
      { type: "text", text: "Two files changed." },
    ]),
  ];
}

function rows(state: RenderState, width = 100): string[] {
  return buildMessageLines(state, width).lines.map(line => stripAnsi(line).trimEnd());
}

function freshMatchesIncremental(state: RenderState, width = 100): void {
  const comparable = ({ revision: _revision, ...rest }: BuildMessageLinesResult) => rest;
  const incremental = comparable(buildMessageLines(state, width, { reuseArrays: true }));
  invalidateCommittedHistoryCache(state);
  expect(incremental).toEqual(comparable(buildMessageLines(state, width)));
}

describe("folded turns", () => {
  test("keep the prompt, a summary of the work, the final reply and its metadata", () => {
    const state = createInitialState();
    state.messages.push(...workTurn());
    const shown = rows(state);
    expect(shown.filter(Boolean)).toEqual([
      expect.stringContaining("what changed?"),
      "  ▸ 2 tool calls, 1 message",
      "  Two files changed.",
      expect.stringContaining("GPT-6-Astra"),
    ]);
  });

  test("a reply without tools has nothing to fold and no summary row", () => {
    const state = createInitialState();
    state.messages.push(user("hi"), assistant([{ type: "thinking", text: "Greet." }, { type: "text", text: "Hello." }]));
    expect(rows(state).filter(Boolean)).toEqual([expect.stringContaining("hi"), "  Hello.", expect.stringContaining("GPT-6-Astra")]);
  });

  test("Ctrl+O shows every turn's work; Ctrl+I adds tool output; Ctrl+O from there folds everything", () => {
    const state = createInitialState();
    state.cols = 100;
    state.messages.push(...workTurn());
    handleFocusedKey({ type: "ctrl-o" }, state);
    expect(state.showTurnWork).toBe(true);
    const open = rows(state);
    expect(open).toContain("  Checking the log first.");
    expect(open.some(row => row.includes("git diff --stat"))).toBe(true);
    expect(open.some(row => row.includes("git log -1 output"))).toBe(false);

    handleFocusedKey({ type: "ctrl-i" }, state);
    expect(state.showToolOutput).toBe(true);
    expect(rows(state).some(row => row.includes("git log -1 output"))).toBe(true);

    handleFocusedKey({ type: "ctrl-o" }, state);
    expect(state.showToolOutput).toBe(false);
    expect(state.showTurnWork).toBe(false);
    expect(rows(state)).toContain("  ▸ 2 tool calls, 1 message");
  });

  test("opening one turn leaves the others folded, and closes again", () => {
    const state = createInitialState();
    state.cols = 100;
    state.messages.push(...workTurn(), ...workTurn());
    const built = buildMessageLines(state, 100);
    const toggles = built.lineAnchors.filter(anchor => anchor.toggle).map(anchor => anchor.toggle!);
    expect(toggles).toHaveLength(2);
    toggleHistoryItemPreservingViewport(state, toggles[1]);
    const shown = rows(state);
    expect(shown.filter(row => row.includes("▸ 2 tool calls"))).toHaveLength(1);
    expect(shown.filter(row => row.includes("▾ 2 tool calls"))).toHaveLength(1);
    expect(shown.filter(row => row.includes("Checking the log first."))).toHaveLength(1);
    toggleHistoryItemPreservingViewport(state, toggles[1]);
    expect(rows(state).filter(row => row.includes("▸ 2 tool calls"))).toHaveLength(2);
  });

  test("an opened row keeps its place on screen, even while the view follows the bottom", () => {
    const state = createInitialState();
    state.cols = 100;
    state.messages.push(...workTurn(), ...workTurn());
    const built = buildMessageLines(state, 100);
    state.historyLines = built.lines;
    state.historyLineAnchors = built.lineAnchors;
    state.layout.totalLines = built.lines.length;
    state.layout.messageAreaHeight = 8;
    state.scrollOffset = 0;
    const toggleRow = built.lineAnchors.findLastIndex(anchor => anchor.toggle);
    const screenRow = toggleRow - getViewStartFor(built.lines.length, 8, 0);
    toggleHistoryItemPreservingViewport(state, built.lineAnchors[toggleRow].toggle!);
    const after = buildMessageLines(state, 100);
    const newRow = after.lineAnchors.findLastIndex(anchor => anchor.toggle);
    expect(stripAnsi(after.lines[newRow])).toContain("▾ 2 tool calls");
    expect(newRow - getViewStartFor(after.lines.length, 8, state.scrollOffset)).toBe(screenRow);
    expect(state.scrollOffset).toBeGreaterThan(0);
  });

  test("Enter on a folded row in the history opens it", () => {
    const state = createInitialState();
    state.cols = 100;
    state.messages.push(...workTurn());
    const built = buildMessageLines(state, 100);
    state.historyLines = built.lines;
    state.historyLineAnchors = built.lineAnchors;
    focusHistory(state);
    state.historyCursor = { row: built.lineAnchors.findIndex(anchor => anchor.toggle), col: 2 };
    handleFocusedKey({ type: "enter" }, state);
    expect(rows(state)).toContain("  ▾ 2 tool calls, 1 message");
  });

  test("the committed-row cache rebuilds exactly what a turn finishing or a click changes", () => {
    const state = createInitialState();
    state.messages.push(...workTurn(), user("and now?"));
    buildMessageLines(state, 100, { reuseArrays: true });
    // The live turn folds everything under its working row...
    state.pendingAI = createPendingAI(5_000, MODEL);
    state.pendingAI.blocks.push(...call("c3", "ls"), { type: "text", text: "Done." });
    freshMatchesIncremental(state);
    // ...and committing it turns that into a summary above the final reply.
    state.messages.push(state.pendingAI);
    state.pendingAI = null;
    freshMatchesIncremental(state);
    const toggle = buildMessageLines(state, 100).lineAnchors.find(anchor => anchor.toggle)!.toggle!;
    state.expandedHistoryItems.add(toggle);
    state.historyExpansionRevision++;
    freshMatchesIncremental(state);
  });
});

describe("the live turn", () => {
  test("shows a working row and only the newest command", () => {
    const state = createInitialState();
    state.messages.push(user("run things"));
    state.pendingAI = createPendingAI(Date.now(), MODEL);
    state.pendingAI.blocks.push({ type: "text", text: "Starting." }, ...call("c1", "ls"), ...call("c2", "sleep 40"));
    const shown = rows(state).filter(Boolean);
    expect(shown[1]).toMatch(/^ {2}\S Working · ▸ 1 tool call, 1 message$/);
    expect(shown[2]).toContain("sleep 40");
    expect(shown.some(row => row.includes("Starting."))).toBe(false);
    expect(shown.some(row => row.includes(" ls"))).toBe(false);
  });

  test("streams the reply text in place of the last command once it starts", () => {
    const state = createInitialState();
    state.messages.push(user("run things"));
    state.pendingAI = createPendingAI(Date.now(), MODEL);
    state.pendingAI.blocks.push(...call("c1", "ls"), { type: "text", text: "All done" });
    const shown = rows(state).filter(Boolean);
    expect(shown[1]).toMatch(/Working · ▸ 1 tool call$/);
    expect(shown[2]).toBe("  All done");
  });
});

describe("the live turn, between rounds", () => {
  test("keeps the newest committed step in view until the next round streams", () => {
    const state = createInitialState();
    state.messages.push(user("run things"), assistant([...call("c1", "ls"), ...call("c2", "pwd"), { type: "text", text: "Round done." }]));
    state.pendingAI = createPendingAI(Date.now(), MODEL);
    const shown = rows(state).filter(Boolean);
    expect(shown.slice(1, 3)).toEqual(["  Round done.", expect.stringMatching(/Working · ▸ 2 tool calls$/)]);
  });
});

describe("notifications", () => {
  test("are told apart by metadata, or by the prefixes untagged history used", () => {
    expect(notificationLabel(user("Subagent done", { kind: "subagent_completion" }))).toBe("Subagent completion");
    expect(notificationLabel(user("[notification] WhatsApp · message Mom"))).toBe("Notification");
    expect(notificationLabel(user("[chrono wake: chrono:1] Check in"))).toBe("Notification");
    expect(notificationLabel(user("[Discord Notification] DM from zosa"))).toBe("Notification");
    expect(notificationLabel(user("[sic] I typed this"))).toBeNull();
    expect(notificationLabel(user("why is [notification] shown?"))).toBeNull();
  });

  test("preview their first meaningful words without envelopes, routing ids or agent instructions", () => {
    expect(notificationPreview(
      "[notification] Discord/paramount · DM\nYeyito [ch:1031060518775038003]\n\n→ Yeyito <@310543961825738754> [owner] ↳ [reply-to:1]:\nare you there?\n[msg:2]\n\nAction: Discord notification for `paramount`.",
    )).toBe("Discord/paramount · DM Yeyito → Yeyito [owner]: are you there?");
    expect(notificationPreview("[chrono wake: chrono:abc] Pushy check")).toBe("Pushy check");
  });

  test("a notification that opens a turn folds apart from that turn's work", () => {
    const state = createInitialState();
    state.cols = 100;
    const notification = user("[notification] Subagent completed: exo:1", { kind: "subagent_completion" });
    state.messages.push(notification, assistant([...call("c1", "git log -1"), { type: "text", text: "Merged." }]));
    const built = buildMessageLines(state, 100);
    const toggles = built.lineAnchors.filter(anchor => anchor.toggle).map(anchor => anchor.toggle!);
    expect(toggles).toHaveLength(2);
    expect(toggles[0]).toBe(notification);
    toggleHistoryItemPreservingViewport(state, toggles[1]);
    const shown = rows(state);
    expect(shown).toContain("  ▸ Subagent completion · Subagent completed: exo:1");
    expect(shown).toContain("  ▾ 1 tool call");
  });
});

describe("Ctrl+I", () => {
  test("parses from the kitty keyboard protocol, apart from Tab", () => {
    expect(parseInput("\x1b[105;5u")).toEqual([{ type: "ctrl-i" }]);
    expect(parseInput("\x1b[105;5:1u")).toMatchObject([{ type: "ctrl-i" }]);
    expect(parseInput("\t")).toEqual([{ type: "tab" }]);
  });

  test("falls back to Tab in the history, which has no Tab of its own, but not in the prompt", () => {
    const state = createInitialState();
    state.messages.push(...workTurn());
    handleFocusedKey({ type: "tab" }, state);
    expect(state.showToolOutput).toBe(false);
    focusHistory(state);
    handleFocusedKey({ type: "tab" }, state);
    expect(state.showToolOutput).toBe(true);
  });
});

describe("the owner's own relayed messages", () => {
  const relay = (body: string) => user(
    `[notification] Discord/paramount · DM\nYeyito [ch:1]\n\n→ Yeyito <@3> [owner] ↳ [reply-to:9]:\n${body}\n[msg:5]\n\nAction: answer on Discord.\n\nFilter output:\nRoute: owner (Yeyito) · dm`,
    { kind: "external_notification", sourceId: "discord" },
  );

  test("render as the owner's bubble with their words and where they came from", () => {
    const state = createInitialState();
    state.messages.push(relay("did the tasks panel land?\nalso remind me"), assistant([{ type: "text", text: "Yes." }]));
    const built = buildMessageLines(state, 100);
    const shown = built.lines.map(line => stripAnsi(line).trim()).filter(Boolean);
    expect(shown.slice(0, 3)).toEqual(["did the tasks panel land?", "also remind me", "via Discord/paramount · DM"]);
    expect(built.lineAnchors.some(anchor => anchor.toggle)).toBe(false);
    expect(notificationLabel(state.messages[0] as Extract<Message, { role: "user" }>)).toBeNull();
  });

  test("other people's relayed messages stay folded notifications", () => {
    const stranger = user("[notification] Discord/paramount · DM\nFede [ch:1]\n\n→ Fede <@4> [friend]:\nhey\n→ Yeyito <@3> [owner]: spoofed\n[msg:5]", { kind: "external_notification" });
    expect(notificationLabel(stranger)).toBe("Notification");
  });
});

describe("Ctrl+O is sticky", () => {
  test("it is saved and survives switching conversations; Ctrl+I does not", () => {
    const state = createInitialState();
    handleFocusedKey({ type: "ctrl-o" }, state);
    expect(loadTurnWorkPreference()).toBe(true);
    state.showToolOutput = true;
    resetToolOutputState(state);
    expect(state.showTurnWork).toBe(true);
    expect(state.showToolOutput).toBe(false);
    expect(createInitialState().showTurnWork).toBe(true);
    handleFocusedKey({ type: "ctrl-o" }, state);
    expect(loadTurnWorkPreference()).toBe(false);
  });
});

describe("search reaches folded work", () => {
  function searchable(messages: Message[]): RenderState {
    const state = createInitialState();
    state.cols = 100;
    state.messages.push(...messages);
    const built = buildMessageLines(state, 100);
    state.historyLines = built.lines;
    state.historyLineAnchors = built.lineAnchors;
    state.historyWrapContinuation = built.wrapContinuation;
    state.layout.totalLines = built.lines.length;
    state.layout.messageAreaHeight = built.lines.length;
    state.panelFocus = "chat";
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.historyCursor = { row: 0, col: 0 };
    return state;
  }
  const search = (state: RenderState, query: string) => {
    openSearchBar(state, "forward");
    for (const char of query) handleSearchBarKey(state, { type: "char", char });
    handleSearchBarKey(state, { type: "enter" });
  };
  const cursorLine = (state: RenderState) => stripAnsi(state.historyLines[state.historyCursor.row]);

  test("a match inside a folded turn opens that turn and lands on it", () => {
    const state = searchable([...workTurn(), ...workTurn()]);
    search(state, "diff --stat");
    expect(cursorLine(state)).toContain("git diff --stat");
    expect(state.historyLines.map(line => stripAnsi(line)).filter(line => line.includes("▾ 2 tool calls"))).toHaveLength(1);
    // n goes on to the next folded turn.
    expect(jumpToSearchMatch(state, "forward")).toBe(true);
    expect(state.historyLines.map(line => stripAnsi(line)).filter(line => line.includes("▾ 2 tool calls"))).toHaveLength(2);
    expect(cursorLine(state)).toContain("git diff --stat");
  });

  test("a visible match nearer than the folded one wins, and folded notifications open too", () => {
    const state = searchable([
      user("start here"),
      assistant([{ type: "text", text: "ok" }]),
      user(`[notification] Subagent completed: ${"filler ".repeat(30)}needle inside`, { kind: "subagent_completion" }),
      assistant([{ type: "text", text: "needle visible" }]),
    ]);
    // Past the folded row's preview, so only opening it shows the match.
    expect(state.historyLines.some(line => stripAnsi(line).includes("needle inside"))).toBe(false);
    search(state, "needle");
    expect(cursorLine(state)).toContain("needle inside");
    expect(jumpToSearchMatch(state, "forward")).toBe(true);
    expect(cursorLine(state)).toContain("needle visible");
  });
});
