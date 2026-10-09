import type { DisplayEntry } from "./display";
import type { ConversationRenderSnapshot, StoredDisplayHistoryPage } from "./conversations";
import type { HistoryUpdatedEvent } from "./protocol";
import type { Block, ImageAttachment } from "./messages";

export const INITIAL_HISTORY_TURNS = 5;
export const BUFFERED_HISTORY_TURNS = 15;
/**
 * Approximate serialized size of one history window for clients that page
 * within entries. A single agent turn can span hundreds of tool rounds, so a
 * user-turn limit alone does not bound what an open or backfill transfers.
 */
export const HISTORY_PAGE_BYTE_BUDGET = 128 * 1024;
const RECENT_HISTORY_IMAGE_PAYLOAD_ENTRIES = 8;

export interface HistoryWindowOptions {
  /** With beforeEntryIndex, also include blocks before this index of that AI entry. */
  beforeBlockIndex?: number;
  /** Stop once the window reaches this many serialized bytes, cutting AI entries between tool rounds. */
  byteBudget?: number;
}

export interface DisplayHistoryPage {
  /** Conversation/folder instructions stay pinned above every paged history window. */
  pinnedEntries: DisplayEntry[];
  entries: DisplayEntry[];
  startIndex: number;
  /** First included block of the entry at startIndex; nonzero only for a partial AI entry. */
  startBlockIndex: number;
  startUserIndex: number;
  endIndex: number;
  /** Blocks of the entry at endIndex included as the window's last (partial) entry. */
  endBlockIndex: number;
  totalEntries: number;
  hasOlder: boolean;
}

export interface HistoryWindowCandidate {
  index: number;
  entry: DisplayEntry;
  /** Serialized size of the whole entry when the caller already knows it. */
  bytes?: number;
}

export interface HistoryWindow {
  entries: DisplayEntry[];
  startIndex: number;
  startBlockIndex: number;
  /** User entries included in the window. */
  userEntries: number;
}

const serializedBytes = (value: unknown): number => JSON.stringify(value).length;

function sliceAIEntry(entry: Extract<DisplayEntry, { type: "ai" }>, start: number, end?: number): DisplayEntry {
  return { ...entry, blocks: entry.blocks.slice(start, end) };
}

/**
 * Where a window may begin inside an AI entry: the first block of each
 * provider round, so a tool call is never separated from its result. Returns
 * the earliest round start whose tail fits `remaining`; when nothing fits and
 * the window is still empty, the last round (or 0 when the entry has no
 * rounds); otherwise -1.
 */
function aiTailStart(blocks: Block[], remaining: number, required: boolean): number {
  let tailBytes = 0;
  let fitting = -1;
  let lastRound = -1;
  for (let index = blocks.length - 1; index > 0; index--) {
    tailBytes += serializedBytes(blocks[index]) + 1;
    if (blocks[index]!.type === "tool_result" || blocks[index - 1]!.type !== "tool_result") continue;
    if (lastRound < 0) lastRound = index;
    if (tailBytes > remaining) break;
    fitting = index;
  }
  if (fitting > 0) return fitting;
  if (!required) return -1;
  return lastRound > 0 ? lastRound : 0;
}

/**
 * Select a history window walking backward from an end cursor. Entries are
 * taken whole until `turns` user turns are included or, with a byte budget,
 * the next entry would overflow it. An AI entry that overflows is cut at a
 * round boundary so long agent turns page the same way as many short turns.
 * The window always includes something when a candidate exists.
 *
 * `candidates` must be in descending index order starting at the entry at
 * `endIndex` when `endBlockIndex` is nonzero, else at `endIndex - 1`.
 */
export function selectHistoryWindow(
  candidates: Iterable<HistoryWindowCandidate>,
  turns: number,
  endIndex: number,
  endBlockIndex = 0,
  byteBudget?: number,
): HistoryWindow {
  const safeTurns = Math.max(1, Math.floor(Number.isFinite(turns) ? turns : 1));
  const selected: DisplayEntry[] = [];
  let startIndex = endIndex;
  let startBlockIndex = endBlockIndex;
  let usedBytes = 0;
  let userEntries = 0;
  for (const candidate of candidates) {
    const entry = endBlockIndex > 0 && candidate.index === endIndex && candidate.entry.type === "ai"
      ? sliceAIEntry(candidate.entry, 0, endBlockIndex)
      : candidate.entry;
    const bytes = entry !== candidate.entry || candidate.bytes === undefined ? serializedBytes(entry) : candidate.bytes;
    if (byteBudget !== undefined && usedBytes + bytes > byteBudget) {
      if (entry.type !== "ai") {
        if (selected.length > 0) break;
      } else {
        const tailStart = aiTailStart(entry.blocks, byteBudget - usedBytes, selected.length === 0);
        if (tailStart < 0) break;
        if (tailStart > 0) {
          selected.push(sliceAIEntry(entry, tailStart));
          startIndex = candidate.index;
          startBlockIndex = tailStart;
          break;
        }
      }
    }
    selected.push(entry);
    usedBytes += bytes;
    startIndex = candidate.index;
    startBlockIndex = 0;
    if (entry.type === "user" && ++userEntries >= safeTurns) break;
  }
  selected.reverse();
  return { entries: selected, startIndex, startBlockIndex, userEntries };
}

/**
 * Slice display history on user-turn boundaries (and, with a byte budget,
 * between the tool rounds of an oversized AI entry).
 *
 * The absolute cursor addresses entries after system instructions have been
 * removed. That keeps the cursor stable while instructions remain pinned at the
 * top of every initial/canonical payload.
 */
export function pageDisplayHistory(
  allEntries: DisplayEntry[],
  turns: number,
  beforeEntryIndex?: number,
  options: HistoryWindowOptions = {},
): DisplayHistoryPage {
  const pinnedEntries = allEntries.filter((entry) => entry.type === "system_instructions");
  const historyEntries = allEntries.filter((entry) => entry.type !== "system_instructions");
  const endIndex = Math.max(0, Math.min(
    beforeEntryIndex === undefined ? historyEntries.length : Math.floor(beforeEntryIndex),
    historyEntries.length,
  ));
  const endBlockIndex = endIndex < historyEntries.length ? Math.max(0, Math.floor(options.beforeBlockIndex ?? 0)) : 0;
  const candidates = function* (): Generator<HistoryWindowCandidate> {
    for (let index = endBlockIndex > 0 ? endIndex : endIndex - 1; index >= 0; index--) {
      yield { index, entry: historyEntries[index]! };
    }
  };
  const window = selectHistoryWindow(candidates(), turns, endIndex, endBlockIndex, options.byteBudget);

  return {
    pinnedEntries,
    entries: window.entries,
    startIndex: window.startIndex,
    startBlockIndex: window.startBlockIndex,
    startUserIndex: historyEntries.slice(0, window.startIndex).filter((entry) => entry.type === "user").length,
    endIndex,
    endBlockIndex,
    totalEntries: historyEntries.length,
    hasOlder: window.startIndex > 0 || window.startBlockIndex > 0,
  };
}

/**
 * Bound an already paginated canonical refresh for clients that page within
 * entries. Older loaded history is preserved client-side, so only the newest
 * budgeted window needs to cross the wire.
 */
export function budgetHistoryUpdatedEvent(event: HistoryUpdatedEvent, byteBudget = HISTORY_PAGE_BYTE_BUDGET): HistoryUpdatedEvent {
  if (event.historyStartIndex === undefined || event.historyStartBlockIndex) return event;
  const pinnedEntries = event.entries.filter((entry) => entry.type === "system_instructions");
  const pageEntries = event.entries.filter((entry) => entry.type !== "system_instructions");
  const pageStart = event.historyStartIndex;
  const candidates = function* (): Generator<HistoryWindowCandidate> {
    for (let offset = pageEntries.length - 1; offset >= 0; offset--) {
      yield { index: pageStart + offset, entry: pageEntries[offset]! };
    }
  };
  const window = selectHistoryWindow(candidates(), Number.MAX_SAFE_INTEGER, pageStart + pageEntries.length, 0, byteBudget);
  if (window.startIndex === pageStart && window.startBlockIndex === 0) return event;
  const droppedUsers = pageEntries.slice(0, window.startIndex - pageStart).filter((entry) => entry.type === "user").length;
  return {
    ...event,
    entries: [...pinnedEntries, ...window.entries],
    historyStartIndex: window.startIndex,
    historyStartUserIndex: (event.historyStartUserIndex ?? 0) + droppedUsers,
    ...(window.startBlockIndex > 0 ? { historyStartBlockIndex: window.startBlockIndex } : {}),
    hasOlderHistory: true,
  };
}

const compactImageForHistory = (image: ImageAttachment): ImageAttachment => ({
  mediaType: image.mediaType,
  base64: "",
  sizeBytes: image.sizeBytes,
});

export function compactHistoryImages(data: ConversationRenderSnapshot): ConversationRenderSnapshot {
  return {
    ...data,
    entries: data.entries.map((entry, index) => entry.type === "user"
      && entry.images?.length
      && index < data.entries.length - RECENT_HISTORY_IMAGE_PAYLOAD_ENTRIES
      ? { ...entry, images: entry.images.map(compactImageForHistory) }
      : entry),
  };
}

export function buildHistoryUpdatedEvents(
  data: ConversationRenderSnapshot,
  options: { resetHistoryWindow?: boolean } = {},
): {
  legacy: HistoryUpdatedEvent;
  paginated: HistoryUpdatedEvent;
} {
  const compactData = compactHistoryImages(data);
  const page = pageDisplayHistory(compactData.entries, BUFFERED_HISTORY_TURNS);
  const base = {
    type: "history_updated" as const,
    convId: compactData.convId,
    contextTokens: compactData.contextTokens,
    toolOutputsIncluded: compactData.toolOutputsIncluded,
    pendingAI: compactData.pendingAI ?? null,
    ...(options.resetHistoryWindow ? { resetHistoryWindow: true } : {}),
  };
  return {
    legacy: { ...base, entries: compactData.entries },
    paginated: {
      ...base,
      entries: [...page.pinnedEntries, ...page.entries],
      historyStartIndex: page.startIndex,
      historyStartUserIndex: page.startUserIndex,
      historyTotalEntries: page.totalEntries,
      hasOlderHistory: page.hasOlder,
    },
  };
}

/** Build the paginated canonical refresh directly from the durable projection. */
export function buildStoredHistoryUpdatedEvent(
  page: StoredDisplayHistoryPage,
  options: { resetHistoryWindow?: boolean } = {},
): HistoryUpdatedEvent {
  return {
    type: "history_updated",
    convId: page.convId,
    entries: [...page.pinnedEntries, ...page.entries],
    historyStartIndex: page.startIndex,
    historyStartUserIndex: page.startUserIndex,
    historyTotalEntries: page.totalEntries,
    hasOlderHistory: page.hasOlder,
    contextTokens: page.contextTokens,
    toolOutputsIncluded: false,
    pendingAI: null,
    ...(options.resetHistoryWindow ? { resetHistoryWindow: true } : {}),
  };
}
