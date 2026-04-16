import { describe, expect, test } from "bun:test";
import { buildMessageLines } from "./conversation";
import { computeBottomLayout } from "./chatlayout";
import { preserveViewportAcrossResize, getScrollOffsetForViewStart, getViewStartFor } from "./chatscroll";
import { stripAnsi } from "./historycursor";
import { createInitialState } from "./state";
import type { RenderState } from "./state";

function lineLabel(line: string): string | null {
  return stripAnsi(line).match(/L\d+/)?.[0] ?? null;
}

function buildWrappedState(cols: number, rows: number): RenderState {
  const state = createInitialState();
  state.cols = cols;
  state.rows = rows;
  state.messages = [{
    role: "assistant",
    blocks: [{
      type: "text",
      text: Array.from({ length: 40 }, (_, i) =>
        `L${String(i).padStart(2, "0")} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda`,
      ).join("\n"),
    }],
    metadata: null,
  }] as any;

  const render = buildMessageLines(state, cols);
  state.historyLines = render.lines;
  state.historyWrapContinuation = render.wrapContinuation;
  state.historyMessageBounds = render.messageBounds;
  state.layout.totalLines = render.lines.length;
  state.layout.messageAreaHeight = computeBottomLayout(state, cols, rows).messageAreaHeight;
  return state;
}

function firstRowForLabel(lines: string[], label: string): number {
  const row = lines.findIndex(line => lineLabel(line) === label);
  if (row === -1) throw new Error(`label not found: ${label}`);
  return row;
}

describe("resize scroll preservation", () => {
  test("width changes keep the same top logical line visible when scrolled up", () => {
    const state = buildWrappedState(28, 20);
    const oldRender = buildMessageLines(state, state.cols);
    const targetRow = firstRowForLabel(oldRender.lines, "L18");
    state.scrollOffset = getScrollOffsetForViewStart(
      oldRender.lines.length,
      state.layout.messageAreaHeight,
      targetRow,
    );

    preserveViewportAcrossResize(state, 44, 20);

    const newRender = buildMessageLines(state, state.cols);
    const newViewStart = getViewStartFor(
      newRender.lines.length,
      state.layout.messageAreaHeight,
      state.scrollOffset,
    );

    expect(lineLabel(newRender.lines[newViewStart])).toBe("L18");
  });

  test("height changes keep the same top logical line visible when scrolled up", () => {
    const state = buildWrappedState(28, 22);
    const oldRender = buildMessageLines(state, state.cols);
    const targetRow = firstRowForLabel(oldRender.lines, "L12");
    state.scrollOffset = getScrollOffsetForViewStart(
      oldRender.lines.length,
      state.layout.messageAreaHeight,
      targetRow,
    );

    preserveViewportAcrossResize(state, 28, 16);

    const newRender = buildMessageLines(state, state.cols);
    const newViewStart = getViewStartFor(
      newRender.lines.length,
      state.layout.messageAreaHeight,
      state.scrollOffset,
    );

    expect(lineLabel(newRender.lines[newViewStart])).toBe("L12");
  });

  test("pinned-bottom scroll stays pinned on resize", () => {
    const state = buildWrappedState(28, 20);
    state.scrollOffset = 0;

    preserveViewportAcrossResize(state, 44, 16);

    expect(state.scrollOffset).toBe(0);
  });
});
