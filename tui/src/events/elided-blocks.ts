/**
 * Elided history blocks (protocol `history-folded-elision`).
 *
 * Folded, the history shows a turn's reply and none of its work, so pages
 * requested folded arrive with the tool calls and thinking the view hides
 * emptied and marked `elided` with where they live. Nothing reads that content
 * until the work is shown: Ctrl+O and Ctrl+I, or a search that may land in it,
 * fetch it first (load_display_blocks) and act once it is in. A page that
 * arrives folded while the work is shown is filled in the same way.
 */
import { getViewStart, preserveViewportAcrossHistoryMutation } from "../chatscroll";
import { saveTurnWorkPreference } from "../diagnostics";
import type { Block, ElidedBlockRef } from "../messages";
import type { Event } from "../protocol";
import type { RenderState } from "../state";
import { jumpToSearchMatch } from "../search";
import { keptByCut, planHistoryTrimAboveView, trimHistoryAboveView, type HistoryCut } from "./history-trim";
import { omittedToolOutputIdsNearViewport, requestToolOutputs } from "./tool-outputs";
import type { DaemonActions } from "./types";

/** Most ranges one request names (the daemon accepts up to 1,000). */
const MAX_RANGES_PER_REQUEST = 500;

const refKey = (ref: ElidedBlockRef): string => `${ref.entry}:${ref.block}`;

function elidedRef(block: Block): ElidedBlockRef | undefined {
  return block.type === "tool_call" || block.type === "thinking" ? block.elided : undefined;
}

/**
 * Visit elided blocks (through message index `through`, none a trim at `cut`
 * would drop) until `visit` returns true.
 */
function forEachElided(state: RenderState, visit: (ref: ElidedBlockRef) => boolean | void, through = Number.POSITIVE_INFINITY, cut: HistoryCut | null = null): void {
  for (let index = cut?.at ?? 0; index < state.messages.length && index <= through; index++) {
    const message = state.messages[index]!;
    if (message.role !== "assistant") continue;
    for (let block = 0; block < message.blocks.length; block++) {
      const ref = elidedRef(message.blocks[block]!);
      if (ref && keptByCut(cut, index, block) && !state.elidedBlocksUnavailable.has(refKey(ref)) && visit(ref) === true) return;
    }
  }
}

/** Whether loaded history (through message `through`) still holds elided blocks the daemon may fill in. */
export function hasElidedBlocks(state: RenderState, through?: number): boolean {
  let found = false;
  forEachElided(state, () => (found = true), through);
  return found;
}

/**
 * The last message with a row in view. Showing the work keeps the first row
 * in view where it is, so what lies below this only grows off-screen.
 */
function lastMessageInView(state: RenderState): number {
  const last = state.messages.length - 1;
  const anchors = state.historyLineAnchors;
  const height = state.layout.messageAreaHeight;
  if (state.scrollOffset === 0 || height <= 0 || anchors.length === 0) return last;
  const index = new Map<object, number>();
  state.messages.forEach((message, at) => {
    index.set(message, at);
    if (message.role === "assistant") for (const block of message.blocks) index.set(block, at);
  });
  const start = getViewStart(state);
  let through = -1;
  for (let row = start; row < Math.min(anchors.length, start + height); row++) through = Math.max(through, index.get(anchors[row]!.owner) ?? -1);
  return through < 0 ? last : Math.min(last, through + 1);
}

/** The view shows (or is about to show) folded work, so elided blocks are needed. */
function needsElidedBlocks(state: RenderState): boolean {
  return state.showTurnWork || state.showToolOutput
    || state.unfoldAfterElidedLoad !== null || state.searchAfterElidedLoad !== null
    || state.search?.barOpen === true;
}

/**
 * One range per entry, from its first elided block to its last, in history
 * order: the blocks between (tool results, text) are small and come back
 * unchanged, and a long turn is one range instead of hundreds.
 */
export function elidedBlockRanges(state: RenderState, limit = MAX_RANGES_PER_REQUEST, through?: number, cut: HistoryCut | null = null): Array<{ entry: number; start: number; end: number }> {
  const ranges: Array<{ entry: number; start: number; end: number }> = [];
  forEachElided(state, (ref) => {
    const last = ranges.at(-1);
    if (last && last.entry === ref.entry) {
      last.start = Math.min(last.start, ref.block);
      last.end = Math.max(last.end, ref.block + 1);
      return;
    }
    if (ranges.length >= limit) return true;
    ranges.push({ entry: ref.entry, start: ref.block, end: ref.block + 1 });
  }, through, cut);
  return ranges;
}

/**
 * After each frame and history change: fetch elided blocks while they are
 * needed, or, with none left, do what was waiting for them.
 * Returns whether it changed the view (something waiting was applied).
 */
export function requestElidedBlocksIfNeeded(
  state: RenderState,
  daemon: Pick<DaemonActions, "loadDisplayBlocks" | "loadToolOutputs">,
): boolean {
  if (!state.convId || state.elidedBlocksRequestId !== null || !needsElidedBlocks(state)) return false;
  // About to show the work: the history above the view goes rather than all its
  // work coming (history-trim.ts), and the work shows once what is in view and
  // above it is in; the rest below fills in after. The trim waits for the work
  // to show: the folded view keeps the history meanwhile.
  let through: number | undefined;
  let cut: HistoryCut | null = null;
  if (state.unfoldAfterElidedLoad !== null && state.searchAfterElidedLoad === null) {
    // At the bottom, a screen already filled in (the open's prefetch) shows at
    // once; the work above it is fetched right after, out of view.
    if (state.scrollOffset === 0 && bottomScreenFilledIn(state)) {
      const settled = settleElidedBlocks(state, daemon);
      if (settled) requestElidedBlocksIfNeeded(state, daemon);
      return settled;
    }
    through = lastMessageInView(state);
    cut = planHistoryTrimAboveView(state);
  }
  const ranges = daemon.loadDisplayBlocks ? elidedBlockRanges(state, MAX_RANGES_PER_REQUEST, through, cut) : [];
  if (ranges.length === 0) {
    const settled = settleElidedBlocks(state, daemon);
    // Anything still elided (below the view) is fetched now that the work shows.
    if (settled && through !== undefined) requestElidedBlocksIfNeeded(state, daemon);
    return settled;
  }
  state.elidedBlocksRequestRanges = ranges;
  state.elidedBlocksRequestId = daemon.loadDisplayBlocks!(state.convId, ranges) ?? null;
  return false;
}

// --- The newest screen ---
// After an open, the folded work of the newest screen is fetched in the
// background (prefetchBottomScreen), so Ctrl+O and Ctrl+I at the bottom show
// it without a round trip.

/** About one screen of tool calls and thinking: the prefetch's reply limit. */
export const PREFETCH_SCREEN_BYTES = 32 * 1024;

/** Rows a block shows at least once folded work is shown (Ctrl+O), at `cols` wide. */
function shownRows(block: Block, cols: number): number {
  const wrapped = (text: string) => text.split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / cols)), 0);
  switch (block.type) {
    case "text": return block.text.trim() ? wrapped(block.text) : 0;
    case "thinking": return block.text.trim() ? wrapped(block.text) : 0;
    // Long non-shell calls collapse to a few rows; counting one row errs low.
    case "tool_call": return block.toolName === "bash" || block.toolName === "Bash" || block.toolName === "exec_command" ? wrapped(block.summary) : 1;
    case "tool_result": return 0;
  }
}

/**
 * Elided blocks from the bottom of the history up, until the blocks below them
 * fill a screen once folded work is shown. `visit` returns true to stop; the
 * result says whether the screen was filled without an elided block.
 */
function walkBottomScreen(state: RenderState, visit: (ref: ElidedBlockRef) => boolean | void): boolean {
  const height = state.layout.messageAreaHeight > 0 ? state.layout.messageAreaHeight : state.rows;
  const cols = Math.max(20, (state.layout.chatWidth > 0 ? state.layout.chatWidth : state.cols) - 6);
  let rows = 0;
  let clean = true;
  for (let index = state.messages.length - 1; index >= 0 && rows < height; index--) {
    const message = state.messages[index]!;
    if (message.role !== "assistant") {
      rows += message.role === "system_instructions" ? 0 : 2;
      continue;
    }
    for (let block = message.blocks.length - 1; block >= 0 && rows < height; block--) {
      const candidate = message.blocks[block]!;
      const ref = elidedRef(candidate);
      if (ref && !state.elidedBlocksUnavailable.has(refKey(ref))) {
        clean = false;
        if (visit(ref) === true) return false;
        rows += 1;
      } else {
        rows += shownRows(candidate, cols);
      }
    }
  }
  return clean;
}

/** Whether the bottom screen, folded work shown, has nothing left to fetch. */
export function bottomScreenFilledIn(state: RenderState): boolean {
  return walkBottomScreen(state, () => true);
}

/**
 * After an open, while folded: fetch the newest screen's folded work, newest
 * first and at most PREFETCH_SCREEN_BYTES, without waiting on it. Called after
 * the first paint, so it never delays first content.
 */
export function prefetchBottomScreen(state: RenderState, daemon: Pick<DaemonActions, "loadDisplayBlocks">): void {
  if (!state.convId || !daemon.loadDisplayBlocks || state.elidedBlocksRequestId !== null) return;
  if (state.showTurnWork || state.showToolOutput) return;
  // Newest first, one range per block: a reply cut at its limit keeps the newest.
  const ranges: Array<{ entry: number; start: number; end: number }> = [];
  walkBottomScreen(state, (ref) => {
    ranges.push({ entry: ref.entry, start: ref.block, end: ref.block + 1 });
    return ranges.length >= MAX_RANGES_PER_REQUEST;
  });
  if (ranges.length === 0) return;
  state.elidedBlocksRequestRanges = ranges;
  state.elidedBlocksRequestId = daemon.loadDisplayBlocks(state.convId, ranges, PREFETCH_SCREEN_BYTES) ?? null;
}

/** Put fetched blocks in place of the elided ones they answer. */
export function applyDisplayBlocks(state: RenderState, ranges: Extract<Event, { type: "display_blocks_loaded" }>["ranges"]): number {
  const loaded = new Map<string, Block>();
  for (const range of ranges) {
    range.blocks.forEach((block, offset) => loaded.set(`${range.entry}:${range.start + offset}`, block));
  }
  let patched = 0;
  for (const message of state.messages) {
    if (message.role !== "assistant") continue;
    let blocks: Block[] | null = null;
    message.blocks.forEach((block, index) => {
      const ref = elidedRef(block);
      if (!ref) return;
      const full = loaded.get(refKey(ref));
      if (!full || full.type !== block.type || elidedRef(full)
          || (full.type === "tool_call" && block.type === "tool_call" && full.toolCallId !== block.toolCallId)) return;
      // A copy: the blocks array may be shared with the SSH history cache's entry.
      blocks ??= message.blocks.slice();
      blocks[index] = full;
      patched++;
    });
    if (blocks) message.blocks = blocks;
  }
  return patched;
}

export function handleDisplayBlocksLoaded(
  state: RenderState,
  event: Extract<Event, { type: "display_blocks_loaded" }>,
  daemon: Pick<DaemonActions, "loadDisplayBlocks" | "loadToolOutputs">,
): void {
  if (event.reqId !== state.elidedBlocksRequestId) {
    // A superseded reply still carries valid blocks.
    if (event.convId === state.convId) patchPreservingView(state, event.ranges);
    return;
  }
  const requested = state.elidedBlocksRequestRanges;
  state.elidedBlocksRequestId = null;
  state.elidedBlocksRequestRanges = [];
  patchPreservingView(state, event.ranges);
  // Blocks the daemon no longer has (the history changed) are not asked for
  // again; a reply cut at its size limit is continued by the next request.
  if (!event.truncated) {
    for (const range of requested) {
      const answer = event.ranges.find(loaded => loaded.entry === range.entry && loaded.start === range.start);
      for (let block = range.start + (answer?.blocks.length ?? 0); block < range.end; block++) {
        state.elidedBlocksUnavailable.add(`${range.entry}:${block}`);
      }
    }
  }
  requestElidedBlocksIfNeeded(state, daemon);
}

function patchPreservingView(state: RenderState, ranges: Extract<Event, { type: "display_blocks_loaded" }>["ranges"]): void {
  if (state.showTurnWork || state.showToolOutput) preserveViewportAcrossHistoryMutation(state, () => applyDisplayBlocks(state, ranges));
  else applyDisplayBlocks(state, ranges);
}

/** A failed fetch: what was waiting for it goes ahead with what is loaded. */
export function handleDisplayBlocksError(state: RenderState, reqId: string | undefined, daemon: Pick<DaemonActions, "loadToolOutputs">): boolean {
  if (!reqId || reqId !== state.elidedBlocksRequestId) return false;
  for (const range of state.elidedBlocksRequestRanges) {
    for (let block = range.start; block < range.end; block++) state.elidedBlocksUnavailable.add(`${range.entry}:${block}`);
  }
  state.elidedBlocksRequestId = null;
  state.elidedBlocksRequestRanges = [];
  settleElidedBlocks(state, daemon);
  return true;
}

/** Everything is in: show the work (Ctrl+O, Ctrl+I) or run the search that waited. */
function settleElidedBlocks(state: RenderState, daemon: Pick<DaemonActions, "loadToolOutputs">): boolean {
  const unfold = state.unfoldAfterElidedLoad;
  const search = state.searchAfterElidedLoad;
  if (unfold === null && search === null) return false;
  state.unfoldAfterElidedLoad = null;
  state.searchAfterElidedLoad = null;
  if (unfold === "turn_work") {
    preserveViewportAcrossHistoryMutation(state, () => {
      trimHistoryAboveView(state);
      state.showTurnWork = true;
      state.showToolOutput = false;
    });
    saveTurnWorkPreference(true);
  } else if (unfold === "tool_output") {
    expandToolOutput(state, daemon);
  }
  if (search) jumpToSearchMatch(state, search);
  return true;
}

/**
 * Ctrl+I's expansion: once the bodies around the viewport arrive, so rows do
 * not flash empty; the rest load as they scroll into view.
 */
export function expandToolOutput(state: RenderState, daemon: Pick<DaemonActions, "loadToolOutputs">): void {
  const toolCallIds = state.convId ? omittedToolOutputIdsNearViewport(state, { retry: true }) : [];
  if (toolCallIds.length === 0) {
    preserveViewportAcrossHistoryMutation(state, () => {
      trimHistoryAboveView(state);
      state.showToolOutput = true;
    });
    return;
  }
  state.showToolOutputAfterLoad = true;
  requestToolOutputs(state, daemon, toolCallIds);
}
