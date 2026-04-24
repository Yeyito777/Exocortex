import { describe, expect, test } from "bun:test";
import { createPendingAI } from "./messages";
import { render, invalidateHistoryRenderCache } from "./render";
import { createInitialState, type RenderState } from "./state";

function captureRenderOutput(state: RenderState): string {
  let out = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    render(state);
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
  return out;
}

function renderSilently(state: RenderState): void {
  void captureRenderOutput(state);
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

describe("render caching and frame diffing", () => {
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

  test("prompt typing flushes only the changed bottom row instead of the whole screen", () => {
    const state = makeState();
    captureRenderOutput(state); // prime previous-frame cache

    state.inputBuffer = "typed";
    state.cursorPos = state.inputBuffer.length;
    const out = captureRenderOutput(state);

    const clearCount = (out.match(/\x1b\[2K/g) || []).length;
    const col1Rows = Array.from(out.matchAll(/\x1b\[(\d+);1H/g), (match) => Number(match[1]));

    expect(clearCount).toBe(1);
    expect(new Set(col1Rows)).toEqual(new Set([37]));
  });

  test("unchanged frames emit no redraw bytes", () => {
    const state = makeState();
    captureRenderOutput(state); // initial full frame

    const out = captureRenderOutput(state);

    expect(out).toBe("");
  });

  test("streaming viewport shifts use a scroll region instead of redrawing the full message area", () => {
    const state = createInitialState();
    state.cols = 80;
    state.rows = 20;
    state.pendingAI = createPendingAI(Date.now(), state.model);
    state.pendingAI.blocks.push({
      type: "text",
      text: ("Initial streaming text with enough words to wrap across terminal columns. ").repeat(40),
    });
    captureRenderOutput(state); // prime previous-frame cache with an overflowing viewport

    (state.pendingAI.blocks[0] as { type: "text"; text: string }).text += (
      " More streaming text appended at the bottom of the same paragraph. "
    ).repeat(3);
    const out = captureRenderOutput(state);

    const clearCount = (out.match(/\x1b\[2K/g) || []).length;
    expect(out).toMatch(/\x1b\[3;\d+r/);
    expect(clearCount).toBeLessThan(state.layout.messageAreaHeight);
  });
});
