import { describe, expect, test } from "bun:test";
import { buildMessageLines } from "./conversation";
import { handleEvent, type DaemonActions } from "./events";
import { handleFocusedKey } from "./focus";
import { applyHistoryAction, stripAnsi } from "./historycursor";
import { beginOlderHistoryLoad, shouldLoadOlderHistory } from "./historypagination";
import { createInitialState, type RenderState } from "./state";
import type { Event } from "./protocol";
import { createMessageMetadata } from "./messages";

const daemon: DaemonActions = {
  subscribe() {}, unsubscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {},
};
type Page = Extract<Event, { type: "conversation_history_loaded" }>;
const automatedMetadata = {
  ...createMessageMetadata(1, "gpt-5.6-sol"),
  automation: { kind: "chrono_wake" as const, sourceId: "test" },
};

function renderHistory(state: RenderState) {
  const rendered = buildMessageLines(state, 80);
  state.historyLines = rendered.lines;
  state.historyWrapContinuation = rendered.wrapContinuation;
  state.historyWrapJoiners = rendered.wrapJoiners;
  state.historyCopyLines = rendered.copyLines;
  state.historyMessageBounds = rendered.messageBounds;
  state.historyLineAnchors = rendered.lineAnchors;
  state.layout.totalLines = rendered.lines.length;
}

function setup() {
  const state = createInitialState();
  state.convId = "history-test";
  state.cols = 80;
  state.sidebar.open = false;
  state.panelFocus = "chat";
  state.chatFocus = "history";
  state.vim.mode = "normal";
  state.layout.messageAreaHeight = 10;
  state.historyStartIndex = 60;
  state.historyHasOlder = true;
  state.messages = [
    { role: "user", text: "new prompt", metadata: null },
    { role: "assistant", blocks: [{ type: "text", text: Array(100).fill("long reply").join("\n") }], metadata: null },
  ];
  renderHistory(state);
  state.historyCursor = { row: state.historyMessageBounds[0].contentStart, col: 0 };
  return state;
}

function page(state: RenderState, entries: Page["entries"], start: number, hasOlder = true) {
  expect(beginOlderHistoryLoad(state, 15)).not.toBeNull();
  state.historyLoadingRequestId = "page";
  handleEvent({
    type: "conversation_history_loaded", convId: state.convId!, reqId: "page",
    entries, historyStartIndex: start, historyEndIndex: state.historyStartIndex,
    historyStartUserIndex: 0, historyTotalEntries: 62, hasOlderHistory: hasOlder,
  }, state, daemon);
}

function cursorText(state: RenderState) {
  return stripAnsi(state.historyLines[state.historyCursor.row]).trim();
}

describe("navigation beyond loaded history", () => {
  test("prompt shortcut materializes a deferred suffix and focuses its target", () => {
    const state = setup();
    const full = buildMessageLines(state, 80);
    const suffixStart = full.messageBounds[1].contentStart + 20;
    state.historyLines = full.lines.slice(suffixStart);
    state.historyLineAnchors = full.lineAnchors.slice(suffixStart);
    state.historyMessageBounds = [];
    state.layout.totalLines = state.historyLines.length;
    state.deferredHistoryRender = {
      convId: state.convId!, width: 80, startMessageIndex: 1, generation: 1, complete: false,
    };
    state.chatFocus = "prompt";
    handleFocusedKey({ type: "char", char: "{" }, state);
    expect(state.chatFocus).toBe("history");
    expect(cursorText(state)).toBe("new prompt");
    expect(state.pendingHistoryNavigation).toBeNull();
    expect(state.deferredHistoryRender).toBeNull();
  });

  test("{ requests history far from the viewport boundary and lands on the older prompt", () => {
    const state = setup();
    state.messages[0] = { role: "user", text: "automated", metadata: automatedMetadata };
    renderHistory(state);
    state.historyCursor = { row: state.historyLines.length - 1, col: 0 };
    expect(shouldLoadOlderHistory(state)).toBe(false);
    applyHistoryAction("history_prev_message", state);
    expect(shouldLoadOlderHistory(state)).toBe(true);
    page(state, [{ type: "user", text: "older human prompt" }], 59);
    expect(cursorText(state)).toBe("older human prompt");
    expect(state.pendingHistoryNavigation).toBeNull();
    expect(state.scrollOffset).toBeGreaterThan(0);
  });

  test("skips entire automated pages and resumes after an already in-flight load", () => {
    const state = setup();
    beginOlderHistoryLoad(state, 15);
    state.historyLoadingRequestId = "page";
    applyHistoryAction("history_prev_message", state);
    expect(state.pendingHistoryNavigation).toBe("history_prev_message");
    handleEvent({
      type: "conversation_history_loaded", convId: state.convId!, reqId: "page",
      entries: [{ type: "user", text: "robot", metadata: automatedMetadata }],
      historyStartIndex: 59, historyEndIndex: 60, historyStartUserIndex: 0,
      historyTotalEntries: 62, hasOlderHistory: true,
    }, state, daemon);
    expect(state.pendingHistoryNavigation).toBe("history_prev_message");
    expect(cursorText(state)).toBe("new prompt");
    page(state, [{ type: "user", text: "human" }], 58);
    expect(cursorText(state)).toBe("human");
  });

  test("[ skips tool-only pages and lands on final assistant text", () => {
    const state = setup();
    applyHistoryAction("history_prev_ai_message", state);
    page(state, [{ type: "ai", blocks: [{ type: "thinking", text: "not a response" }], metadata: null }], 59);
    expect(state.pendingHistoryNavigation).toBe("history_prev_ai_message");
    page(state, [{ type: "ai", blocks: [{ type: "text", text: "older answer" }], metadata: null }], 58);
    expect(cursorText(state)).toBe("older answer");
  });

  test("gg keeps loading until the actual beginning", () => {
    const state = setup();
    applyHistoryAction("history_gg", state);
    page(state, [{ type: "user", text: "middle" }], 30);
    expect(state.pendingHistoryNavigation).toBe("history_gg");
    page(state, [{ type: "user", text: "first" }], 0, false);
    expect(state.historyCursor.row).toBe(0);
    expect(state.pendingHistoryNavigation).toBeNull();
  });

  test("exhausted history and non-progressing pages stop the jump", () => {
    for (const noProgress of [false, true]) {
      const state = setup();
      applyHistoryAction("history_prev_ai_message", state);
      page(state, [], noProgress ? 60 : 0, noProgress);
      expect(state.pendingHistoryNavigation).toBeNull();
    }
  });

  test("new input and request errors cancel pending jumps", () => {
    const state = setup();
    applyHistoryAction("history_prev_message", state);
    handleFocusedKey({ type: "char", char: "l" }, state);
    expect(state.pendingHistoryNavigation).toBeNull();
    applyHistoryAction("history_prev_message", state);
    beginOlderHistoryLoad(state, 15);
    state.historyLoadingRequestId = "page";
    handleEvent({ type: "error", convId: state.convId!, reqId: "page", message: "failed" }, state, daemon);
    expect(state.pendingHistoryNavigation).toBeNull();
    expect(state.historyLoadingOlder).toBe(false);
  });

  test("a page cannot steal focus after leaving history", () => {
    const state = setup();
    applyHistoryAction("history_prev_message", state);
    state.chatFocus = "prompt";
    page(state, [{ type: "user", text: "older prompt" }], 59);
    expect(state.chatFocus).toBe("prompt");
    expect(state.pendingHistoryNavigation).toBeNull();
    expect(cursorText(state)).toBe("new prompt");
  });

  test("visual selection stays anchored to the old message across a jump", () => {
    const state = setup();
    state.vim.mode = "visual";
    state.historyVisualAnchor = { ...state.historyCursor };
    applyHistoryAction("history_prev_message", state);
    page(state, [{ type: "user", text: "older prompt" }], 59);
    expect(cursorText(state)).toBe("older prompt");
    expect(stripAnsi(state.historyLines[state.historyVisualAnchor.row]).trim()).toBe("new prompt");
  });
});
