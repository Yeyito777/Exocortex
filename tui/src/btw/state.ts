import type { Block, ConversationBtw, ConversationBtwTurn, ModelId, ProviderId } from "../messages";
import type { MessageBound, RenderLineAnchor } from "../conversation";
import type { HistoryCursor } from "../historycursor";
import type { WrapCopyLine } from "../textwrap";
import type { StreamingResponseAutoscrollState } from "../conversationscroll/types";

/** TUI-only projection of the durable conversation-owned BTW state. */
export interface BtwPanelState extends Omit<ConversationBtw, "phase" | "blocks" | "turns"> {
  sourceConvId: string;
  phase: "starting" | "running" | "complete" | "error";
  /** Assistant blocks rendered with the same presentation as normal history. */
  blocks: Block[];
  /** Complete question/answer history in this retained panel. */
  turns: ConversationBtwTurn[];
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

function clonedTurn(turn: ConversationBtwTurn): ConversationBtwTurn {
  return {
    ...turn,
    blocks: structuredClone(turn.blocks ?? (turn.text ? [{ type: "text" as const, text: turn.text }] : [])),
  };
}

export function panelTurns(btw: Pick<ConversationBtw, "sessionId" | "query" | "startedAt" | "endedAt" | "phase" | "blocks" | "text" | "status" | "turns">): ConversationBtwTurn[] {
  if (btw.turns?.length) return btw.turns.map(clonedTurn);
  return [clonedTurn({
    id: btw.sessionId,
    query: btw.query,
    startedAt: btw.startedAt,
    endedAt: btw.endedAt,
    phase: btw.phase,
    blocks: btw.blocks,
    text: btw.text,
    status: btw.status,
  })];
}

export function projectConversationBtw(
  convId: string,
  btw: ConversationBtw | null | undefined,
): BtwPanelState | null {
  if (!btw) return null;
  const turns = panelTurns(btw);
  return {
    ...btw,
    blocks: structuredClone(btw.blocks ?? (btw.text ? [{ type: "text" as const, text: btw.text }] : [])),
    turns,
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
  const turn: ConversationBtwTurn = {
    id: sessionId,
    query,
    startedAt,
    endedAt: null,
    phase: "running",
    blocks: [],
    text: "",
    status: "Starting…",
  };
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
    turns: [turn],
    text: "",
    status: "Starting…",
    scrollOffset: 0,
    streamingResponseAutoscroll: null,
    maxScroll: 0,
    viewportRows: 1,
    ...navigationState(),
  };
}

/** Optimistically append a follow-up while retaining panel identity and history. */
export function appendStartingBtwFollowup(
  btw: BtwPanelState,
  turnId: string,
  query: string,
  startedAt: number,
): void {
  const turn: ConversationBtwTurn = {
    id: turnId,
    query,
    startedAt,
    endedAt: null,
    phase: "running",
    blocks: [],
    text: "",
    status: "Starting…",
  };
  btw.turns.push(turn);
  btw.query = query;
  btw.startedAt = startedAt;
  btw.endedAt = null;
  btw.phase = "starting";
  btw.blocks = turn.blocks!;
  btw.text = "";
  btw.status = "Starting…";
  btw.streamingResponseAutoscroll = null;
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
  const turn: ConversationBtwTurn = {
    id: event.sessionId,
    query: event.query,
    startedAt: event.startedAt,
    endedAt: null,
    phase: "running",
    blocks: [],
    text: "",
    status: "Thinking…",
  };
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
    turns: [turn],
    text: "",
    status: "Thinking…",
    scrollOffset: 0,
    streamingResponseAutoscroll: null,
    maxScroll: 0,
    viewportRows: 1,
    ...navigationState(),
  };
}
