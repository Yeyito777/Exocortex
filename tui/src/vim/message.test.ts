import { describe, expect, test } from "bun:test";

import { buildMessageLines } from "../conversation";
import { getHistoryVisualSelection } from "../historycursor";
import { createInitialState } from "../state";
import type { RenderState } from "../state";
import { handleMessageTextObject } from "./message";

function setupAssistantHistory(): RenderState {
  const state = createInitialState();
  state.chatFocus = "history";
  state.messages = [{
    role: "assistant",
    blocks: [
      { type: "text", text: "Earlier assistant text" },
      { type: "tool_call", toolCallId: "tool-1", toolName: "bash", input: {}, summary: "$ echo tool" },
      { type: "text", text: "Final assistant answer" },
    ],
    metadata: null,
  }];

  const render = buildMessageLines(state, 80);
  state.historyLines = render.lines;
  state.historyWrapContinuation = render.wrapContinuation;
  state.historyWrapJoiners = render.wrapJoiners;
  state.historyMessageBounds = render.messageBounds;
  state.historyLineAnchors = render.lineAnchors;
  state.layout.totalLines = render.lines.length;
  state.layout.messageAreaHeight = render.lines.length;
  state.historyCursor = { row: 0, col: 0 };
  state.vim.mode = "visual";
  state.historyVisualAnchor = { row: 0, col: 0 };
  return state;
}

function selectMessageObject(state: RenderState, key: "m" | "M"): void {
  state.vim.pendingTextObjectModifier = "i";
  const result = handleMessageTextObject({ type: "char", char: key }, state, "history");
  expect(result).toEqual({ type: "handled" });
}

describe("message text object", () => {
  test("m selects only the final assistant text", () => {
    const state = setupAssistantHistory();

    selectMessageObject(state, "m");

    const selection = getHistoryVisualSelection(state);
    expect(selection).toBe("Final assistant answer");
    expect(selection).not.toContain("Earlier assistant text");
    expect(selection).not.toContain("echo tool");
  });

  test("M selects the whole assistant message", () => {
    const state = setupAssistantHistory();

    selectMessageObject(state, "M");

    const selection = getHistoryVisualSelection(state);
    expect(selection).toContain("Earlier assistant text");
    expect(selection).toContain("bash");
    expect(selection).toContain("echo tool");
    expect(selection).toContain("Final assistant answer");
  });
});
