import { describe, expect, test } from "bun:test";
import { createPendingAI } from "./messages";
import { render, invalidateHistoryRenderCache } from "./render";
import { createInitialState, type RenderState } from "./state";

function renderSilently(state: RenderState): void {
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    render(state);
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function makeState(): RenderState {
  const state = createInitialState();
  state.cols = 120;
  state.rows = 40;
  state.messages = [
    { role: "user", text: "hello", metadata: null },
    {
      role: "assistant",
      blocks: [{ type: "text", text: "# Heading\n\nSome **markdown** content that wraps across lines." }],
      metadata: null,
    },
  ];
  return state;
}

describe("render history caching", () => {
  test("reuses cached history lines when only the prompt changes", () => {
    const state = makeState();

    renderSilently(state);
    const firstLines = state.historyLines;
    const firstBounds = state.historyMessageBounds;

    state.inputBuffer = "/help";
    state.cursorPos = state.inputBuffer.length;
    renderSilently(state);

    expect(state.historyLines).toBe(firstLines);
    expect(state.historyMessageBounds).toBe(firstBounds);
  });

  test("does not reuse the static history cache while streaming", () => {
    const state = makeState();
    state.pendingAI = createPendingAI(Date.now(), state.model);
    state.pendingAI.blocks.push({ type: "text", text: "partial reply" });

    renderSilently(state);
    const firstLines = state.historyLines;

    state.inputBuffer = "typed while streaming";
    state.cursorPos = state.inputBuffer.length;
    renderSilently(state);

    expect(state.historyLines).not.toBe(firstLines);
  });

  test("manual invalidation rebuilds cached history after in-place message edits", () => {
    const state = makeState();

    renderSilently(state);
    const firstLines = state.historyLines;

    const assistant = state.messages[1];
    if (assistant.role !== "assistant") throw new Error("expected assistant message");
    assistant.blocks[0] = { type: "text", text: "updated body" };
    invalidateHistoryRenderCache(state);
    renderSilently(state);

    expect(state.historyLines).not.toBe(firstLines);
    expect(stripAnsi(state.historyLines.join("\n"))).toContain("updated body");
  });
});
