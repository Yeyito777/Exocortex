import type { Block, ConversationBtw, ModelId, ProviderId } from "../messages";
import type { MessageBound, RenderLineAnchor } from "../conversation";
import type { HistoryCursor } from "../historycursor";
import type { WrapCopyLine } from "../textwrap";
import type { StreamingResponseAutoscrollState } from "../conversationscroll/types";

/** TUI-only projection of the durable conversation-owned BTW state. */
export interface BtwPanelState extends Omit<ConversationBtw, "phase" | "blocks"> {
  sourceConvId: string;
  phase: "starting" | "running" | "complete" | "error";
  /** Assistant blocks rendered with the same presentation as normal history. */
  blocks: Block[];
  /** Visual lines above the bottom of the answer viewport. */
  scrollOffset: number;
  /** Shared final-response follow/hold state for the streamed BTW answer. */
  streamingResponseAutoscroll: StreamingResponseAutoscrollState | null;
  /** Renderer-populated bounds used by foreground scrolling keys. */
  maxScroll: number;
  viewportRows: number;
  /** Normal history-navigation projection used while Ctrl+N focuses this card. */
  historyCursor: HistoryCursor;
  historyCurswant: number | null;
  historyVisualAnchor: HistoryCursor;
  historyLines: string[];
  historyWrapContinuation: boolean[];
  historyWrapJoiners: string[];
  historyCopyLines: Array<WrapCopyLine | null>;
  historyMessageBounds: MessageBound[];
  historyLineAnchors: RenderLineAnchor[];
}

const navigationState = () => ({
  historyCursor: { row: 0, col: 0 },
  historyCurswant: null,
  historyVisualAnchor: { row: 0, col: 0 },
  historyLines: [],
  historyWrapContinuation: [],
  historyWrapJoiners: [],
  historyCopyLines: [],
  historyMessageBounds: [],
  historyLineAnchors: [],
});

export function projectConversationBtw(
  convId: string,
  btw: ConversationBtw | null | undefined,
): BtwPanelState | null {
  if (!btw) return null;
  return {
    ...btw,
    blocks: structuredClone(btw.blocks ?? (btw.text ? [{ type: "text" as const, text: btw.text }] : [])),
    sourceConvId: convId,
    scrollOffset: 0,
    streamingResponseAutoscroll: null,
    maxScroll: 0,
    viewportRows: 1,
    ...navigationState(),
  };
}

export function createStartingBtw(
  sourceConvId: string,
  sessionId: string,
  query: string,
  provider: ProviderId,
  model: ModelId,
  startedAt: number,
): BtwPanelState {
  return {
    sessionId,
    sourceConvId,
    query,
    provider,
    model,
    startedAt,
    endedAt: null,
    phase: "starting",
    blocks: [],
    text: "",
    status: "Starting…",
    scrollOffset: 0,
    streamingResponseAutoscroll: null,
    maxScroll: 0,
    viewportRows: 1,
    ...navigationState(),
  };
}

export function createRunningBtw(
  event: {
    sessionId: string;
    convId: string;
    query: string;
    provider: ProviderId;
    model: ModelId;
    startedAt: number;
  },
): BtwPanelState {
  return {
    sessionId: event.sessionId,
    sourceConvId: event.convId,
    query: event.query,
    provider: event.provider,
    model: event.model,
    startedAt: event.startedAt,
    endedAt: null,
    phase: "running",
    blocks: [],
    text: "",
    status: "Thinking…",
    scrollOffset: 0,
    streamingResponseAutoscroll: null,
    maxScroll: 0,
    viewportRows: 1,
    ...navigationState(),
  };
}
