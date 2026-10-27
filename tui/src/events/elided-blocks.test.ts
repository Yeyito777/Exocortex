import { describe, expect, test } from "bun:test";
import { handleFocusedKey } from "../focus";
import { handleEvent } from "../events";
import { jumpToSearchMatch } from "../search";
import { buildMessageLines } from "../conversation";
import { createInitialState, type RenderState } from "../state";
import type { Block } from "../messages";
import type { DaemonActions } from "./types";
import { elidedBlockRanges, hasElidedBlocks, requestElidedBlocksIfNeeded } from "./elided-blocks";

const ENTRY = 4;

/** The full blocks of a tool-heavy turn, as the daemon stores them. */
function fullBlocks(rounds: number): Block[] {
  const blocks: Block[] = [];
  for (let round = 0; round < rounds; round++) {
    blocks.push(
      { type: "thinking", text: `Plan ${round}` },
      { type: "tool_call", toolCallId: `call-${round}`, toolName: "bash", input: { command: `echo needle-${round}` }, summary: `echo needle-${round}` },
      { type: "tool_result", toolCallId: `call-${round}`, toolName: "bash", output: "", isError: false },
    );
  }
  blocks.push({ type: "text", text: "Done." });
  return blocks;
}

/** The same turn as a folded page sends it (daemon elideFoldedWork). */
function elidedBlocks(rounds: number): Block[] {
  const full = fullBlocks(rounds);
  const lastCall = full.findLastIndex(block => block.type === "tool_call");
  return full.map((block, index): Block => {
    if (index >= lastCall) return block;
    if (block.type === "tool_call") return { type: "tool_call", toolCallId: block.toolCallId, toolName: block.toolName, input: {}, summary: "", elided: { entry: ENTRY, block: index } };
    if (block.type === "thinking") return { type: "thinking", text: "", elided: { entry: ENTRY, block: index } };
    return block;
  });
}

function foldedState(rounds = 3): RenderState {
  const state = createInitialState();
  state.convId = "conv-1";
  state.cols = 80;
  state.rows = 30;
  state.showTurnWork = false;
  state.messages.push(
    { role: "user", text: "Do it.", metadata: null },
    { role: "assistant", blocks: elidedBlocks(rounds), metadata: null },
  );
  const rendered = buildMessageLines(state, state.cols);
  state.historyLines = rendered.lines;
  state.historyLineAnchors = rendered.lineAnchors;
  state.layout.totalLines = rendered.lines.length;
  state.layout.messageAreaHeight = 20;
  return state;
}

function fakeDaemon() {
  const requests: Array<Array<{ entry: number; start: number; end: number }>> = [];
  const daemon = {
    loadDisplayBlocks: (_convId: string, ranges: Array<{ entry: number; start: number; end: number }>) => {
      requests.push(ranges);
      return `blocks-${requests.length}`;
    },
    loadToolOutputs: () => "outputs",
  };
  return { daemon: daemon as unknown as DaemonActions, requests };
}

function answer(state: RenderState, daemon: DaemonActions, reqId: string, ranges: Array<{ entry: number; start: number; end: number }>, options: { truncated?: boolean; limit?: number; rounds?: number } = {}) {
  const full = fullBlocks(options.rounds ?? 3);
  let left = options.limit ?? Number.POSITIVE_INFINITY;
  const loaded = ranges.map(range => {
    const blocks = full.slice(range.start, Math.min(range.end, range.start + left));
    left -= blocks.length;
    return { entry: range.entry, start: range.start, blocks };
  }).filter(range => range.blocks.length > 0);
  handleEvent({ type: "display_blocks_loaded", reqId, convId: "conv-1", ranges: loaded, ...(options.truncated ? { truncated: true } : {}) }, state, daemon);
}

describe("elided history blocks", () => {
  test("asks for one range per entry, from its first elided block to its last", () => {
    const state = foldedState();
    expect(hasElidedBlocks(state)).toBe(true);
    // Rounds 0 and 1 (thinking + call), and round 2's thinking; its call is the newest step.
    expect(elidedBlockRanges(state)).toEqual([{ entry: ENTRY, start: 0, end: 7 }]);
  });

  test("folded, nothing is fetched until the work is shown", () => {
    const state = foldedState();
    const { daemon, requests } = fakeDaemon();
    requestElidedBlocksIfNeeded(state, daemon);
    expect(requests).toEqual([]);
  });

  test("Ctrl+O shows the work once its content is in, with the blocks it stood for", () => {
    const state = foldedState();
    const { daemon, requests } = fakeDaemon();
    const pageBlocks = (state.messages[1] as { blocks: Block[] }).blocks;

    expect(handleFocusedKey({ type: "ctrl-o" }, state)).toEqual({ type: "handled" });
    expect(state.showTurnWork).toBe(false);
    expect(state.unfoldAfterElidedLoad).toBe("turn_work");

    requestElidedBlocksIfNeeded(state, daemon);
    expect(requests).toHaveLength(1);
    // One request in flight at a time.
    requestElidedBlocksIfNeeded(state, daemon);
    expect(requests).toHaveLength(1);

    answer(state, daemon, "blocks-1", requests[0]!);
    expect(state.showTurnWork).toBe(true);
    expect(hasElidedBlocks(state)).toBe(false);
    expect((state.messages[1] as { blocks: Block[] }).blocks).toEqual(fullBlocks(3));
    // The page's own array (shared with the history cache) is left as it was.
    expect(pageBlocks).toEqual(elidedBlocks(3));
    expect(buildMessageLines(state, state.cols).lines.join("\n")).toContain("needle-0");
  });

  test("Ctrl+O fetches only the work near the view; the history above it goes and pages back in", () => {
    const state = foldedState(200);
    state.historyStartIndex = ENTRY - 1;
    state.historyStartUserIndex = 2;
    const { daemon, requests } = fakeDaemon();
    handleFocusedKey({ type: "ctrl-o" }, state);
    requestElidedBlocksIfNeeded(state, daemon);

    // At the bottom: the prompt goes, and the turn is kept from a round start
    // about UNFOLD_KEEP_BLOCKS above its end.
    expect(state.messages).toHaveLength(1);
    expect(state.historyStartIndex).toBe(ENTRY);
    expect(state.historyStartUserIndex).toBe(3);
    expect(state.historyHasOlder).toBe(true);
    const start = state.historyStartBlockIndex;
    expect(start % 3).toBe(0);
    expect(start).toBeGreaterThan(400);
    expect(start).toBeLessThanOrEqual(601 - 90);
    expect((state.messages[0] as { blocks: Block[] }).blocks).toHaveLength(601 - start);
    expect(requests[0]!.every(range => range.entry === ENTRY && range.start >= start)).toBe(true);

    answer(state, daemon, "blocks-1", requests[0]!, { rounds: 200 });
    expect(state.showTurnWork).toBe(true);
    expect((state.messages[0] as { blocks: Block[] }).blocks).toEqual(fullBlocks(200).slice(start));
  });

  test("a window whose references disagree with its cursor is never cut", () => {
    const state = foldedState(200);
    const { daemon, requests } = fakeDaemon();
    handleFocusedKey({ type: "ctrl-o" }, state);
    requestElidedBlocksIfNeeded(state, daemon);
    expect(state.messages).toHaveLength(2);
    expect(state.historyStartBlockIndex).toBe(0);
    expect(requests).toHaveLength(1);
  });

  test("a second Ctrl+O while the content loads stays folded", () => {
    const state = foldedState();
    const { daemon, requests } = fakeDaemon();
    handleFocusedKey({ type: "ctrl-o" }, state);
    requestElidedBlocksIfNeeded(state, daemon);
    handleFocusedKey({ type: "ctrl-o" }, state);
    expect(state.unfoldAfterElidedLoad).toBeNull();

    answer(state, daemon, "blocks-1", requests[0]!);
    expect(state.showTurnWork).toBe(false);
    // The fetched content still fills in.
    expect(hasElidedBlocks(state)).toBe(false);
  });

  test("a reply cut at its size limit is continued; blocks the daemon no longer has are not asked for again", () => {
    const state = foldedState();
    const { daemon, requests } = fakeDaemon();
    handleFocusedKey({ type: "ctrl-o" }, state);
    requestElidedBlocksIfNeeded(state, daemon);
    answer(state, daemon, "blocks-1", requests[0]!, { truncated: true, limit: 4 });
    expect(state.showTurnWork).toBe(false);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual([{ entry: ENTRY, start: 4, end: 7 }]);

    // The history changed under the client: block 6 is gone.
    answer(state, daemon, "blocks-2", [{ entry: ENTRY, start: 4, end: 6 }]);
    expect(requests).toHaveLength(2);
    expect(hasElidedBlocks(state)).toBe(false);
    expect(state.showTurnWork).toBe(true);
  });

  test("a failed fetch shows the work with what is loaded", () => {
    const state = foldedState();
    const { daemon, requests } = fakeDaemon();
    handleFocusedKey({ type: "ctrl-o" }, state);
    requestElidedBlocksIfNeeded(state, daemon);
    handleEvent({ type: "error", reqId: "blocks-1", convId: "conv-1", message: "Unknown command" }, state, daemon);
    expect(state.showTurnWork).toBe(true);
    requestElidedBlocksIfNeeded(state, daemon);
    expect(requests).toHaveLength(1);
  });

  test("Ctrl+I waits for the content too, then expands as before", () => {
    const state = foldedState();
    const { daemon, requests } = fakeDaemon();
    expect(handleFocusedKey({ type: "ctrl-i" }, state)).toEqual({ type: "handled" });
    expect(state.unfoldAfterElidedLoad).toBe("tool_output");
    requestElidedBlocksIfNeeded(state, daemon);
    answer(state, daemon, "blocks-1", requests[0]!);
    expect(state.showToolOutput || state.showToolOutputAfterLoad).toBe(true);
  });

  test("a folded search that may land in elided work runs once it is in", () => {
    const state = foldedState();
    const { daemon, requests } = fakeDaemon();
    state.search = {
      barOpen: false, barMode: "search", direction: "backward", query: "needle-1", barInput: "", barCursorPos: 0,
      highlightsVisible: false, savedScrollOffset: 0, savedHistoryCursor: { row: 0, col: 0 }, originChatFocus: "prompt",
    };
    expect(jumpToSearchMatch(state, "backward")).toBe(true);
    expect(state.searchAfterElidedLoad).toBe("backward");
    expect(state.showTurnWork).toBe(false);
    requestElidedBlocksIfNeeded(state, daemon);
    answer(state, daemon, "blocks-1", requests[0]!);
    // The match is in folded work: the search switches to the Ctrl+O view to land on it.
    expect(state.showTurnWork).toBe(true);
    expect(state.searchAfterElidedLoad).toBeNull();
  });
});
