import { describe, expect, test } from "bun:test";
import { buildMessageLines } from "./conversation";
import { applyHistoryAction, contentBounds, getHistoryVisualSelection, stripAnsi } from "./historycursor";
import { createInitialState } from "./state";
import type { RenderState } from "./state";

function setupHistoryState(): RenderState {
  const state = createInitialState();
  state.messages = [
    {
      role: "user",
      text: "First user message that wraps a bit",
      metadata: null,
    },
    {
      role: "assistant",
      blocks: [{ type: "text", text: "Assistant reply" }],
      metadata: null,
    },
    {
      role: "user",
      text: "Second user message that also wraps",
      metadata: null,
    },
    {
      role: "assistant",
      blocks: [{ type: "text", text: "Final assistant reply" }],
      metadata: null,
    },
  ];

  const { lines, wrapContinuation, messageBounds } = buildMessageLines(state, 24);
  state.historyLines = lines;
  state.historyWrapContinuation = wrapContinuation;
  state.historyMessageBounds = messageBounds;
  state.layout.totalLines = lines.length;
  state.layout.messageAreaHeight = lines.length;

  return state;
}

function boundsByRole(state: RenderState, role: RenderState["historyMessageBounds"][number]["role"]) {
  return state.historyMessageBounds.filter((bound) => bound.role === role);
}

function setupRenderedHistory(messages: any[], width: number): RenderState {
  const state = createInitialState();
  state.messages = messages;

  const { lines, wrapContinuation, messageBounds } = buildMessageLines(state, width);
  state.historyLines = lines;
  state.historyWrapContinuation = wrapContinuation;
  state.historyMessageBounds = messageBounds;
  state.layout.totalLines = lines.length;
  state.layout.messageAreaHeight = lines.length;
  state.vim.mode = "visual";

  return state;
}

function selectFirstWrappedBoundary(state: RenderState): void {
  const firstStart = contentBounds(stripAnsi(state.historyLines[0])).start;
  const secondStart = contentBounds(stripAnsi(state.historyLines[1])).start;
  state.historyVisualAnchor = { row: 0, col: firstStart };
  state.historyCursor = { row: 1, col: secondStart + 1 };
}

describe("history brace navigation", () => {
  test("} jumps to the next user-message start, skipping assistant messages", () => {
    const state = setupHistoryState();
    const assistantBound = boundsByRole(state, "assistant")[0];
    const secondUserBound = boundsByRole(state, "user")[1];

    expect(assistantBound).toBeDefined();
    expect(secondUserBound).toBeDefined();

    state.historyCursor = { row: assistantBound!.contentStart, col: 0 };
    applyHistoryAction("history_next_message", state);

    expect(state.historyCursor.row).toBe(secondUserBound!.contentStart);
  });

  test("{ jumps to the current/previous user-message start, skipping assistant messages", () => {
    const state = setupHistoryState();
    const userBounds = boundsByRole(state, "user");
    const trailingAssistant = state.historyMessageBounds.at(-1);

    expect(userBounds).toHaveLength(2);
    expect(trailingAssistant?.role).toBe("assistant");

    state.historyCursor = { row: trailingAssistant!.contentStart, col: 0 };
    applyHistoryAction("history_prev_message", state);

    expect(state.historyCursor.row).toBe(userBounds[1].contentStart);
  });

  test("} from inside the last user message jumps to the bottom of the conversation", () => {
    const state = setupHistoryState();
    const lastUserBound = boundsByRole(state, "user").at(-1);

    expect(lastUserBound).toBeDefined();

    state.historyCursor = { row: lastUserBound!.contentEnd - 1, col: 0 };
    applyHistoryAction("history_next_message", state);

    expect(state.historyCursor.row).toBe(state.historyLines.length - 1);
  });
});

describe("history visual selection", () => {
  test("charwise visual selection across wrapped user rows preserves soft wrap", () => {
    const state = setupRenderedHistory([
      { role: "user", text: "alpha beta gamma delta epsilon zeta", metadata: null },
    ], 18);

    selectFirstWrappedBoundary(state);

    expect(getHistoryVisualSelection(state)).toBe("alpha beta ga");
  });

  test("assistant markdown wraps mark continuation rows for yanking", () => {
    const state = setupRenderedHistory([
      { role: "assistant", blocks: [{ type: "text", text: "alpha beta gamma delta epsilon zeta" }], metadata: null },
    ], 18);

    expect(state.historyWrapContinuation).toEqual([false, true, true]);

    selectFirstWrappedBoundary(state);

    expect(getHistoryVisualSelection(state)).toBe("alpha beta ga");
  });
});
