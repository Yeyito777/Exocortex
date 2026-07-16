import { describe, expect, test } from "bun:test";
import { buildMessageLines } from "./conversation";
import { handleFocusedKey } from "./focus";
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
  state.chatFocus = "history";
  state.vim.mode = "normal";

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

function setupSelectedHistoryText(text: string): RenderState {
  const state = setupRenderedHistory([
    { role: "assistant", blocks: [{ type: "text", text }], metadata: null },
  ], 80);
  state.panelFocus = "chat";
  state.chatFocus = "history";

  const row = state.historyLines.findIndex(line => stripAnsi(line).includes(text));
  const col = stripAnsi(state.historyLines[row] ?? "").indexOf(text);
  if (row < 0 || col < 0) throw new Error("selected test text was not rendered");

  state.historyVisualAnchor = { row, col };
  state.historyCursor = { row, col: col + text.length - 1 };
  return state;
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

  test("{ from prompt normal mode focuses history and navigates user messages", () => {
    const state = setupHistoryState();
    const userBounds = boundsByRole(state, "user");
    state.layout.messageAreaHeight = 3;
    state.historyCursor = { row: 0, col: 0 };
    state.inputBuffer = "draft";
    state.cursorPos = 2;
    state.chatFocus = "prompt";
    state.vim.mode = "normal";

    expect(handleFocusedKey({ type: "char", char: "{" }, state)).toEqual({ type: "handled" });
    expect(state.historyCursor.row).toBe(userBounds[1].contentStart);

    expect(handleFocusedKey({ type: "char", char: "{" }, state)).toEqual({ type: "handled" });
    expect(state.historyCursor.row).toBe(userBounds[0].contentStart);

    expect(handleFocusedKey({ type: "char", char: "}" }, state)).toEqual({ type: "handled" });
    expect(state.historyCursor.row).toBe(userBounds[1].contentStart);
    expect(state.chatFocus).toBe("history");
    expect(state.vim.mode).toBe("normal");
    expect(state.inputBuffer).toBe("draft");
    expect(state.cursorPos).toBe(2);
  });

  test("} from prompt normal mode focuses history at the end when no user message follows", () => {
    const state = setupHistoryState();
    state.layout.messageAreaHeight = 3;
    state.historyCursor = { row: 0, col: 0 };
    state.chatFocus = "prompt";
    state.vim.mode = "normal";

    expect(handleFocusedKey({ type: "char", char: "}" }, state)).toEqual({ type: "handled" });

    expect(state.chatFocus).toBe("history");
    expect(state.historyCursor.row).toBe(state.historyLines.length - 1);
  });
});

describe("history bracket navigation", () => {
  test("[ and ] land on the final assistant text instead of thinking or tool blocks", () => {
    const state = setupRenderedHistory([
      { role: "user", text: "Please inspect this", metadata: null },
      {
        role: "assistant",
        blocks: [
          { type: "thinking", text: "Reasoning before the tool" },
          { type: "text", text: "I'll inspect it." },
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "inspect" },
          { type: "tool_result", toolCallId: "call-1", toolName: "bash", output: "result", isError: false },
          { type: "thinking", text: "Reasoning after the tool" },
          { type: "text", text: "Final assistant response" },
        ],
        metadata: null,
      },
      { role: "user", text: "Follow-up", metadata: null },
    ], 80);
    const userBounds = boundsByRole(state, "user");
    const assistantBound = boundsByRole(state, "assistant")[0];
    const finalResponseRow = state.historyLines.findIndex((line) => stripAnsi(line).includes("Final assistant response"));
    state.chatFocus = "history";
    state.vim.mode = "normal";

    expect(finalResponseRow).toBeGreaterThan(assistantBound.contentStart);

    state.historyCursor = { row: userBounds[0].contentStart, col: 0 };
    applyHistoryAction("history_next_ai_message", state);
    expect(state.historyCursor.row).toBe(finalResponseRow);

    state.historyCursor = { row: userBounds[1].contentStart, col: 0 };
    applyHistoryAction("history_prev_ai_message", state);
    expect(state.historyCursor.row).toBe(finalResponseRow);
  });

  test("AI navigation skips assistant messages that have no response text", () => {
    const state = setupRenderedHistory([
      { role: "user", text: "Start", metadata: null },
      {
        role: "assistant",
        blocks: [
          { type: "thinking", text: "Tool-only reasoning" },
          { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: {}, summary: "inspect" },
        ],
        metadata: null,
      },
      { role: "user", text: "Continue", metadata: null },
      {
        role: "assistant",
        blocks: [{ type: "text", text: "Actual response" }],
        metadata: null,
      },
    ], 80);
    const firstUser = boundsByRole(state, "user")[0];
    const actualResponseRow = state.historyLines.findIndex((line) => stripAnsi(line).includes("Actual response"));
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.historyCursor = { row: firstUser.contentStart, col: 0 };

    applyHistoryAction("history_next_ai_message", state);

    expect(state.historyCursor.row).toBe(actualResponseRow);
  });

  test("] jumps to the next AI-response text, skipping user messages", () => {
    const state = setupHistoryState();
    const aiBounds = boundsByRole(state, "assistant");

    state.historyCursor = { row: aiBounds[0].contentStart, col: 0 };
    applyHistoryAction("history_next_ai_message", state);

    expect(state.historyCursor.row).toBe(aiBounds[1].contentStart);
  });

  test("[ jumps to the previous AI-response text", () => {
    const state = setupHistoryState();
    const firstAI = boundsByRole(state, "assistant")[0];
    const secondUser = boundsByRole(state, "user")[1];

    state.historyCursor = { row: secondUser.contentStart, col: 0 };
    applyHistoryAction("history_prev_ai_message", state);

    expect(state.historyCursor.row).toBe(firstAI.contentStart);
  });

  test("] jumps to the conversation end when there is no later AI response", () => {
    const state = setupHistoryState();
    const lastAI = boundsByRole(state, "assistant").at(-1)!;
    state.historyLines.push("trailing line after the final AI bound");
    state.layout.totalLines = state.historyLines.length;
    state.layout.messageAreaHeight = state.historyLines.length;
    state.historyCursor = { row: lastAI.contentStart, col: 0 };

    applyHistoryAction("history_next_ai_message", state);

    expect(state.historyCursor.row).toBe(state.historyLines.length - 1);
  });

  test("[ from prompt normal mode focuses history and navigates AI messages", () => {
    const state = setupHistoryState();
    const aiBounds = boundsByRole(state, "assistant");
    state.layout.messageAreaHeight = 3;
    state.historyCursor = { row: 0, col: 0 };
    state.inputBuffer = "draft";
    state.cursorPos = 2;
    state.chatFocus = "prompt";
    state.vim.mode = "normal";

    expect(handleFocusedKey({ type: "char", char: "[" }, state)).toEqual({ type: "handled" });
    expect(state.historyCursor.row).toBe(aiBounds[1].contentStart);

    expect(handleFocusedKey({ type: "char", char: "[" }, state)).toEqual({ type: "handled" });
    expect(state.historyCursor.row).toBe(aiBounds[0].contentStart);

    expect(handleFocusedKey({ type: "char", char: "]" }, state)).toEqual({ type: "handled" });
    expect(state.historyCursor.row).toBe(aiBounds[1].contentStart);
    expect(state.chatFocus).toBe("history");
    expect(state.vim.mode).toBe("normal");
    expect(state.inputBuffer).toBe("draft");
    expect(state.cursorPos).toBe(2);
  });

  test("] from prompt normal mode focuses history at the conversation end", () => {
    const state = setupHistoryState();
    state.layout.messageAreaHeight = 3;
    state.historyCursor = { row: 0, col: 0 };
    state.chatFocus = "prompt";
    state.vim.mode = "normal";

    expect(handleFocusedKey({ type: "char", char: "]" }, state)).toEqual({ type: "handled" });

    expect(state.chatFocus).toBe("history");
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

describe("appending a history selection to the prompt", () => {
  test("visual ; appends a triple-quote block to an empty prompt", () => {
    const state = setupSelectedHistoryText("alpha beta");
    state.vim.lastFind = { char: "a", direction: "f" };

    expect(handleFocusedKey({ type: "char", char: ";" }, state)).toEqual({ type: "handled" });

    expect(state.inputBuffer).toBe(`"""\nalpha beta\n"""\n`);
    expect(state.cursorPos).toBe(state.inputBuffer.length);
    expect(state.chatFocus).toBe("prompt");
    expect(state.vim.mode).toBe("insert");
  });

  test("adds a leading newline when the prompt's last line is not empty", () => {
    const state = setupSelectedHistoryText("alpha beta");
    state.inputBuffer = "Compare this";
    state.cursorPos = 3;

    expect(handleFocusedKey({ type: "char", char: ";" }, state)).toEqual({ type: "handled" });

    expect(state.inputBuffer).toBe(`Compare this\n"""\nalpha beta\n"""\n`);
    expect(state.cursorPos).toBe(state.inputBuffer.length);
    expect(state.chatFocus).toBe("prompt");
    expect(state.vim.mode).toBe("insert");

    // Continue typing on the empty line after the closing delimiter. Undo
    // should remove that new insert session first, then the quote block,
    // without skipping back past the pre-existing draft.
    for (const char of "explain") {
      expect(handleFocusedKey({ type: "char", char }, state)).toEqual({ type: "handled" });
    }
    expect(handleFocusedKey({ type: "escape" }, state)).toEqual({ type: "handled" });
    expect(handleFocusedKey({ type: "char", char: "u" }, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe(`Compare this\n"""\nalpha beta\n"""\n`);
    expect(handleFocusedKey({ type: "char", char: "u" }, state)).toEqual({ type: "handled" });
    expect(state.inputBuffer).toBe("Compare this");
    expect(state.cursorPos).toBe(3);
  });

  test("does not add another newline when already on an empty prompt line", () => {
    const state = setupSelectedHistoryText("alpha beta");
    state.inputBuffer = "Compare this\n";
    state.cursorPos = state.inputBuffer.length;

    expect(handleFocusedKey({ type: "char", char: ";" }, state)).toEqual({ type: "handled" });

    expect(state.inputBuffer).toBe(`Compare this\n"""\nalpha beta\n"""\n`);
  });

  test("works for visual-line selections", () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "history";
    state.vim.mode = "visual-line";
    state.historyLines = ["alpha", "beta"];
    state.historyWrapContinuation = [false, false];
    state.historyWrapJoiners = ["", ""];
    state.historyVisualAnchor = { row: 0, col: 0 };
    state.historyCursor = { row: 1, col: 0 };
    state.layout.totalLines = 2;
    state.layout.messageAreaHeight = 2;

    expect(handleFocusedKey({ type: "char", char: ";" }, state)).toEqual({ type: "handled" });

    expect(state.inputBuffer).toBe(`"""\nalpha\nbeta\n"""\n`);
    expect(state.chatFocus as string).toBe("prompt");
    expect(state.vim.mode as string).toBe("insert");
  });

  test("preserves a selected emoji as a complete grapheme", () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "history";
    state.vim.mode = "visual";
    state.historyLines = ["😀"];
    state.historyWrapContinuation = [false];
    state.historyWrapJoiners = [""];
    state.historyVisualAnchor = { row: 0, col: 0 };
    state.historyCursor = { row: 0, col: 0 };
    state.layout.totalLines = 1;
    state.layout.messageAreaHeight = 1;

    expect(handleFocusedKey({ type: "char", char: ";" }, state)).toEqual({ type: "handled" });

    expect(state.inputBuffer).toBe(`"""\n😀\n"""\n`);
    expect(state.chatFocus as string).toBe("prompt");
    expect(state.vim.mode as string).toBe("insert");
  });

  test("normal-mode ; still repeats the last history find", () => {
    const state = createInitialState();
    state.panelFocus = "chat";
    state.chatFocus = "history";
    state.vim.mode = "normal";
    state.vim.lastFind = { char: "p", direction: "f" };
    state.historyLines = ["alpha"];
    state.historyCursor = { row: 0, col: 0 };
    state.layout.totalLines = 1;
    state.layout.messageAreaHeight = 1;

    expect(handleFocusedKey({ type: "char", char: ";" }, state)).toEqual({ type: "handled" });

    expect(state.historyCursor).toEqual({ row: 0, col: 2 });
    expect(state.inputBuffer).toBe("");
  });
});
