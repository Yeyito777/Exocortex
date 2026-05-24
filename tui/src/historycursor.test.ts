import { describe, expect, test } from "bun:test";
import { buildMessageLines } from "./conversation";
import { applyHistoryAction, contentBounds, getHistoryVisualSelection, joinLogicalLines, stripAnsi } from "./historycursor";
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

  const { lines, wrapContinuation, wrapJoiners, copyLines, messageBounds, lineAnchors } = buildMessageLines(state, 24);
  state.historyLines = lines;
  state.historyWrapContinuation = wrapContinuation;
  state.historyWrapJoiners = wrapJoiners;
  state.historyCopyLines = copyLines;
  state.historyMessageBounds = messageBounds;
  state.historyLineAnchors = lineAnchors;
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

  const { lines, wrapContinuation, wrapJoiners, copyLines, messageBounds, lineAnchors } = buildMessageLines(state, width);
  state.historyLines = lines;
  state.historyWrapContinuation = wrapContinuation;
  state.historyWrapJoiners = wrapJoiners;
  state.historyCopyLines = copyLines;
  state.historyMessageBounds = messageBounds;
  state.historyLineAnchors = lineAnchors;
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

describe("history curswant", () => {
  test("j/k preserve preferred column across short lines", () => {
    const state = createInitialState();
    state.historyLines = ["abcdef", "x", "123456789"];
    state.layout.totalLines = state.historyLines.length;
    state.layout.messageAreaHeight = state.historyLines.length;
    state.historyCursor = { row: 0, col: 5 };

    applyHistoryAction("history_down", state);
    expect(state.historyCursor).toEqual({ row: 1, col: 0 });

    applyHistoryAction("history_down", state);
    expect(state.historyCursor).toEqual({ row: 2, col: 5 });
    expect(state.historyCurswant).toBe(5);
  });

  test("non-vertical history motion resets the preferred column", () => {
    const state = createInitialState();
    state.historyLines = ["abcdef", "x", "123456789"];
    state.layout.totalLines = state.historyLines.length;
    state.layout.messageAreaHeight = state.historyLines.length;
    state.historyCursor = { row: 0, col: 5 };

    applyHistoryAction("history_down", state);
    applyHistoryAction("history_down", state);
    expect(state.historyCursor).toEqual({ row: 2, col: 5 });

    applyHistoryAction("history_left", state);
    expect(state.historyCursor).toEqual({ row: 2, col: 4 });
    expect(state.historyCurswant).toBeNull();

    applyHistoryAction("history_up", state);
    expect(state.historyCursor).toEqual({ row: 1, col: 0 });
    applyHistoryAction("history_down", state);
    expect(state.historyCursor).toEqual({ row: 2, col: 4 });
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

  test("hard-wrapped tool result paths rejoin without synthetic spaces", () => {
    const path = "/home/yeyito/Workspace/Exocortex/.worktrees/image-generation-tool/config/data/instances/image-generation-tool/generated-images/example.png";
    const state = createInitialState();
    state.showToolOutput = true;
    state.messages = [{
      role: "assistant",
      blocks: [{ type: "tool_result", toolCallId: "call-1", toolName: "generate_image", output: `Saved:\n${path}`, isError: false }],
      metadata: null,
    }];

    const { lines, wrapContinuation, wrapJoiners } = buildMessageLines(state, 90);
    const firstPathRow = lines.findIndex((line) => stripAnsi(line).includes("/home/yeyito/Workspace/Exocortex/.worktrees"));
    expect(firstPathRow).toBeGreaterThanOrEqual(0);

    let lastPathRow = firstPathRow;
    while (lastPathRow + 1 < lines.length && wrapContinuation[lastPathRow + 1]) lastPathRow++;

    expect(joinLogicalLines(lines, wrapContinuation, firstPathRow, lastPathRow, wrapJoiners)).toBe(path);
  });

  test("visual-line yank from fenced markdown code omits gutter and language label", () => {
    const state = setupRenderedHistory([
      { role: "assistant", blocks: [{ type: "text", text: "```bash\necho one\necho two\n```" }], metadata: null },
    ], 40);

    state.vim.mode = "visual-line";
    state.historyVisualAnchor = { row: 0, col: contentBounds(stripAnsi(state.historyLines[0])).start };
    state.historyCursor = { row: 2, col: contentBounds(stripAnsi(state.historyLines[2])).end };

    expect(state.historyLines.map(stripAnsi).join("\n")).toBe("  ▎ bash\n  ▎ echo one\n  ▎ echo two");
    expect(getHistoryVisualSelection(state)).toBe("echo one\necho two");
  });

  test("charwise yank from fenced markdown code maps rendered columns to code text", () => {
    const state = setupRenderedHistory([
      { role: "assistant", blocks: [{ type: "text", text: "```ts\n  const answer = 42;\n```" }], metadata: null },
    ], 40);

    state.vim.mode = "visual";
    const row = 1;
    const display = stripAnsi(state.historyLines[row]);
    const start = display.indexOf("const");
    state.historyVisualAnchor = { row, col: start };
    state.historyCursor = { row, col: start + "const answer".length - 1 };

    expect(getHistoryVisualSelection(state)).toBe("const answer");
  });
});
