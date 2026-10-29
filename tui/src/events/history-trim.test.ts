import { describe, expect, test } from "bun:test";
import { buildMessageLines } from "../conversation";
import type { Block, Message } from "../messages";
import { createInitialState, type RenderState } from "../state";
import { planHistoryTrimAboveView, restoreHistoryAboveView, trimHistoryAboveView } from "./history-trim";

/** A tool-heavy turn's blocks; `elidedAs` gives them a folded page's form (work left out). */
function turn(rounds: number, elidedAs?: number): Block[] {
  const blocks: Block[] = [];
  for (let round = 0; round < rounds; round++) {
    blocks.push(
      { type: "thinking", text: `Plan ${round}` },
      { type: "tool_call", toolCallId: `call-${elidedAs}-${round}`, toolName: "bash", input: { command: `echo ${round}` }, summary: `echo ${round}` },
      { type: "tool_result", toolCallId: `call-${elidedAs}-${round}`, toolName: "bash", output: "", isError: false },
    );
  }
  blocks.push({ type: "text", text: "Done." });
  if (elidedAs === undefined) return blocks;
  return blocks.map((block, index): Block => {
    if (block.type === "tool_call") return { ...block, input: {}, summary: "", elided: { entry: elidedAs, block: index } };
    if (block.type === "thinking") return { type: "thinking", text: "", elided: { entry: elidedAs, block: index } };
    return block;
  });
}

/** Three turns of 200 rounds, folded; laid out at the bottom (or `scrollOffset` up). */
function foldedHistory(elided = true): RenderState {
  const state = createInitialState();
  state.convId = "conv-1";
  state.cols = 80;
  state.rows = 30;
  state.showTurnWork = false;
  for (let index = 0; index < 3; index++) {
    state.messages.push(
      { role: "user", text: `Prompt ${index}`, metadata: null },
      { role: "assistant", blocks: turn(200, elided ? index * 2 + 1 : undefined), metadata: null },
    );
  }
  layOut(state);
  return state;
}

function layOut(state: RenderState): void {
  const rendered = buildMessageLines(state, state.cols);
  state.historyLines = rendered.lines;
  state.historyLineAnchors = rendered.lineAnchors;
  state.layout.totalLines = rendered.lines.length;
  state.layout.messageAreaHeight = 20;
}

const windowOf = (state: RenderState) => ({
  messages: state.messages.map(message => message.role === "assistant" ? { ...message, blocks: [...message.blocks] } : message),
  start: [state.historyStartIndex, state.historyStartBlockIndex, state.historyStartUserIndex, state.historyHasOlder],
});

describe("trimming the history above the view and putting it back", () => {
  test("folding again restores the very window the unfold cut, the turn it cut inside joined again", () => {
    const state = foldedHistory();
    const before = windowOf(state);
    trimHistoryAboveView(state);
    expect(state.messages).toHaveLength(1);
    expect(state.historyStartIndex).toBe(5);
    expect(state.historyStartBlockIndex).toBeGreaterThan(0);
    expect(state.historyHasOlder).toBe(true);
    state.showTurnWork = true;
    restoreHistoryAboveView(state);
    // Still unfolded: nothing comes back yet.
    expect(state.messages).toHaveLength(1);
    state.showTurnWork = false;
    restoreHistoryAboveView(state);
    expect(windowOf(state)).toEqual(before);
    expect(state.historyTrimmedAboveView).toBeNull();
  });

  test("a second cut further down (Ctrl+I from the Ctrl+O view) restores both", () => {
    const state = foldedHistory();
    const before = windowOf(state);
    // First cut scrolled up into the middle turn, then one at the bottom.
    state.scrollOffset = Math.floor(state.layout.totalLines / 2);
    trimHistoryAboveView(state);
    const first = state.historyStartIndex;
    expect(first).toBeLessThan(5);
    layOut(state);
    state.scrollOffset = 0;
    trimHistoryAboveView(state);
    expect(state.historyStartIndex).toBe(5);
    restoreHistoryAboveView(state);
    expect(windowOf(state)).toEqual(before);
  });

  test("history above with no elided work is kept whole: there is nothing to save", () => {
    const state = foldedHistory(false);
    expect(planHistoryTrimAboveView(state)).toBeNull();
    trimHistoryAboveView(state);
    expect(state.messages).toHaveLength(6);
    expect(state.historyTrimmedAboveView).toBeNull();
  });

  test("once the window's start moved (older pages came in), the cut history is not put back", () => {
    const state = foldedHistory();
    trimHistoryAboveView(state);
    const paged: Message = { role: "user", text: "Prompt 2", metadata: null };
    state.messages.unshift(paged);
    state.historyStartIndex = 4;
    state.historyStartBlockIndex = 0;
    restoreHistoryAboveView(state);
    expect(state.messages[0]).toBe(paged);
    expect(state.messages).toHaveLength(2);
    expect(state.historyTrimmedAboveView).toBeNull();
  });
});
