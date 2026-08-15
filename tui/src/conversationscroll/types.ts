export type StreamingResponseAutoscrollMode = "following" | "anchored" | "dismissed";

/** Ephemeral follow/hold state for one currently-streaming final text block. */
export interface StreamingResponseAutoscrollState {
  responseId: string;
  mode: StreamingResponseAutoscrollMode;
  /** Offset applied by the policy on its previous rendered frame. */
  lastScrollOffset: number;
}

export interface PendingConversationOpen {
  convId: string;
  unreadAtOpen: boolean;
}

export interface PendingConversationScrollRestore {
  convId: string;
  mode: "unread-response" | "percentage";
  percentage?: number;
  /** Percentage restoration waits for the normal five-to-fifteen-turn backfill. */
  waitForInitialBackfill: boolean;
}

/** All TUI-only state owned by conversation viewport restoration/autoscroll. */
export interface ConversationScrollState {
  /** Top-based viewport percentage per conversation: 0 = top, 1 = bottom. */
  positions: Map<string, number>;
  pendingOpen: PendingConversationOpen | null;
  pendingRestore: PendingConversationScrollRestore | null;
  streamingResponse: StreamingResponseAutoscrollState | null;
}

export function createConversationScrollState(): ConversationScrollState {
  return {
    positions: new Map(),
    pendingOpen: null,
    pendingRestore: null,
    streamingResponse: null,
  };
}
