import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { buildMessageLines, invalidateCommittedHistoryCache, type BuildMessageLinesResult } from "./conversation";
import { createInitialState, focusHistory, resetToolOutputState, type RenderState } from "./state";
import { createPendingAI, type Message } from "./messages";
import { handleStreamingStarted, handleToolCall, handleToolResult } from "./events/streaming";
import { handleEvent, type DaemonActions } from "./events";
import type { Event } from "./protocol";
import { notificationLabel, notificationPreview, ownerWords } from "./turncollapse";
import { theme } from "./theme";
import { handleFocusedKey } from "./focus";
import { parseInput } from "./input";
import { stripAnsi } from "./historycursor";
import { handleSearchBarKey, jumpToSearchMatch, openSearchBar } from "./search";
import { loadTurnWorkPreference, saveTurnWorkPreference } from "./diagnostics";

// Folded history reads like a plain chat; Ctrl+O and Ctrl+I are the only ways to see the rest.

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

const wake = (n: number) => user(`[chrono hard wake: chrono:${n}] Scheduled command failed`, { kind: "chrono_hard_wake" });
const note = (n: number) => user(`[notification] Subagent completed: exo:${n}`, { kind: "subagent_completion" });
const silent = (id: string) => assistant([{ type: "text", text: `checking ${id}` }, ...call(`${id}a`, `look ${id}`)]);
const notice = (text: string): Message => ({ role: "system", text, color: "error", metadata: null } as Message);

function rows(state: RenderState, width = 100): string[] {
  return buildMessageLines(state, width).lines.map(line => stripAnsi(line).trimEnd());
}

function freshMatchesIncremental(state: RenderState, width = 100): void {
  const comparable = ({ revision: _revision, ...rest }: BuildMessageLinesResult) => rest;
  // The working row's spinner reads the clock: both builds must see the same second.
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    const incremental = comparable(buildMessageLines(state, width, { reuseArrays: true }));
    invalidateCommittedHistoryCache(state);
    expect(incremental).toEqual(comparable(buildMessageLines(state, width)));
  } finally {
    clock.mockRestore();
  }
}

/** Ctrl+O is saved: tests that turn it on put it back. */
afterEach(() => saveTurnWorkPreference(false));

describe("folded history", () => {
  test("a turn's work leaves no row: the prompt, the final reply and its metadata", () => {
    const state = createInitialState();
    state.messages.push(...workTurn());
    expect(rows(state).filter(Boolean)).toEqual([
      expect.stringContaining("what changed?"),
      "  Two files changed.",
      expect.stringContaining("GPT-6-Astra"),
    ]);
    freshMatchesIncremental(state);
  });

  test("nothing in it is expandable: no marks, and Enter or a click on a reply opens nothing", () => {
    const state = createInitialState();
    state.cols = 100;
    state.messages.push(...workTurn(), note(1), silent("s1"), wake(2), assistant([...call("r", "restart"), { type: "text", text: "Restarted." }]), wake(3), silent("s3"));
    const before = rows(state);
    expect(before.some(row => /[▸▾]/.test(row))).toBe(false);
    const built = buildMessageLines(state, 100);
    state.historyLines = built.lines;
    state.historyLineAnchors = built.lineAnchors;
    focusHistory(state);
    for (const reply of ["Two files changed.", "Restarted."]) {
      state.historyCursor = { row: built.lines.findIndex(line => stripAnsi(line).includes(reply)), col: 0 };
      handleFocusedKey({ type: "enter" }, state);
      expect(rows(state)).toEqual(before);
    }
  });

  test("a reply without tools folds nothing", () => {
    const state = createInitialState();
    state.messages.push(user("hi"), assistant([{ type: "thinking", text: "Greet." }, { type: "text", text: "Hello." }]));
    expect(rows(state).filter(Boolean)).toEqual([expect.stringContaining("hi"), "  Hello.", expect.stringContaining("GPT-6-Astra")]);
  });

  test("notifications and silent background turns vanish; one blank row separates the replies", () => {
    const state = createInitialState();
    state.messages.push(
      user("start"), assistant([{ type: "text", text: "ok" }]),
      note(1), silent("s1"),
      wake(2), silent("s2"),
      wake(3), assistant([...call("r", "restart"), { type: "text", text: "Restarted live." }]),
    );
    const shown = rows(state);
    expect(shown.filter(Boolean).slice(3)).toEqual(["  Restarted live.", expect.stringContaining("GPT-6-Astra")]);
    expect(shown.some(row => /Subagent|Chrono|checking|look s/.test(row))).toBe(false);
    const restarted = shown.indexOf("  Restarted live.");
    expect(shown[restarted - 1]).toBe("");
    expect(shown[restarted - 2]).toContain("GPT-6-Astra");
    freshMatchesIncremental(state);
  });

  test("with nothing answering them they leave no trace, also before the next prompt", () => {
    const state = createInitialState();
    state.messages.push(user("start"), assistant([{ type: "text", text: "ok" }]), wake(1), silent("s1"));
    expect(rows(state).filter(Boolean)).toEqual([expect.stringContaining("start"), "  ok", expect.stringContaining("GPT-6-Astra")]);
    state.messages.push(user("next prompt"));
    const shown = rows(state);
    const prompt = shown.findIndex(row => row.includes("next prompt"));
    // One blank row, as between any reply and the next prompt.
    expect(shown[prompt - 1]).toBe("");
    expect(shown[prompt - 2]).toContain("GPT-6-Astra");
  });

  test("a notification delivered mid-turn adds no blank row between the prompt and its reply", () => {
    const state = createInitialState();
    state.messages.push(user("run it"), assistant([...call("c", "sleep 75")]), note(1), assistant([{ type: "text", text: "done" }]));
    const shown = rows(state);
    const prompt = shown.findIndex(row => row.includes("run it"));
    expect(shown.slice(prompt + 1, prompt + 3)).toEqual(["", "  done"]);
  });

  test("a turn a notice split leaves no lone metadata line where its first part folded away", () => {
    const state = createInitialState();
    state.messages.push(
      user("start"), assistant([{ type: "text", text: "ok" }]),
      note(1), assistant([...call("a", "ssh zurich uptime")]),
      notice("✗ Daemon restarted"),
      assistant([...call("b", "ssh zurich df"), { type: "text", text: "All healthy." }]),
    );
    expect(rows(state).filter(row => row.includes("GPT-6-Astra"))).toHaveLength(2);
    freshMatchesIncremental(state);
    state.showTurnWork = true;
    expect(rows(state).filter(row => row.includes("GPT-6-Astra"))).toHaveLength(3);
  });

  test("the committed-row cache rebuilds exactly what a turn finishing changes", () => {
    const state = createInitialState();
    state.messages.push(...workTurn(), user("and now?"));
    buildMessageLines(state, 100, { reuseArrays: true });
    state.pendingAI = createPendingAI(5_000, MODEL);
    state.pendingAI.blocks.push(...call("c3", "ls"), { type: "text", text: "Done." });
    freshMatchesIncremental(state);
    state.messages.push(state.pendingAI);
    state.pendingAI = null;
    freshMatchesIncremental(state);
  });
});

describe("Ctrl+O and Ctrl+I", () => {
  test("Ctrl+O shows every turn's work and every notification, left-aligned; Ctrl+I adds tool output; Ctrl+O from there folds everything", () => {
    const state = createInitialState();
    state.cols = 100;
    state.messages.push(...workTurn(), note(1), silent("s1"));
    handleFocusedKey({ type: "ctrl-o" }, state);
    expect(state.showTurnWork).toBe(true);
    const open = rows(state);
    expect(open).toContain("  Checking the log first.");
    expect(open.some(row => row.includes("git diff --stat"))).toBe(true);
    expect(open).toContain("  Subagent completion");
    expect(open).toContain("  ▎ [notification] Subagent completed: exo:1");
    expect(open.some(row => row.includes("git log -1 output"))).toBe(false);

    handleFocusedKey({ type: "ctrl-i" }, state);
    expect(state.showToolOutput).toBe(true);
    expect(rows(state).some(row => row.includes("git log -1 output"))).toBe(true);

    handleFocusedKey({ type: "ctrl-o" }, state);
    expect(state.showToolOutput).toBe(false);
    expect(state.showTurnWork).toBe(false);
    expect(rows(state).some(row => row.includes("git diff --stat"))).toBe(false);
  });

  test("Ctrl+O is saved and survives switching conversations; Ctrl+I does not", () => {
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

  test("Ctrl+I parses from the kitty keyboard protocol, apart from Tab", () => {
    expect(parseInput("\x1b[105;5u")).toEqual([{ type: "ctrl-i" }]);
    expect(parseInput("\x1b[105;5:1u")).toMatchObject([{ type: "ctrl-i" }]);
    expect(parseInput("\t")).toEqual([{ type: "tab" }]);
  });

  test("Ctrl+I falls back to Tab in the history, which has no Tab of its own, but not in the prompt", () => {
    const state = createInitialState();
    state.messages.push(...workTurn());
    handleFocusedKey({ type: "tab" }, state);
    expect(state.showToolOutput).toBe(false);
    focusHistory(state);
    handleFocusedKey({ type: "tab" }, state);
    expect(state.showToolOutput).toBe(true);
  });

  test("the queue shows only the owner's own messages until Ctrl+O, which shows notifications left-aligned", () => {
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
    expect(rows(state).some(row => row.includes("Gmail"))).toBe(true);
  });
});

describe("the live turn", () => {
  test("shows a Working row with the count, no arrow, and only the newest command", () => {
    const state = createInitialState();
    state.messages.push(user("run things"));
    state.pendingAI = createPendingAI(Date.now(), MODEL);
    state.pendingAI.blocks.push({ type: "text", text: "Starting." }, ...call("c1", "ls"), ...call("c2", "sleep 40"));
    const built = buildMessageLines(state, 100);
    const shown = built.lines.map(line => stripAnsi(line).trimEnd()).filter(Boolean);
    expect(shown[1]).toMatch(/^ {2}\S Working · 1 tool call, 1 message$/);
    expect(shown[2]).toContain("sleep 40");
    expect(shown.some(row => row.includes("Starting."))).toBe(false);
    expect(shown.some(row => row.includes(" ls"))).toBe(false);
    // Enter on it opens nothing.
    state.historyLines = built.lines;
    state.historyLineAnchors = built.lineAnchors;
    focusHistory(state);
    state.historyCursor = { row: built.lines.findIndex(line => stripAnsi(line).includes("Working")), col: 2 };
    handleFocusedKey({ type: "enter" }, state);
    expect(rows(state).some(row => row.includes(" ls"))).toBe(false);
  });

  test("streams the reply text in place of the last command once it starts", () => {
    const state = createInitialState();
    state.messages.push(user("run things"));
    state.pendingAI = createPendingAI(Date.now(), MODEL);
    state.pendingAI.blocks.push(...call("c1", "ls"), { type: "text", text: "All done" });
    const shown = rows(state).filter(Boolean);
    expect(shown[1]).toMatch(/Working · 1 tool call$/);
    expect(shown[2]).toBe("  All done");
  });

  test("the notification that started it leads the Working row", () => {
    const state = createInitialState();
    state.messages.push(user("go"), assistant([{ type: "text", text: "ok" }]), note(1));
    state.pendingAI = createPendingAI(Date.now(), MODEL);
    state.pendingAI.blocks.push(...call("c1", "git log -1"), ...call("c2", "git push"));
    const shown = rows(state).filter(Boolean);
    expect(shown.some(row => row.includes("exo:1"))).toBe(false);
    expect(shown.at(-3)).toMatch(/Working · Subagent completion · 1 tool call$/);
  });

  test("keeps the newest committed step in view, under the Working row, until the next round streams", () => {
    const state = createInitialState();
    state.messages.push(user("run things"), assistant([...call("c1", "ls"), ...call("c2", "pwd"), { type: "text", text: "Round done." }]));
    state.pendingAI = createPendingAI(Date.now(), MODEL);
    const shown = rows(state).filter(Boolean);
    expect(shown.slice(1, 3)).toEqual([expect.stringMatching(/Working · 2 tool calls$/), "  Round done."]);
  });

  test("the Working row is directly above the newest command on every frame, joining mid-turn and as tool calls stream", () => {
    const state = createInitialState();
    state.convId = "c";
    state.messages.push(user("run the checks"), assistant([...call("c1", "uptime"), ...call("c2", "df -h")]));
    handleStreamingStarted({ type: "streaming_started", convId: "c", startedAt: 2_000, model: MODEL } as Extract<Event, { type: "streaming_started" }>, state);
    const commands = ["df -h"];
    const check = () => {
      const shown = rows(state).filter(Boolean);
      const working = shown.findIndex(row => /Working/.test(row));
      expect(working).toBeGreaterThan(0);
      expect(shown[working + 1]).toContain(commands.at(-1)!);
      for (const older of commands.slice(0, -1)) expect(shown.some(row => row.includes(older))).toBe(false);
      expect(shown.some(row => row.includes("uptime"))).toBe(false);
    };
    check();
    for (const [id, command] of [["c3", "ls /tmp"], ["c4", "git status"], ["c5", "bun test"]] as const) {
      handleToolCall({ type: "tool_call", convId: "c", toolCallId: id, toolName: "bash", input: { command }, summary: command } as Extract<Event, { type: "tool_call" }>, state);
      commands.push(command);
      check();
      handleToolResult({ type: "tool_result", convId: "c", toolCallId: id, toolName: "bash", output: "ok", isError: false } as Extract<Event, { type: "tool_result" }>, state);
      check();
    }
  });
});

describe("a message delivered into the running turn", () => {
  const daemon: DaemonActions = { subscribe() {}, unsubscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} };
  const NOW = 10_000;
  const RUN = 1_000;
  const bash = (id: string, command: string) => ({ type: "tool_call", toolCallId: id, toolName: "bash", input: { command }, summary: command });
  const ok = (id: string) => ({ type: "tool_result", toolCallId: id, toolName: "bash", output: "ok", isError: false });

  /** A conversation streaming a run its prompt started at RUN, on a stopped clock. */
  function live(provider: "anthropic" | "openai" = "anthropic") {
    const state = createInitialState();
    state.convId = "c";
    const send = (event: object) => handleEvent({ convId: "c", ...event } as Event, state, daemon);
    state.messages.push({ role: "user", text: "run the checks", metadata: { startedAt: RUN, endedAt: RUN, model: MODEL, tokens: 0 } });
    send({ type: "streaming_started", provider, model: MODEL, startedAt: RUN, snapshotKind: "start" });
    return { state, send };
  }

  /** Every row, trimmed, with the spinner frame pinned; the incremental build must match a fresh one. */
  function frame(state: RenderState): string[] {
    const comparable = ({ revision: _revision, ...rest }: BuildMessageLinesResult) => rest;
    const incremental = buildMessageLines(state, 100, { reuseArrays: true });
    const shown = incremental.lines.map(line => stripAnsi(line).trim().replace(/^\S (?=Working)/, "* "));
    const kept = comparable(incremental);
    invalidateCommittedHistoryCache(state);
    expect(kept).toEqual(comparable(buildMessageLines(state, 100)));
    return shown;
  }

  let clock: ReturnType<typeof spyOn> | null = null;
  beforeAll(() => { clock = spyOn(Date, "now").mockReturnValue(NOW); });
  afterAll(() => clock?.mockRestore());

  const meta = "GPT-6-Astra | 0.0 tokens/s | 9s";

  test("an owner's next-turn message (Claude): the last command stays under Working until the next one starts, on every frame", () => {
    const { state, send } = live();
    send(bash("t1", "uptime"));
    send(ok("t1"));
    send(bash("t2", "df -h"));
    send(ok("t2"));
    const working = ["* Working · 1 tool call", "bash df -h", meta];
    expect(frame(state)).toEqual(["run the checks", "", ...working]);
    const injected = ["run the checks", "", "also check memory", ""];
    send({ type: "user_message", text: "also check memory", startedAt: 5_000, queueId: "q1" });
    expect(frame(state)).toEqual([...injected, ...working]);
    send({ type: "block_start", blockType: "thinking" });
    send({ type: "thinking_chunk", text: "Memory next." });
    expect(frame(state)).toEqual([...injected, ...working]);
    send({ type: "tokens_update", tokens: 40 });
    expect(frame(state)).toEqual([...injected, ...working]);
    send(bash("t3", "free -m"));
    expect(frame(state)).toEqual([...injected, "* Working · 2 tool calls", "bash free -m", meta]);
    send(ok("t3"));
    expect(frame(state)).toEqual([...injected, "* Working · 2 tool calls", "bash free -m", meta]);
    send({ type: "text_chunk", text: "Memory is fine." });
    expect(frame(state)).toEqual([...injected, "* Working · 3 tool calls", "Memory is fine.", meta]);
    send({
      type: "message_complete", endedAt: 9_000, tokens: 40,
      blocks: [bash("t1", "uptime"), ok("t1"), bash("t2", "df -h"), ok("t2"), { type: "thinking", text: "Memory next." }, bash("t3", "free -m"), ok("t3"), { type: "text", text: "Memory is fine." }],
    });
    send({ type: "streaming_stopped" });
    // The turn ended: its work folds as usual.
    const ended = frame(state);
    expect(ended.slice(0, -1)).toEqual([...injected, "Memory is fine."]);
    expect(ended.at(-1)).toContain("GPT-6-Astra");
  });

  test("steering now (other providers): mid-thought, the command stays; mid-text, the text stays in view above the message", () => {
    const thinking = live("openai");
    thinking.send(bash("t1", "uptime"));
    thinking.send(ok("t1"));
    thinking.send({ type: "thinking_chunk", text: "Disk next." });
    expect(frame(thinking.state)).toEqual(["run the checks", "", "* Working", "bash uptime", meta]);
    thinking.send({ type: "user_message", text: "check memory instead", startedAt: 5_000, queueId: "s1" });
    expect(frame(thinking.state)).toEqual(["run the checks", "", "check memory instead", "", "* Working", "bash uptime", meta]);
    thinking.send(bash("t2", "free -m"));
    expect(frame(thinking.state)).toEqual(["run the checks", "", "check memory instead", "", "* Working · 1 tool call", "bash free -m", meta]);

    const text = live("openai");
    text.send(bash("t1", "uptime"));
    text.send(ok("t1"));
    text.send({ type: "text_chunk", text: "Now checking disk" });
    expect(frame(text.state)).toEqual(["run the checks", "", "* Working · 1 tool call", "Now checking disk", meta]);
    text.send({ type: "user_message", text: "check memory instead", startedAt: 5_000, queueId: "s2" });
    expect(frame(text.state)).toEqual(["run the checks", "", "Now checking disk", "", "check memory instead", "", "* Working · 1 tool call", meta]);
  });

  test("a notification delivered mid-turn: no row of its own, its label leads the Working row, the command stays", () => {
    const { state, send } = live();
    send(bash("t1", "git push"));
    send(ok("t1"));
    send({ type: "user_message", text: "[notification] Subagent completed: exo:1", startedAt: 5_000, queueId: "n1", automation: { kind: "subagent_completion" } });
    expect(frame(state)).toEqual(["run the checks", "", "* Working · Subagent completion", "bash git push", meta]);
    send({ type: "user_message", text: "and the tags", startedAt: 6_000, queueId: "q1" });
    expect(frame(state)).toEqual(["run the checks", "", "and the tags", "", "* Working · Subagent completion", "bash git push", meta]);
    send(bash("t2", "git push --tags"));
    expect(frame(state)).toEqual(["run the checks", "", "and the tags", "", "* Working · Subagent completion · 1 tool call", "bash git push --tags", meta]);
  });

  test("a client joining after the message went in shows the same rows", () => {
    const state = createInitialState();
    state.convId = "c";
    state.messages.push(
      { role: "user", text: "run the checks", metadata: { startedAt: RUN, endedAt: RUN, model: MODEL, tokens: 0 } },
      assistant([...call("t1", "uptime"), ...call("t2", "df -h")], RUN),
      { role: "user", text: "also check memory", metadata: { startedAt: 5_000, endedAt: 5_000, model: MODEL, tokens: 0, queueEntryId: "q1" } },
    );
    handleEvent({ type: "streaming_started", convId: "c", provider: "anthropic", model: MODEL, startedAt: RUN, snapshotKind: "catchup", blocks: [] } as Event, state, daemon);
    expect(frame(state)).toEqual(["run the checks", "", "also check memory", "", "* Working · 1 tool call", "bash df -h", meta]);
  });

  test("a message-end handoff starts a new run: the last turn's command does not carry over", () => {
    const state = createInitialState();
    state.convId = "c";
    state.messages.push(
      { role: "user", text: "run the checks", metadata: { startedAt: RUN, endedAt: RUN, model: MODEL, tokens: 0 } },
      assistant([...call("t1", "uptime")], RUN),
      notice("✗ Interrupted"),
    );
    handleEvent({ type: "user_message", convId: "c", text: "next one", startedAt: 5_000, queueId: "m1" } as Event, state, daemon);
    handleEvent({ type: "streaming_started", convId: "c", provider: "anthropic", model: MODEL, startedAt: 5_000, snapshotKind: "start" } as Event, state, daemon);
    expect(frame(state)).toEqual(["run the checks", "", "next one", "", "* Working", "GPT-6-Astra | 0.0 tokens/s | 5s"]);
  });
});

describe("informational notices fold with the turn's work", () => {
  test("a daemon restart mid-turn: no notice and no lone metadata line; Ctrl+O shows it in order", () => {
    const state = createInitialState();
    state.messages.push(
      user("check the VM"), assistant([{ type: "text", text: "On it." }, ...call("a", "ssh zurich uptime")]),
      notice("✗ Daemon restarted"),
      assistant([...call("b", "ssh zurich df"), { type: "text", text: "All healthy." }]),
    );
    expect(rows(state).filter(Boolean)).toEqual([expect.stringContaining("check the VM"), "  All healthy.", expect.stringContaining("GPT-6-Astra")]);
    freshMatchesIncremental(state);
    state.showTurnWork = true;
    const open = rows(state);
    const at = (text: string) => open.findIndex(row => row.includes(text));
    const order = [at("On it."), at("ssh zurich uptime"), at("Daemon restarted"), at("ssh zurich df"), at("All healthy.")];
    expect(order.every(row => row >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("interrupted, retry and compaction notices fold; real errors and warnings stay", () => {
    const state = createInitialState();
    state.messages.push(
      user("go"), assistant([...call("a", "ls")]), notice("✗ Interrupted"),
      user("again"), assistant([{ type: "text", text: "Trying." }]), notice("⟳ Overloaded — retrying in 5s (1/3)…"),
      assistant([{ type: "text", text: "Done." }]),
      { role: "system", text: "--- Compaction finished ---", metadata: { startedAt: 1, endedAt: 1, model: MODEL, tokens: 0, kind: "context_compaction_finished" } } as Message,
      user("more"), assistant([{ type: "text", text: "Partial" }]), notice("✗ OpenAI API error (500): server error"),
      user("last"), assistant([{ type: "text", text: "Ok" }]), notice("⚠ Automatic context compaction failed; continuing without it."),
    );
    const shown = rows(state);
    for (const gone of ["Interrupted", "Overloaded", "Compaction finished"]) expect(shown.some(row => row.includes(gone))).toBe(false);
    for (const kept of ["OpenAI API error", "Automatic context compaction failed"]) expect(shown.some(row => row.includes(kept))).toBe(true);
    freshMatchesIncremental(state);
  });

  test("in the live turn: hidden, and its interrupted part leaves no metadata line", () => {
    const state = createInitialState();
    state.messages.push(user("check the VM"), assistant([...call("a", "ssh zurich uptime")]), notice("✗ Daemon restarted"));
    state.pendingAI = createPendingAI(5_000, MODEL);
    const shown = rows(state).filter(Boolean);
    expect(shown.some(row => row.includes("Daemon restarted"))).toBe(false);
    const working = shown.findIndex(row => /Working/.test(row));
    expect(shown.slice(0, working).some(row => row.includes("GPT-6-Astra"))).toBe(false);
    expect(shown[working + 1]).toContain("ssh zurich uptime");
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

  test("prompts another conversation sent are not notifications", () => {
    expect(notificationLabel(user("Fix vimbrowser input handling.", { kind: "exo_send", sourceId: "parent-1" }))).toBeNull();
  });
});

const RELAY_TEXT = (body: string) => `[notification] Discord/paramount · DM\nYeyito [ch:1]\n\n→ Yeyito <@3> [owner] ↳ [reply-to:9]:\n${body}\n[msg:5]\n\nAction: answer on Discord.\n\nFilter output:\nRoute: owner (Yeyito) · dm`;

// A terminal without truecolor maps both bubble backgrounds to one colour: pin them apart.
const savedBackgrounds = { userBg: theme.userBg, automatedUserBg: theme.automatedUserBg };
beforeAll(() => Object.assign(theme, { userBg: "\x1b[48;2;9;13;53m", automatedUserBg: "\x1b[48;2;14;31;44m" }));
afterAll(() => Object.assign(theme, savedBackgrounds));

/** The background a message's bubble rows were painted with, per row of its content. */
function bubbleBackgrounds(built: BuildMessageLinesResult, owner: object): string[] {
  return built.lineAnchors.flatMap((anchor, row) => {
    if (anchor.owner !== owner || (anchor.segment !== "user_content" && anchor.segment !== "queued_content")) return [];
    const line = built.lines[row];
    return [line.includes(theme.userBg) ? "owner" : line.includes(theme.automatedUserBg) ? "automated" : "none"];
  });
}

const VIEWS = [
  ["folded", (_state: RenderState) => {}],
  ["Ctrl+O", (state: RenderState) => { state.showTurnWork = true; }],
  ["Ctrl+I", (state: RenderState) => { state.showToolOutput = true; }],
] as const;

describe("a parent conversation's prompts", () => {
  const delegation = () => user("Fix vimbrowser input handling.", { kind: "exo_send", sourceId: "parent-1" });

  test("the first one: the automated bubble with the parent below it, in every view", () => {
    for (const [view, open] of VIEWS) {
      const state = createInitialState();
      state.sidebar.conversations = [{ id: "parent-1", title: "📡 paramount" } as never];
      const first = delegation();
      state.messages.push(first, assistant([{ type: "text", text: "On it." }]));
      open(state);
      const built = buildMessageLines(state, 100);
      const shown = built.lines.map(line => stripAnsi(line).trim()).filter(Boolean);
      expect(shown.slice(0, 2), view).toEqual(["Fix vimbrowser input handling.", "⚙ Exo delegation · from 📡 paramount"]);
      expect(bubbleBackgrounds(built, first), view).toEqual(["automated"]);
      freshMatchesIncremental(state);
    }
  });

  test("the first one while its turn still runs: the same bubble and label above the Working row", () => {
    const state = createInitialState();
    state.sidebar.conversations = [{ id: "parent-1", title: "📡 paramount" } as never];
    const first = delegation();
    state.messages.push(first);
    state.pendingAI = createPendingAI(Date.now(), MODEL);
    state.pendingAI.blocks.push(...call("c1", "ls"));
    const built = buildMessageLines(state, 100);
    const shown = built.lines.map(line => stripAnsi(line).trim()).filter(Boolean);
    expect(shown.slice(0, 2)).toEqual(["Fix vimbrowser input handling.", "⚙ Exo delegation · from 📡 paramount"]);
    expect(shown[2]).toMatch(/^\S Working$/);
    expect(bubbleBackgrounds(built, first)).toEqual(["automated"]);
  });

  test("follow-ups read the same, between the owner's own messages", () => {
    for (const [view, open] of VIEWS) {
      const state = createInitialState();
      state.sidebar.conversations = [{ id: "parent-1", title: "📡 paramount" } as never];
      const own = user("my own words");
      const followUp = user("Also check the queue.", { kind: "exo_send", sourceId: "parent-1" });
      state.messages.push(delegation(), assistant([{ type: "text", text: "On it." }]), followUp, assistant([{ type: "text", text: "Checked." }]), own, assistant([{ type: "text", text: "ok" }]));
      open(state);
      const built = buildMessageLines(state, 100);
      const shown = built.lines.map(line => stripAnsi(line).trim()).filter(Boolean);
      const at = shown.indexOf("Also check the queue.");
      expect(shown[at + 1], view).toBe("⚙ Exo delegation · from 📡 paramount");
      expect(bubbleBackgrounds(built, followUp), view).toEqual(["automated"]);
      expect(bubbleBackgrounds(built, own), view).toEqual(["owner"]);
    }
  });

  test("a parent missing from the sidebar is named by its id; one with no id as another conversation", () => {
    const state = createInitialState();
    state.messages.push(
      user("by id", { kind: "exo_send", sourceId: "1791667824123-k14mhj" }), assistant([{ type: "text", text: "a" }]),
      user("no id", { kind: "exo_send" }), assistant([{ type: "text", text: "b" }]),
    );
    const shown = rows(state).map(row => row.trim()).filter(Boolean);
    expect(shown[shown.indexOf("by id") + 1]).toBe("⚙ Exo delegation · from 1791667824123-k14mhj");
    expect(shown[shown.indexOf("no id") + 1]).toBe("⚙ Exo delegation · from another conversation");
  });

  test("a child's report through `exo queue` reads the same, from the child", () => {
    for (const [view, open] of VIEWS) {
      const state = createInitialState();
      state.sidebar.conversations = [{ id: "gap354", title: "You are GAP354, a research agent" } as never];
      const report = user("[GAP354 → manager] Oct 24 rerun done.", { kind: "exo_send", sourceId: "gap354" });
      state.messages.push(report, assistant([{ type: "text", text: "Thanks." }]));
      open(state);
      const built = buildMessageLines(state, 100);
      const shown = built.lines.map(line => stripAnsi(line).trim()).filter(Boolean);
      expect(shown.slice(0, 2), view).toEqual(["[GAP354 → manager] Oct 24 rerun done.", "⚙ Exo delegation · from You are GAP354, a research agent"]);
      expect(bubbleBackgrounds(built, report), view).toEqual(["automated"]);
    }
  });

  test("quoting the owner's relay line does not make a parent's prompt the owner's bubble", () => {
    const state = createInitialState();
    const forwarded = user(RELAY_TEXT("please fix the queue"), { kind: "exo_send", sourceId: "parent-1" });
    state.messages.push(forwarded, assistant([{ type: "text", text: "ok" }]));
    expect(ownerWords(forwarded.text, forwarded.metadata?.automation)).toBe(false);
    expect(new Set(bubbleBackgrounds(buildMessageLines(state, 100), forwarded))).toEqual(new Set(["automated"]));
  });

  test("queued, they wait at the bottom in every view: automated, from the parent, with their timing", () => {
    for (const [view, open] of VIEWS) {
      const state = createInitialState();
      state.convId = "child-1";
      state.sidebar.conversations = [{ id: "parent-1", title: "📡 paramount" } as never];
      state.messages.push(delegation(), assistant([{ type: "text", text: "On it." }]));
      const queued = { convId: "child-1", text: "Then rebase.", timing: "next-turn" as const, automation: { kind: "exo_send" as const, sourceId: "parent-1" } };
      const mine = { convId: "child-1", text: "my queued words", timing: "next-turn" as const };
      state.queuedMessages.push(queued, mine);
      open(state);
      const built = buildMessageLines(state, 100);
      const label = built.lineAnchors.findIndex(anchor => anchor.owner === queued && anchor.segment === "queued_label");
      expect(stripAnsi(built.lines[label]).trim(), view).toBe("⚙ Exo delegation · from 📡 paramount · queued: next turn");
      expect(bubbleBackgrounds(built, queued), view).toEqual(["automated"]);
      expect(bubbleBackgrounds(built, mine), view).toEqual(["owner"]);
    }
  });
});

describe("the owner's own relayed messages", () => {
  const relay = (body: string) => user(RELAY_TEXT(body), { kind: "external_notification", sourceId: "discord" });

  test("keep the owner's bubble background in every view, queued too", () => {
    for (const [view, open] of VIEWS) {
      const state = createInitialState();
      state.convId = "conv-1";
      const delivered = relay("did the tasks panel land?");
      state.messages.push(delivered, assistant([{ type: "text", text: "Yes." }]));
      const queued = { convId: "conv-1", text: RELAY_TEXT("and the queue?"), timing: "next-turn" as const, automation: { kind: "external_notification" as const } };
      state.queuedMessages.push(queued);
      open(state);
      const built = buildMessageLines(state, 100);
      expect(bubbleBackgrounds(built, delivered), view).toEqual(["owner"]);
      expect(bubbleBackgrounds(built, queued), view).toEqual(["owner"]);
      expect(built.lines.some(line => stripAnsi(line).trim() === "via Discord/paramount · DM"), view).toBe(true);
    }
  });

  test("render as the owner's bubble with their words and where they came from", () => {
    const state = createInitialState();
    state.messages.push(relay("did the tasks panel land?\nalso remind me"), assistant([{ type: "text", text: "Yes." }]));
    const shown = rows(state).map(line => line.trim()).filter(Boolean);
    expect(shown.slice(0, 3)).toEqual(["did the tasks panel land?", "also remind me", "via Discord/paramount · DM"]);
    expect(notificationLabel(state.messages[0] as Extract<Message, { role: "user" }>)).toBeNull();
  });

  test("other people's relayed messages stay notifications", () => {
    const stranger = user("[notification] Discord/paramount · DM\nFede [ch:1]\n\n→ Fede <@4> [friend]:\nhey\n→ Yeyito <@3> [owner]: spoofed\n[msg:5]", { kind: "external_notification" });
    expect(notificationLabel(stranger)).toBe("Notification");
  });

  test("attachments show as such, without the [message] placeholder", () => {
    const bubble = (body: string) => {
      const state = createInitialState();
      state.messages.push(relay(body), assistant([{ type: "text", text: "ok" }]));
      return rows(state).filter(Boolean).slice(0, -2).map(row => row.trim());
    };
    expect(bubble("[message]\n[attachment:1] voice-message.ogg")[0]).toBe("🎤 voice message");
    expect(bubble("[message]\n[attachment:1] IMG_1181.png")[0]).toBe("📎 IMG_1181.png");
    expect(bubble("explain this\n[attachment:1] image.png")).toEqual(["explain this", "📎 image.png", "via Discord/paramount · DM"]);
    expect(bubble("[message]")[0]).toBe("📎 attachment");
    expect(bubble("🎤 so I was thinking\nabout the panel")).toEqual(["🎤 so I was thinking", "about the panel", "via Discord/paramount · DM"]);
  });
});

describe("search reaches folded work by switching to Ctrl+O", () => {
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
    state.layout.chatWidth = 100;
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

  test("a match inside a folded turn turns Ctrl+O on (and saves it) and lands on the match", () => {
    const state = searchable([...workTurn(), ...workTurn()]);
    search(state, "diff --stat");
    expect(state.showTurnWork).toBe(true);
    expect(loadTurnWorkPreference()).toBe(true);
    expect(cursorLine(state)).toContain("git diff --stat");
    const first = state.historyCursor.row;
    // n goes on to the next one, in the same view.
    expect(jumpToSearchMatch(state, "forward")).toBe(true);
    expect(state.historyCursor.row).toBeGreaterThan(first);
    expect(cursorLine(state)).toContain("git diff --stat");
  });

  test("a visible match nearer than a folded one stays in the folded view; the next one switches", () => {
    const state = searchable([
      user("start here"),
      assistant([{ type: "text", text: "needle visible" }]),
      note(1),
      assistant([...call("c", "grep needle inside"), { type: "text", text: "Found it." }]),
    ]);
    search(state, "needle");
    expect(state.showTurnWork).toBe(false);
    expect(cursorLine(state)).toContain("needle visible");
    expect(jumpToSearchMatch(state, "forward")).toBe(true);
    expect(state.showTurnWork).toBe(true);
    expect(cursorLine(state)).toContain("needle inside");
  });

  test("a folded notification or notice is found the same way", () => {
    const state = searchable([user("go"), assistant([...call("a", "ls")]), notice("✗ Daemon restarted"), assistant([{ type: "text", text: "Back." }])]);
    search(state, "Daemon restarted");
    expect(state.showTurnWork).toBe(true);
    expect(cursorLine(state)).toContain("Daemon restarted");
  });

  test("no match anywhere changes nothing", () => {
    const state = searchable([...workTurn()]);
    search(state, "nowhere to be found");
    expect(state.showTurnWork).toBe(false);
  });
});

describe("the gap between consecutive user messages", () => {
  /** Row texts with the right-aligned bubble text trimmed, so a gap reads as "" rows between two texts. */
  const gapRows = (state: RenderState, width = 100) => rows(state, width).map(row => row.trim());
  const reply = () => assistant([{ type: "text", text: "Reply." }]);

  test("are one blank row apart when nothing is shown between them", () => {
    const state = createInitialState();
    state.messages.push(user("first"), user("second"));
    expect(gapRows(state)).toEqual(["first", "", "second", ""]);
    freshMatchesIncremental(state);
  });

  test("stay one blank row apart when the work and notifications between them fold away", () => {
    const state = createInitialState();
    state.messages.push(user("first"), note(1), silent("s1"), wake(2), silent("s2"), user("second"));
    expect(gapRows(state)).toEqual(["first", "", "second", ""]);
    freshMatchesIncremental(state);
  });

  test("hold at a narrow width, where the Tasks panel leaves the chat", () => {
    const state = createInitialState();
    state.messages.push(user("first"), silent("s1"), user("second"));
    expect(gapRows(state, 30)).toEqual(["first", "", "second", ""]);
  });

  test("hold for every consecutive pair in a run of three", () => {
    const state = createInitialState();
    state.messages.push(user("first"), user("second"), silent("s1"), user("third"));
    expect(gapRows(state)).toEqual(["first", "", "second", "", "third", ""]);
  });

  test("hold under Ctrl+O and Ctrl+I as well", () => {
    for (const [view, open] of VIEWS) {
      const state = createInitialState();
      state.messages.push(user("first"), user("second"));
      open(state);
      expect(gapRows(state), view).toEqual(["first", "", "second", ""]);
    }
  });

  test("queued messages follow the last message and each other one blank row apart", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push(user("first"));
    state.queuedMessages.push(
      { convId: "conv-1", text: "queued one", timing: "next-turn" },
      { convId: "conv-1", text: "queued two", timing: "next-turn" },
    );
    expect(gapRows(state)).toEqual(["first", "", "queued one", "queued: steer", "", "queued two", "queued: steer"]);
  });

  test("a queued message below a reply keeps its single blank row", () => {
    const state = createInitialState();
    state.convId = "conv-1";
    state.messages.push(user("first"), reply());
    state.queuedMessages.push({ convId: "conv-1", text: "queued one", timing: "next-turn" });
    const shown = gapRows(state);
    expect(shown.slice(0, 4)).toEqual(["first", "", "Reply.", expect.stringContaining("GPT-6-Astra")]);
    expect(shown.slice(4)).toEqual(["", "queued one", "queued: steer"]);
  });

  test("the other gaps are unchanged: user to reply, reply to user, a reply after folded work", () => {
    const state = createInitialState();
    state.messages.push(user("first"), reply(), user("second"), silent("s1"), reply(), user("third"));
    expect(gapRows(state)).toEqual([
      "first", "", "Reply.", expect.stringContaining("GPT-6-Astra"),
      "", "second", "", "Reply.", expect.stringContaining("GPT-6-Astra"),
      "", "third", "",
    ]);
  });

  test("an incremental rebuild gives the same rows when a reply arrives between two messages", () => {
    const state = createInitialState();
    const folded = silent("s1");
    state.messages.push(user("first"), folded, user("second"), user("third"));
    expect(gapRows(state)).toEqual(["first", "", "second", "", "third", ""]);
    freshMatchesIncremental(state);
    // The silent turn gains a reply: the rows after it need their top margin back.
    folded.blocks.push({ type: "text", text: "Reply." });
    expect(gapRows(state)).toEqual(["first", "", "Reply.", expect.stringContaining("GPT-6-Astra"), "", "second", "", "third", ""]);
    freshMatchesIncremental(state);
  });
});

describe("the gap around a notification shown in full", () => {
  const gapRows = (state: RenderState, width = 100) => rows(state, width).map(row => row.trim());
  const reply = () => assistant([{ type: "text", text: "Reply." }]);
  const NOTE = "▎ [notification] Subagent completed: exo:1";
  const header = "Subagent completion";

  test("a notification and the user message beside it are one blank row apart, both ways", () => {
    const state = createInitialState();
    state.showTurnWork = true;
    state.messages.push(user("first"), note(1), user("second"));
    expect(gapRows(state)).toEqual(["first", "", header, NOTE, "", "second", ""]);
    freshMatchesIncremental(state);
  });

  test("consecutive notifications are one blank row apart", () => {
    const state = createInitialState();
    state.showTurnWork = true;
    state.messages.push(user("first"), note(1), note(2), user("second"));
    expect(gapRows(state)).toEqual([
      "first", "", header, NOTE, "", header, "▎ [notification] Subagent completed: exo:2", "", "second", "",
    ]);
    freshMatchesIncremental(state);
  });

  test("a notification at the top, and under Ctrl+I, read the same", () => {
    for (const open of [(state: RenderState) => { state.showTurnWork = true; }, (state: RenderState) => { state.showToolOutput = true; }]) {
      const state = createInitialState();
      open(state);
      state.messages.push(note(1), note(2), user("first"));
      expect(gapRows(state), "top").toEqual([header, NOTE, "", header, "▎ [notification] Subagent completed: exo:2", "", "first", ""]);
    }
  });

  test("hold at a narrow width", () => {
    const state = createInitialState();
    state.showTurnWork = true;
    state.messages.push(user("first"), note(1), user("second"));
    const shown = gapRows(state, 30);
    expect(shown[0]).toBe("first");
    expect(shown[1]).toBe("");
    expect(shown[2]).toBe(header);
    expect(shown.slice(-3)).toEqual(["", "second", ""]);
    expect(shown.filter((row, i) => row === "" && shown[i + 1] === "")).toEqual([]);
  });

  test("the gaps to and from the assistant are unchanged", () => {
    const state = createInitialState();
    state.showTurnWork = true;
    state.messages.push(user("first"), reply(), note(1), reply(), user("second"));
    expect(gapRows(state)).toEqual([
      "first", "", "Reply.", expect.stringContaining("GPT-6-Astra"),
      "", header, NOTE, "",
      "Reply.", expect.stringContaining("GPT-6-Astra"),
      "", "second", "",
    ]);
  });

  test("the folded view still shows no notification, and one blank row between messages", () => {
    const state = createInitialState();
    state.messages.push(user("first"), note(1), user("second"));
    expect(gapRows(state)).toEqual(["first", "", "second", ""]);
  });

  test("follow-up, still-working and stopped subagent notices fold like any other report", () => {
    const state = createInitialState();
    const report = (header: string) => user(`[notification] Subagent ${header}: exo:7\nTask: build\nWoken by: a message from exo:9`, { kind: "subagent_completion" });
    state.messages.push(user("first"), report("replied (still working)"), report("completed"), report("stopped"), user("second"));
    expect(gapRows(state)).toEqual(["first", "", "second", ""]);
    expect(notificationLabel(report("stopped"))).toBe("Subagent completion");
    expect(notificationPreview(report("replied (still working)").text)).toStartWith("Subagent replied (still working): exo:7");
  });

  test("a queued notification below a message is one blank row away", () => {
    const state = createInitialState();
    state.showTurnWork = true;
    state.convId = "conv-1";
    state.messages.push(user("first"), note(1));
    state.queuedMessages.push({ convId: "conv-1", text: "[notification] Gmail", timing: "next-turn", automation: { kind: "external_notification" } });
    const shown = gapRows(state);
    expect(shown.slice(0, 5)).toEqual(["first", "", header, NOTE, ""]);
    expect(shown[5]).toContain("Notification · queued");
    expect(shown[6]).toBe("▎ [notification] Gmail");
  });

  test("an incremental rebuild keeps the gap when a message arrives after a notification", () => {
    const state = createInitialState();
    state.showTurnWork = true;
    state.messages.push(user("first"), note(1));
    expect(gapRows(state)).toEqual(["first", "", header, NOTE, ""]);
    freshMatchesIncremental(state);
    state.messages.push(user("second"), note(2), user("third"));
    expect(gapRows(state)).toEqual([
      "first", "", header, NOTE, "", "second", "", header, "▎ [notification] Subagent completed: exo:2", "", "third", "",
    ]);
    freshMatchesIncremental(state);
  });
});

describe("images the attach tool added", () => {
  const ref = (n: number) => ({ id: String(n).repeat(64), mediaType: "image/png" as const, width: 400, height: 200, sizeBytes: 5000, name: `shot${n}.png` });
  const attach = (id: string, count: number): Extract<Message, { role: "assistant" }>["blocks"] => [
    { type: "tool_call", toolCallId: id, toolName: "attach", input: { paths: ["a.png"] }, summary: "a.png" },
    { type: "tool_result", toolCallId: id, toolName: "attach", output: `Attached ${count} images`, isError: false, images: Array.from({ length: count }, (_, i) => ref(i + 1)) },
  ];
  const midRun = (text: string, startedAt = 5_000): Message => ({ role: "user", text, metadata: { startedAt, endedAt: startedAt, model: MODEL, tokens: 0, queueEntryId: `q${startedAt}` } });
  /** Each drawn row's segment, in order, collapsing runs: where the images sit among the bubbles and replies. */
  function layout(state: RenderState): string[] {
    const out: string[] = [];
    for (const anchor of buildMessageLines(state, 100).lineAnchors) {
      const segment = anchor.segment === "user_margin_top" || anchor.segment === "user_margin_bottom" ? null : anchor.segment;
      if (segment && out.at(-1) !== segment) out.push(segment);
    }
    return out;
  }
  const images = (state: RenderState) => buildMessageLines(state, 100).lineAnchors.filter(anchor => anchor.segment === "assistant_image");

  test("stay in view when the owner's message went into the turn after them, where Ctrl+O shows them", () => {
    const state = createInitialState();
    state.messages.push(
      user("compare the two"),
      assistant([...call("c1", "make shots"), ...attach("c2", 3)]),
      midRun("also the old one"),
      assistant([...call("c3", "git log"), { type: "text", text: "Done: B is better." }]),
    );
    expect(layout(state)).toEqual(["user_content", "assistant_image", "user_content", "assistant_block", "assistant_metadata"]);
    expect(images(state).length).toBeGreaterThan(0);
    handleFocusedKey({ type: "ctrl-o" }, state);
    const expanded = layout(state);
    expect(expanded.indexOf("assistant_image")).toBeLessThan(expanded.lastIndexOf("user_content"));
    freshMatchesIncremental(state);
  });

  test("stay in view when a notification went into the turn after them", () => {
    const state = createInitialState();
    state.messages.push(
      user("compare the two"),
      assistant(attach("c1", 2)),
      note(1),
      assistant([{ type: "text", text: "Done." }]),
    );
    expect(layout(state)).toEqual(["user_content", "assistant_image", "assistant_block", "assistant_metadata"]);
  });

  test("a turn that only attached them keeps them, also before the next prompt", () => {
    const state = createInitialState();
    state.messages.push(user("send me the chart"), assistant(attach("c1", 1)), user("thanks"), assistant([{ type: "text", text: "Sure." }]));
    expect(layout(state)).toEqual(["user_content", "assistant_image", "user_content", "assistant_block", "assistant_metadata"]);
  });

  test("in the live turn: still in view after a message went in, and after it ends", () => {
    const daemon: DaemonActions = { subscribe() {}, unsubscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} };
    const state = createInitialState();
    state.convId = "c";
    const send = (event: object) => handleEvent({ convId: "c", ...event } as Event, state, daemon);
    state.messages.push({ role: "user", text: "compare the two", metadata: { startedAt: 1_000, endedAt: 1_000, model: MODEL, tokens: 0 } });
    send({ type: "streaming_started", provider: "anthropic", model: MODEL, startedAt: 1_000, snapshotKind: "start" });
    const [attachCall, attachResult] = attach("c1", 3);
    send(attachCall);
    send(attachResult);
    expect(images(state).length).toBeGreaterThan(0);
    freshMatchesIncremental(state);
    send({ type: "user_message", text: "also the old one", startedAt: 5_000, queueId: "q1" });
    expect(layout(state).slice(0, 3)).toEqual(["user_content", "assistant_image", "user_content"]);
    freshMatchesIncremental(state);
    send({ type: "text_chunk", text: "B is better." });
    send({ type: "message_complete", endedAt: 9_000, tokens: 40, blocks: [{ type: "text", text: "B is better." }] });
    send({ type: "streaming_stopped" });
    expect(layout(state)).toEqual(["user_content", "assistant_image", "user_content", "assistant_block", "assistant_metadata"]);
    freshMatchesIncremental(state);
  });
});
