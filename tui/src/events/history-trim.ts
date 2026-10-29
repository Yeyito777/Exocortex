/**
 * Trimming the loaded history above the view when folded work is shown, and
 * putting it back when the view folds again.
 *
 * A folded window covers far more history than the unfolded view needs (its
 * pages leave the work out, and a long turn's work sits between its prompt and
 * reply), so fetching all of its work would cost more than the unfolded view
 * ever loaded. Showing the work (Ctrl+O, Ctrl+I) drops the history above the
 * view instead, except about UNFOLD_KEEP_BLOCKS blocks right above the first
 * one in view; scrolling up pages the rest back in, in full. Folding again puts
 * back what was dropped: what is left folds to much less, often only the live
 * turn, which drew at the top of the pane until older pages came back a round
 * trip later.
 */
import { getViewStart } from "../chatscroll";
import { joinSplitAssistantEntry } from "../historypagination";
import type { Block, ElidedBlockRef, Message } from "../messages";
import type { RenderState } from "../state";

/** Blocks (a message counts as a few) kept above the first one in view: a couple of screens of tool calls. */
const UNFOLD_KEEP_BLOCKS = 90;
const UNFOLD_MESSAGE_BLOCKS = 3;

/** What a trim dropped, and the window it cut. */
export interface TrimmedHistory {
  convId: string | null;
  /** Where the trimmed window starts (historyStartIndex, historyStartBlockIndex). */
  cutIndex: number;
  cutBlockIndex: number;
  /** The window before the trim. */
  startIndex: number;
  startBlockIndex: number;
  startUserIndex: number;
  hasOlder: boolean;
  /** The dropped messages; with `split`, the last holds the leading blocks of the message cut inside. */
  messages: Message[];
  split: boolean;
}

/** Where a trim would cut: message `at` from block `keepFrom` stays, the messages from `first` before it go. */
export interface HistoryCut {
  first: number;
  at: number;
  keepFrom: number;
}

const elidedRef = (block: Block): ElidedBlockRef | undefined =>
  block.type === "tool_call" || block.type === "thinking" ? block.elided : undefined;

/**
 * Where trimming above the view would cut the loaded history, or null to keep
 * it whole: at the bottom it keeps the end of the history, scrolled up the
 * first row in view and what is right above it. A cut inside a turn falls at a
 * round start, so no call loses its result. Nothing is cut when the history
 * above holds no elided work (nothing to save) or on a guess: when an elided
 * reference disagrees with the window's cursor.
 */
export function planHistoryTrimAboveView(state: RenderState): HistoryCut | null {
  const anchors = state.historyLineAnchors;
  if (state.layout.messageAreaHeight <= 0 || anchors.length === 0) return null;
  let first = 0;
  while (state.messages[first]?.role === "system_instructions") first++;
  let top: { message: number; block: number } | undefined;
  if (state.scrollOffset === 0) {
    const last = state.messages.length - 1;
    const message = state.messages[last];
    if (last >= first && message) top = { message: last, block: message.role === "assistant" ? message.blocks.length : 0 };
  } else {
    const owners = new Map<object, { message: number; block: number }>();
    state.messages.forEach((message, index) => {
      if (index < first) return;
      owners.set(message, { message: index, block: 0 });
      if (message.role === "assistant") message.blocks.forEach((block, blockIndex) => owners.set(block, { message: index, block: blockIndex }));
    });
    for (let row = getViewStart(state); row < anchors.length && !top; row++) top = owners.get(anchors[row]!.owner);
  }
  if (!top) return null;
  // Walk up from the first block in view until the budget is spent.
  let budget = UNFOLD_KEEP_BLOCKS;
  let at = top.message;
  let keepFrom = top.block;
  for (;;) {
    const message = state.messages[at]!;
    if (message.role === "assistant") {
      if (keepFrom > budget) { keepFrom -= budget; break; }
      budget -= keepFrom;
      keepFrom = 0;
    } else {
      budget -= UNFOLD_MESSAGE_BLOCKS;
    }
    if (budget <= 0 || at === first) break;
    at--;
    const previous = state.messages[at]!;
    keepFrom = previous.role === "assistant" ? previous.blocks.length : 0;
  }
  const message = state.messages[at]!;
  if (message.role === "assistant") {
    while (keepFrom > 0 && !(message.blocks[keepFrom - 1]!.type === "tool_result" && message.blocks[keepFrom]!.type !== "tool_result")) keepFrom--;
    if (keepFrom >= message.blocks.length) { at++; keepFrom = 0; }
  }
  if ((at === first && keepFrom === 0) || !state.messages[at]) return null;
  // Messages map one to one onto the window's entries, from historyStartIndex
  // (its first only from historyStartBlockIndex).
  let elidedAbove = false;
  for (let index = first; index < state.messages.length; index++) {
    const candidate = state.messages[index]!;
    if (candidate.role !== "assistant") continue;
    const ref = candidate.blocks.map(elidedRef).find(Boolean);
    if (ref && ref.entry !== state.historyStartIndex + index - first) return null;
    if (!elidedAbove) elidedAbove = candidate.blocks.some((block, blockIndex) => (index < at || blockIndex < keepFrom) && elidedRef(block) !== undefined);
  }
  return elidedAbove ? { first, at, keepFrom } : null;
}

/** Whether `block` of message `index` is kept by `cut` (no cut keeps everything). */
export function keptByCut(cut: HistoryCut | null, index: number, block: number): boolean {
  return !cut || index > cut.at || (index === cut.at && block >= cut.keepFrom);
}

/**
 * Before showing folded work: drop the loaded history above the view, as if
 * it had never been loaded (planHistoryTrimAboveView), and keep what went for
 * restoreHistoryAboveView.
 */
export function trimHistoryAboveView(state: RenderState): void {
  const cut = planHistoryTrimAboveView(state);
  if (!cut) return;
  const { first, at, keepFrom } = cut;
  const offset = at - first;
  const kept = state.messages[at]!;
  const dropped = state.messages.slice(first, at);
  const split = keepFrom > 0 && kept.role === "assistant";
  let messages = split ? [...dropped, { ...kept, blocks: kept.blocks.slice(0, keepFrom) }] : dropped;
  // A window already cut (Ctrl+I from the Ctrl+O view): what goes now joins what went then.
  const previous = currentTrim(state);
  if (previous) {
    const older = previous.messages.slice();
    if (previous.split) joinSplitAssistantEntry(older, messages);
    messages = [...older, ...messages];
  }
  const trimmed: TrimmedHistory = {
    convId: state.convId,
    cutIndex: state.historyStartIndex + offset,
    cutBlockIndex: (offset === 0 ? state.historyStartBlockIndex : 0) + keepFrom,
    startIndex: previous?.startIndex ?? state.historyStartIndex,
    startBlockIndex: previous?.startBlockIndex ?? state.historyStartBlockIndex,
    startUserIndex: previous?.startUserIndex ?? state.historyStartUserIndex,
    hasOlder: previous?.hasOlder ?? state.historyHasOlder,
    messages,
    split,
  };
  if (split) state.messages[at] = { ...kept, blocks: kept.blocks.slice(keepFrom) };
  state.messages.splice(first, at - first);
  state.historyStartIndex = trimmed.cutIndex;
  state.historyStartBlockIndex = trimmed.cutBlockIndex;
  state.historyStartUserIndex += dropped.filter(candidate => candidate.role === "user").length;
  state.historyHasOlder = true;
  state.historyTrimmedAboveView = trimmed;
  state.deferredHistoryRender = null;
}

/** The trim the loaded window still starts at, if any. */
function currentTrim(state: RenderState): TrimmedHistory | null {
  const trimmed = state.historyTrimmedAboveView;
  return trimmed
    && trimmed.convId === state.convId
    && state.historyStartIndex === trimmed.cutIndex
    && state.historyStartBlockIndex === trimmed.cutBlockIndex
    ? trimmed
    : null;
}

/**
 * The view folded again (Ctrl+O, Ctrl+I): put back the history the unfold
 * dropped, while the window still starts where it was cut. Once older pages
 * moved the start (scrolling up while unfolded), they hold that history.
 */
export function restoreHistoryAboveView(state: RenderState): void {
  if (state.showTurnWork || state.showToolOutput) return;
  const trimmed = currentTrim(state);
  state.historyTrimmedAboveView = null;
  if (!trimmed) return;
  let first = 0;
  while (state.messages[first]?.role === "system_instructions") first++;
  const older = trimmed.messages.slice();
  const newer = state.messages.slice(first);
  if (trimmed.split) {
    // The window starts inside an entry: its leading blocks join it again.
    if (newer[0]?.role !== "assistant") return;
    joinSplitAssistantEntry(older, newer);
  }
  state.messages = [...state.messages.slice(0, first), ...older, ...newer];
  state.historyStartIndex = trimmed.startIndex;
  state.historyStartBlockIndex = trimmed.startBlockIndex;
  state.historyStartUserIndex = trimmed.startUserIndex;
  state.historyHasOlder = trimmed.hasOlder;
  // A page asked for at the cut no longer fits the window: drop its reply.
  state.historyLoadingOlder = false;
  state.historyLoadingStartedAt = null;
  state.historyLoadingRequestId = null;
  state.deferredHistoryRender = null;
}
