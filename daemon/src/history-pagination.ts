import type { DisplayEntry } from "./display";
import type { ConversationRenderSnapshot, StoredDisplayHistoryPage } from "./conversations";
import type { HistoryUpdatedEvent } from "./protocol";
import type { Block, ImageAttachment } from "./messages";

export const INITIAL_HISTORY_TURNS = 5;
export const BUFFERED_HISTORY_TURNS = 15;
/** Largest `turns` a client may request in one history window. */
export const MAX_HISTORY_REQUEST_TURNS = 100;
/**
 * Approximate serialized size of one history window for clients that page
 * within entries. A single agent turn can span hundreds of tool rounds, so a
 * user-turn limit alone does not bound what an open or backfill transfers.
 */
export const HISTORY_PAGE_BYTE_BUDGET = 128 * 1024;
const RECENT_HISTORY_IMAGE_PAYLOAD_ENTRIES = 8;

/**
 * Rendered rows an opening window should cover: the client's visible history
 * height plus one more screen of scrollback above it.
 */
export const OPENING_WINDOW_VIEWPORTS = 2;

/** The client's history viewport, in terminal cells. */
export interface HistoryViewport {
  rows: number;
  cols: number;
}

export function isValidHistoryViewport(value: unknown): value is HistoryViewport {
  const { rows, cols } = (value ?? {}) as Partial<HistoryViewport>;
  return Number.isSafeInteger(rows) && rows! >= 1 && rows! <= 1000
    && Number.isSafeInteger(cols) && cols! >= 1 && cols! <= 4000;
}

export interface HistoryWindowOptions {
  /** With beforeEntryIndex, also include blocks before this index of that AI entry. */
  beforeBlockIndex?: number;
  /** Stop once the window reaches this many serialized bytes, cutting AI entries between tool rounds. */
  byteBudget?: number;
  /**
   * Stop once the window's estimated rendered rows cover OPENING_WINDOW_VIEWPORTS
   * screens of this viewport, rather than after a fixed number of turns.
   */
  viewport?: HistoryViewport;
}

export interface HistoryWindowLimits {
  byteBudget?: number;
  /** Estimated rendered rows after which the window is full. */
  rowTarget?: { rows: number; cols: number };
  /**
   * Pasted image payloads ride along only in budget the history itself left
   * over; otherwise they are dropped (as for old history) so a large screenshot
   * cannot crowd the turns around it out of the window. Clients fetch bounded
   * previews by image id.
   */
  optionalImagePayloads?: boolean;
}

/** Limits for a paged history window (opening or backfill) with these options. */
export function pageWindowLimits(options: HistoryWindowOptions): HistoryWindowLimits {
  const viewport = options.viewport;
  return {
    byteBudget: options.byteBudget,
    ...(viewport ? { rowTarget: { rows: viewport.rows * OPENING_WINDOW_VIEWPORTS, cols: viewport.cols } } : {}),
    optionalImagePayloads: options.byteBudget !== undefined,
  };
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

// ── Rendered-row estimates ───────────────────────────────────────────
// Mirror the TUI's default presentation closely enough to size a window to a
// screen: text wraps at the content width, a tool call shows its summary, tool
// results and images' pixels stay out of the count (results are collapsed by
// default; image boxes depend on the terminal's cell size). Character wrapping
// never yields more rows than the TUI's word wrapping, so the estimate errs low
// and a window that reaches its row target fills at least that many rows.

/** Columns the TUI keeps around assistant content and the user bubble. */
const CONTENT_MARGIN_COLS = 4;
/** Rows around an assistant entry: its metadata line (when it has one) and the gap after it. */
const aiEntryChromeRows = (entry: Extract<DisplayEntry, { type: "ai" }>): number => (entry.metadata ? 2 : 1);
/** Rows around a user entry: the gap below its bubble. */
const USER_ENTRY_CHROME_ROWS = 1;
/** Estimating megabytes of one block is wasted work once it alone fills the target. */
const MAX_ESTIMATED_TEXT_CHARS = 256 * 1024;

function wrappedRows(text: string, cols: number): number {
  const width = Math.max(1, cols);
  let rows = 0;
  for (const line of text.slice(0, MAX_ESTIMATED_TEXT_CHARS).split("\n")) {
    rows += Math.max(1, Math.ceil(line.length / width));
  }
  return rows;
}

export function estimateBlockRows(block: Block, cols: number): number {
  const contentCols = cols - CONTENT_MARGIN_COLS;
  switch (block.type) {
    case "thinking": {
      const text = block.text.replace(/^\n+|\n+$/g, "");
      return text.trim() ? wrappedRows(text, contentCols) : 0;
    }
    case "text":
      return wrappedRows(block.text.replace(/^\n+/, ""), contentCols);
    case "tool_call":
      return wrappedRows(block.summary ?? "", contentCols - 2);
    case "tool_result":
      return 0;
  }
}

export function estimateEntryRows(entry: DisplayEntry, cols: number): number {
  switch (entry.type) {
    case "system_instructions":
      return 0;
    case "user":
      return wrappedRows(entry.text, cols - 2 * CONTENT_MARGIN_COLS) + USER_ENTRY_CHROME_ROWS + (entry.images?.length ? 1 : 0);
    case "ai":
      return entry.blocks.reduce((rows, block) => rows + estimateBlockRows(block, cols), aiEntryChromeRows(entry));
    case "system":
      return wrappedRows(entry.text, cols - CONTENT_MARGIN_COLS) + 1;
  }
}

function hasImagePayload(entry: DisplayEntry): boolean {
  return entry.type === "user" && !!entry.images?.some((image) => image.base64.length > 0);
}

function withoutImagePayloads(entry: Extract<DisplayEntry, { type: "user" }>): DisplayEntry {
  return { ...entry, images: entry.images!.map(compactImageForHistory) };
}

function sliceAIEntry(entry: Extract<DisplayEntry, { type: "ai" }>, start: number, end?: number): DisplayEntry {
  return { ...entry, blocks: entry.blocks.slice(start, end) };
}

/**
 * Where a window may begin inside an AI entry: the first block of each
 * provider round, so a tool call is never separated from its result. Returns
 * the latest round start whose tail covers `rows.needed`, else 0 (the whole
 * entry) when it fits the budget, else the earliest round start whose tail
 * fits `remaining` bytes; when nothing fits and the window is still empty, the
 * last round (or 0 when the entry has no rounds); otherwise -1.
 */
function aiTailStart(
  blocks: Block[],
  remaining: number,
  required: boolean,
  rows?: { needed: number; cols: number; wholeFits: boolean; chrome: number },
): number {
  let tailBytes = 0;
  let tailRows = rows?.chrome ?? 0;
  let fitting = -1;
  let lastRound = -1;
  for (let index = blocks.length - 1; index > 0; index--) {
    tailBytes += serializedBytes(blocks[index]) + 1;
    if (rows) tailRows += estimateBlockRows(blocks[index]!, rows.cols);
    if (blocks[index]!.type === "tool_result" || blocks[index - 1]!.type !== "tool_result") continue;
    if (lastRound < 0) lastRound = index;
    if (tailBytes > remaining) break;
    fitting = index;
    if (rows && tailRows >= rows.needed) return index;
  }
  if (rows?.wholeFits) return 0;
  if (fitting > 0) return fitting;
  if (!required) return -1;
  return lastRound > 0 ? lastRound : 0;
}

/**
 * Select a history window walking backward from an end cursor. Entries are
 * taken whole until `turns` user turns are included, the estimated rendered
 * rows reach the row target, or, with a byte budget, the next entry would
 * overflow it. An AI entry that overflows either limit is cut at a round
 * boundary so long agent turns page the same way as many short turns. The
 * window always includes something when a candidate exists.
 *
 * `candidates` must be in descending index order starting at the entry at
 * `endIndex` when `endBlockIndex` is nonzero, else at `endIndex - 1`.
 */
export function selectHistoryWindow(
  candidates: Iterable<HistoryWindowCandidate>,
  turns: number,
  endIndex: number,
  endBlockIndex = 0,
  limits: HistoryWindowLimits = {},
): HistoryWindow {
  const { byteBudget, rowTarget, optionalImagePayloads } = limits;
  const safeTurns = Math.max(1, Math.floor(Number.isFinite(turns) ? turns : 1));
  const selected: DisplayEntry[] = [];
  /** Entries whose image payloads were set aside, by position in `selected`. */
  const withImages = new Map<number, { entry: DisplayEntry; extraBytes: number }>();
  let startIndex = endIndex;
  let startBlockIndex = endBlockIndex;
  let usedBytes = 0;
  let usedRows = 0;
  let userEntries = 0;
  for (const candidate of candidates) {
    let entry = endBlockIndex > 0 && candidate.index === endIndex && candidate.entry.type === "ai"
      ? sliceAIEntry(candidate.entry, 0, endBlockIndex)
      : candidate.entry;
    let bytes = entry !== candidate.entry || candidate.bytes === undefined ? serializedBytes(entry) : candidate.bytes;
    if (optionalImagePayloads && entry.type === "user" && hasImagePayload(entry)) {
      const full = entry;
      const fullBytes = bytes;
      entry = withoutImagePayloads(entry);
      bytes = serializedBytes(entry);
      withImages.set(selected.length, { entry: full, extraBytes: fullBytes - bytes });
    }
    const rowsNeeded = rowTarget ? rowTarget.rows - usedRows : undefined;
    const overBytes = byteBudget !== undefined && usedBytes + bytes > byteBudget;
    const entryRows = rowTarget ? estimateEntryRows(entry, rowTarget.cols) : 0;
    if (overBytes || (entry.type === "ai" && rowsNeeded !== undefined && entryRows > rowsNeeded)) {
      if (entry.type !== "ai") {
        if (selected.length > 0) break;
      } else {
        const tailStart = aiTailStart(
          entry.blocks,
          byteBudget === undefined ? Number.POSITIVE_INFINITY : byteBudget - usedBytes,
          selected.length === 0,
          rowsNeeded === undefined ? undefined : { needed: rowsNeeded, cols: rowTarget!.cols, wholeFits: !overBytes, chrome: aiEntryChromeRows(entry) },
        );
        if (tailStart < 0) break;
        if (tailStart > 0) {
          const tail = sliceAIEntry(entry, tailStart);
          selected.push(tail);
          usedBytes += serializedBytes(tail);
          startIndex = candidate.index;
          startBlockIndex = tailStart;
          break;
        }
      }
    }
    selected.push(entry);
    usedBytes += bytes;
    usedRows += entryRows;
    startIndex = candidate.index;
    startBlockIndex = 0;
    if (entry.type === "user" && ++userEntries >= safeTurns) break;
    if (rowTarget && usedRows >= rowTarget.rows) break;
  }
  // Newest first, restore the image payloads that still fit.
  for (const [position, { entry, extraBytes }] of withImages) {
    if (position >= selected.length || selected[position]!.type !== "user") continue;
    if (byteBudget !== undefined && usedBytes + extraBytes > byteBudget) continue;
    selected[position] = entry;
    usedBytes += extraBytes;
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
  const window = selectHistoryWindow(candidates(), turns, endIndex, endBlockIndex, pageWindowLimits(options));

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
  const window = selectHistoryWindow(candidates(), Number.MAX_SAFE_INTEGER, pageStart + pageEntries.length, 0, { byteBudget });
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
  ...(image.imageId ? { imageId: image.imageId } : {}),
  ...(image.width ? { width: image.width, height: image.height } : {}),
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
