import type { DisplayEntry } from "./display";
import type { ConversationRenderSnapshot } from "./conversations";
import type { HistoryUpdatedEvent } from "./protocol";
import type { ImageAttachment } from "./messages";

export const INITIAL_HISTORY_TURNS = 5;
export const BUFFERED_HISTORY_TURNS = 15;
const RECENT_HISTORY_IMAGE_PAYLOAD_ENTRIES = 8;

export interface DisplayHistoryPage {
  /** Conversation/folder instructions stay pinned above every paged history window. */
  pinnedEntries: DisplayEntry[];
  entries: DisplayEntry[];
  startIndex: number;
  startUserIndex: number;
  endIndex: number;
  totalEntries: number;
  hasOlder: boolean;
}

/**
 * Slice display history on user-turn boundaries.
 *
 * The absolute cursor addresses entries after system instructions have been
 * removed. That keeps the cursor stable while instructions remain pinned at the
 * top of every initial/canonical payload.
 */
export function pageDisplayHistory(
  allEntries: DisplayEntry[],
  turns: number,
  beforeEntryIndex?: number,
): DisplayHistoryPage {
  const pinnedEntries = allEntries.filter((entry) => entry.type === "system_instructions");
  const historyEntries = allEntries.filter((entry) => entry.type !== "system_instructions");
  const safeTurns = Math.max(1, Math.floor(Number.isFinite(turns) ? turns : 1));
  const endIndex = Math.max(0, Math.min(
    beforeEntryIndex === undefined ? historyEntries.length : Math.floor(beforeEntryIndex),
    historyEntries.length,
  ));

  let startIndex = 0;
  let seenTurns = 0;
  for (let index = endIndex - 1; index >= 0; index--) {
    if (historyEntries[index]?.type !== "user") continue;
    seenTurns += 1;
    if (seenTurns === safeTurns) {
      startIndex = index;
      break;
    }
  }

  return {
    pinnedEntries,
    entries: historyEntries.slice(startIndex, endIndex),
    startIndex,
    startUserIndex: historyEntries.slice(0, startIndex).filter((entry) => entry.type === "user").length,
    endIndex,
    totalEntries: historyEntries.length,
    hasOlder: startIndex > 0,
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
