export type StreamingResponseAutoscrollMode = "following" | "anchored" | "dismissed";

/** Ephemeral follow/hold state for one currently-streaming final text block. */
export interface StreamingResponseAutoscrollState {
  responseId: string;
  mode: StreamingResponseAutoscrollMode;
  /** Offset applied by the policy on its previous rendered frame. */
  lastScrollOffset: number;
}

/** Completed/open-response placement retained while its layout settles. */
export interface FinalResponseViewportState {
  convId: string | null;
  owner: object;
  /** Follow the bottom while it fits; preserve its exact visual top on overflow. */
  mode: "following" | "anchored";
  /** Offset applied by the policy on its previous rendered frame. */
  lastScrollOffset: number;
}

export interface PendingConversationOpen {
  convId: string;
  unreadAtOpen: boolean;
}

/**
 * Where the reader was: the top row as an offset from the first row of a
 * prompt, named by its index among all the conversation's prompts. Unlike a
 * row count or a share of the loaded rows, it means the same place in any
 * window that includes that prompt, however many older pages were loaded.
 */
export interface ConversationScrollAnchor {
  userIndex: number;
  rowOffset: number;
}

/** A top-based percentage (1 = following the bottom) or a prompt anchor. */
export type ConversationScrollPosition = number | ConversationScrollAnchor;

export interface PendingConversationScrollRestore {
  convId: string;
  mode: "unread-response" | "percentage" | "anchor";
  percentage?: number;
  anchor?: ConversationScrollAnchor;
  /**
   * Restoration waits for the normal five-to-fifteen-turn backfill; an anchor
   * also waits for older pages until its prompt is loaded.
   */
  waitForInitialBackfill: boolean;
}

/** All TUI-only state owned by conversation viewport restoration/autoscroll. */
export interface ConversationScrollState {
  /** Saved viewport per conversation. */
  positions: Map<string, ConversationScrollPosition>;
  pendingOpen: PendingConversationOpen | null;
  pendingRestore: PendingConversationScrollRestore | null;
  streamingResponse: StreamingResponseAutoscrollState | null;
  finalResponseViewport: FinalResponseViewportState | null;
}

export function createConversationScrollState(): ConversationScrollState {
  return {
    positions: new Map(),
    pendingOpen: null,
    pendingRestore: null,
    streamingResponse: null,
    finalResponseViewport: null,
  };
}
