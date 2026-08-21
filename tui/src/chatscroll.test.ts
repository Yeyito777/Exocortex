import { describe, expect, test } from "bun:test";
import { buildMessageLines } from "./conversation";
import { computeBottomLayout } from "./chatlayout";
import {
  preserveViewportAcrossHistoryMutation,
  preserveViewportAcrossHistoryPrepend,
  preserveViewportAcrossResize,
  getScrollOffsetForViewStart,
  getViewStartFor,
} from "./chatscroll";
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

describe("history replacement scroll preservation", () => {
  test("keeps the same top line when canonical history replaces message identities", () => {
    const state = createInitialState();
    state.cols = 60;
    state.rows = 20;
    state.messages = Array.from({ length: 20 }, (_, i) => ([
      { role: "user" as const, text: `user-${i}`, metadata: null },
      {
        role: "assistant" as const,
        blocks: [{ type: "text" as const, text: `answer-${i}` }],
        metadata: null,
      },
    ])).flat();

    const oldRender = buildMessageLines(state, state.cols);
    const targetRow = oldRender.lines.findIndex(line => stripAnsi(line).includes("user-10"));
    expect(targetRow).toBeGreaterThanOrEqual(0);
    state.layout.totalLines = oldRender.lines.length;
    state.layout.messageAreaHeight = 10;
    state.scrollOffset = getScrollOffsetForViewStart(oldRender.lines.length, 10, targetRow);

    preserveViewportAcrossHistoryMutation(state, () => {
      state.messages = structuredClone(state.messages);
    });

    const newRender = buildMessageLines(state, state.cols);
    const newViewStart = getViewStartFor(newRender.lines.length, 10, state.scrollOffset);
    expect(stripAnsi(newRender.lines[newViewStart])).toContain("user-10");
  });
});

describe("older history prepend scroll preservation", () => {
  test("keeps the oldest existing message at the same screen row below instructions and the loading barrier", () => {
    const state = createInitialState();
    state.cols = 80;
    state.rows = 20;
    state.historyLoadingOlder = true;
    state.historyLoadingStartedAt = 1_000;
    const firstExisting = { role: "user" as const, text: "first-existing", metadata: null };
    state.messages = [
      { role: "system_instructions", text: "Follow the repository rules.", metadata: null },
      firstExisting,
      { role: "assistant", blocks: [{ type: "text", text: "existing answer\nline two\nline three" }], metadata: null },
      { role: "user", text: "newest", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "newest answer\nline two\nline three" }], metadata: null },
    ];

    const oldRender = buildMessageLines(state, state.cols);
    state.layout.totalLines = oldRender.lines.length;
    state.layout.messageAreaHeight = 10;
    state.scrollOffset = getScrollOffsetForViewStart(oldRender.lines.length, 10, 0);
    const oldViewStart = getViewStartFor(oldRender.lines.length, 10, state.scrollOffset);
    const oldMessageRow = oldRender.lineAnchors.findIndex(anchor =>
      anchor.owner === firstExisting && anchor.segment === "user_content"
    );
    const oldScreenRow = oldMessageRow - oldViewStart;
    expect(oldScreenRow).toBeGreaterThan(0);
    expect(oldScreenRow).toBeLessThan(10);

    preserveViewportAcrossHistoryPrepend(state, () => {
      state.historyLoadingOlder = false;
      state.historyLoadingStartedAt = null;
      state.messages = [
        state.messages[0]!,
        { role: "user", text: "newly-loaded", metadata: null },
        { role: "assistant", blocks: [{ type: "text", text: "older answer\nline two\nline three" }], metadata: null },
        ...state.messages.slice(1),
      ];
    });

    const newRender = buildMessageLines(state, state.cols);
    const newViewStart = getViewStartFor(newRender.lines.length, 10, state.scrollOffset);
    const newMessageRow = newRender.lineAnchors.findIndex(anchor =>
      anchor.owner === firstExisting && anchor.segment === "user_content"
    );
    expect(newMessageRow - newViewStart).toBe(oldScreenRow);
    expect(newViewStart).toBeGreaterThan(0);
  });
});
