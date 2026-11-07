import { describe, expect, test } from "bun:test";
import { handleEvent, type DaemonActions } from "./events";
import { applyHistoryAction, scrollHalfPageWithCursor } from "./historycursor";
import type { Message } from "./messages";
import type { Event } from "./protocol";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";

// Rows beside the Tasks panel re-wrap narrower, so the canonical rows a cursor
// motion counts as on screen can need more screen rows than the pane has.

const daemon: DaemonActions = {
  subscribe() {}, unsubscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {},
};
const prose = (turn: number) => Array.from({ length: 6 }, (_, line) =>
  `Turn ${turn} line ${line}: the history runs at full width, but beside the Tasks panel it wraps narrower and takes more rows.`).join("\n");

function turn(index: number): Message[] {
  const startedAt = 1_000 + index * 10_000;
  return [
    { role: "user", text: `Question ${index}: ${"what is holding things back at the moment, biggest first? ".repeat(3)}`, metadata: { startedAt, endedAt: startedAt, model: "claude-opus-5-5", tokens: 0 } },
    { role: "assistant", blocks: [{ type: "text", text: prose(index) }], metadata: { startedAt: startedAt + 1, endedAt: startedAt + 2_000, model: "claude-opus-5-5", tokens: 10 } },
  ];
}

/** A reply split by its last tool call: the folded view keeps its first part and the call. */
function splitReplyTurn(index: number): Message[] {
  const [prompt, reply] = turn(index) as [Message, Extract<Message, { role: "assistant" }>];
  reply.blocks = [
    { type: "text", text: prose(index) },
    { type: "tool_call", toolCallId: `c${index}`, toolName: "bash", input: { command: "write scratchpad" }, summary: "write scratchpad" },
    { type: "tool_result", toolCallId: `c${index}`, toolName: "bash", output: "ok", isError: false },
    { type: "text", text: "Scratchpad updated." },
  ];
  return [prompt, reply];
}

function silently(state: RenderState): void {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    render(state);
  } finally {
    process.stdout.write = write;
  }
}

function setup(messages: Message[]): RenderState {
  const state = createInitialState();
  state.cols = 120;
  state.rows = 30;
  state.convId = "conv";
  state.sidebar.open = false;
  state.sidebar.conversations = [{
    id: "conv", provider: state.provider, model: state.model, effort: state.effort, fastMode: state.fastMode,
    createdAt: 1, updatedAt: 2, messageCount: messages.length, title: "Conv", marked: false, pinned: false,
    streaming: false, unread: false, sortOrder: 0,
    tasks: Array.from({ length: 6 }, (_, index) => ({ id: `task-${index}`, kind: "subagent" as const, title: `Task ${index} with a fairly long title`, startedAt: Date.now() - 2_000 })),
  }];
  state.messages = messages;
  state.panelFocus = "chat";
  state.chatFocus = "history";
  state.vim.mode = "normal";
  silently(state);
  state.historyCursor = { row: state.historyLines.length - 1, col: 0 };
  silently(state);
  return state;
}

function shownRows(state: RenderState): number[] {
  return state.layout.historyViewportRows.flatMap(row => row ? [row.lineIndex] : []);
}

function expectCursorOnScreen(state: RenderState, label: string): void {
  expect(shownRows(state), `${label}: cursor row ${state.historyCursor.row}`).toContain(state.historyCursor.row);
}

function press(state: RenderState, action: Parameters<typeof applyHistoryAction>[0], times = 1): void {
  for (let i = 0; i < times; i++) {
    applyHistoryAction(action, state);
    silently(state);
  }
}

describe("history cursor beside the Tasks panel", () => {
  test("k up through the whole history keeps the cursor on screen, up to the true top", () => {
    const state = setup(Array.from({ length: 12 }, (_, index) => turn(index)).flat());
    const panel = state.layout.taskPanelRect;
    expect(panel).not.toBeNull();
    let rows = state.historyCursor.row;
    while (state.historyCursor.row > 0) {
      press(state, "history_up");
      expectCursorOnScreen(state, `k at row ${state.historyCursor.row}`);
      expect(state.historyCursor.row).toBeLessThan(rows);
      rows = state.historyCursor.row;
    }
    expect(shownRows(state)[0]).toBe(0);
  });

  test("Ctrl+U and j keep the cursor on screen too", () => {
    const state = setup(Array.from({ length: 12 }, (_, index) => turn(index)).flat());
    for (let i = 0; i < 40 && state.historyCursor.row > 0; i++) {
      scrollHalfPageWithCursor(state, 1);
      silently(state);
      expectCursorOnScreen(state, `Ctrl+U to row ${state.historyCursor.row}`);
    }
    for (let i = 0; i < 120; i++) {
      press(state, "history_down");
      expectCursorOnScreen(state, `j at row ${state.historyCursor.row}`);
    }
  });

  test("gg while older pages load reaches the first entry, a folded split reply, with the cursor on it", () => {
    const older = [...splitReplyTurn(0), ...Array.from({ length: 5 }, (_, index) => turn(index + 1)).flat()];
    const state = setup(Array.from({ length: 6 }, (_, index) => turn(index + 6)).flat());
    state.historyStartIndex = older.length;
    state.historyHasOlder = true;
    press(state, "history_gg");
    // Deferred until the start of the history is loaded.
    expect(state.pendingHistoryNavigation).toBe("history_gg");
    const bottomRow = state.historyCursor.row;
    expect(bottomRow).toBe(state.historyLines.length - 1);

    const entries = older.map(message => message.role === "user"
      ? { type: "user" as const, text: message.text, metadata: message.metadata }
      : { type: "ai" as const, blocks: (message as Extract<Message, { role: "assistant" }>).blocks, metadata: message.metadata });
    for (const [start, end, hasOlder] of [[6, 12, true], [0, 6, false]] as const) {
      state.historyLoadingOlder = true;
      state.historyLoadingRequestId = `page-${start}`;
      handleEvent({
        type: "conversation_history_loaded", convId: "conv", reqId: `page-${start}`, requestSource: "viewport",
        entries: entries.slice(start, end) as Extract<Event, { type: "conversation_history_loaded" }>["entries"],
        historyStartIndex: start, historyEndIndex: end, historyStartUserIndex: start / 2,
        historyTotalEntries: 24, hasOlderHistory: hasOlder,
      }, state, daemon);
      silently(state);
      expectCursorOnScreen(state, `after the page from ${start}`);
    }
    expect(state.pendingHistoryNavigation).toBeNull();
    expect(state.historyCursor.row).toBe(0);
    expect(shownRows(state)[0]).toBe(0);
    expect(state.historyLines.some(line => line.includes("write scratchpad"))).toBe(true);
    // And back down from the top: j never leaves the screen behind.
    for (let i = 0; i < 80; i++) {
      press(state, "history_down");
      expectCursorOnScreen(state, `j at row ${state.historyCursor.row}`);
    }
  });
});
