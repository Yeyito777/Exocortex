import type { MessageBound, RenderLineAnchor } from "../conversation";
import { getScrollOffsetForViewStart } from "../chatscroll";
import type { RenderState } from "../state";
import { scrollOffsetForPercentage } from "./position";
import { updateStreamingResponseAutoscroll } from "./response";

export interface RenderedTextRows {
  start: number;
  end: number;
}

interface RenderedTextBlockRows extends RenderedTextRows {
  owner: object;
}

export interface ChatConversationScrollUpdate {
  /** Canonical row that viewport composition must keep at visual row zero. */
  topAnchorRow: number | null;
}

type FinalResponseViewportMode = "following" | "anchored";
type MeasureResponseHeight = (startRow: number, endRow: number) => number;

function textRowsForOwner(
  lineAnchors: RenderLineAnchor[],
  owner: object,
  startRow: number,
  endRow: number,
): RenderedTextRows | null {
  let start = -1;
  let end = -1;
  for (let row = startRow; row < endRow; row++) {
    const anchor = lineAnchors[row];
    if (anchor?.owner !== owner || anchor.segment !== "assistant_block") continue;
    if (start === -1) start = row;
    end = row + 1;
  }
  return start >= 0 && end > start ? { start, end } : null;
}

/** Locate the final rendered text block of the latest assistant message. */
function latestAssistantFinalTextBlockRows(
  lineAnchors: RenderLineAnchor[],
  messageBounds: MessageBound[],
): RenderedTextBlockRows | null {
  for (let boundIndex = messageBounds.length - 1; boundIndex >= 0; boundIndex--) {
    const bound = messageBounds[boundIndex];
    if (bound.role !== "assistant") continue;

    let finalOwner: object | null = null;
    for (let row = bound.contentEnd - 1; row >= bound.contentStart; row--) {
      const anchor = lineAnchors[row];
      const owner = anchor?.owner as ({ type?: string } & object) | undefined;
      if (anchor?.segment === "assistant_block" && owner?.type === "text") {
        finalOwner = owner;
        break;
      }
    }
    if (finalOwner) {
      const rows = textRowsForOwner(lineAnchors, finalOwner, bound.contentStart, bound.contentEnd);
      if (rows) return { ...rows, owner: finalOwner };
    }
  }
  return null;
}

export function latestAssistantFinalTextRows(
  lineAnchors: RenderLineAnchor[],
  messageBounds: MessageBound[],
): RenderedTextRows | null {
  const response = latestAssistantFinalTextBlockRows(lineAnchors, messageBounds);
  return response ? { start: response.start, end: response.end } : null;
}

interface PendingOpenRestoreResult {
  handled: boolean;
  response: RenderedTextBlockRows | null;
  mode: FinalResponseViewportMode | null;
}

function responseViewportMode(
  response: RenderedTextRows,
  viewportHeight: number,
  measureResponseHeight: MeasureResponseHeight,
): FinalResponseViewportMode {
  return measureResponseHeight(response.start, response.end) > viewportHeight
    ? "anchored"
    : "following";
}

function applyPendingOpenRestore(
  state: RenderState,
  lineAnchors: RenderLineAnchor[],
  messageBounds: MessageBound[],
  totalLines: number,
  viewportHeight: number,
  measureResponseHeight: MeasureResponseHeight,
): PendingOpenRestoreResult {
  const pending = state.conversationScroll.pendingRestore;
  if (!pending || pending.convId !== state.convId || pending.waitForInitialBackfill || viewportHeight <= 0) {
    return { handled: false, response: null, mode: null };
  }

  let response: RenderedTextBlockRows | null = null;
  let mode: FinalResponseViewportMode | null = null;
  if (pending.mode === "unread-response") {
    response = latestAssistantFinalTextBlockRows(lineAnchors, messageBounds);
    if (response) {
      mode = responseViewportMode(response, viewportHeight, measureResponseHeight);
      state.scrollOffset = mode === "anchored"
        ? getScrollOffsetForViewStart(totalLines, viewportHeight, response.start)
        : 0;
    } else {
      state.scrollOffset = 0;
    }
  } else {
    state.scrollOffset = scrollOffsetForPercentage(
      totalLines,
      viewportHeight,
      pending.percentage ?? 1,
    );
  }
  state.conversationScroll.pendingRestore = null;
  return { handled: true, response, mode };
}

/** Apply open-time restoration and live final-response follow/hold behavior. */
export function applyChatConversationScroll(
  state: RenderState,
  lineAnchors: RenderLineAnchor[],
  messageBounds: MessageBound[],
  totalLines: number,
  viewportHeight: number,
  previousScrollOffset: number,
  measureResponseHeight: MeasureResponseHeight = (start, end) => end - start,
): ChatConversationScrollUpdate {
  let retainedViewport = state.conversationScroll.finalResponseViewport;
  const retainedViewportDismissed = Boolean(retainedViewport && (
    retainedViewport.convId !== state.convId
    || previousScrollOffset !== retainedViewport.lastScrollOffset
  ));
  if (retainedViewportDismissed) retainedViewport = null;

  const previousStreamingState = state.conversationScroll.streamingResponse;
  const restore = applyPendingOpenRestore(
    state,
    lineAnchors,
    messageBounds,
    totalLines,
    viewportHeight,
    measureResponseHeight,
  );

  const pending = state.pendingAI;
  const blockIndex = (pending?.blocks.length ?? 0) - 1;
  const block = blockIndex >= 0 ? pending?.blocks[blockIndex] : null;
  const hasActiveGoal = state.goal?.status === "active";
  const response = pending && block?.type === "text" && !hasActiveGoal
    ? textRowsForOwner(lineAnchors, block, 0, lineAnchors.length)
    : null;
  const logicalBlockIndex = state.pendingAIBlockOffset
    + state.pendingAIPartialCommittedBlocks.length
    + blockIndex;
  const responseId = response && pending
    ? `${state.convId ?? "draft"}:${pending.metadata?.startedAt ?? "unknown"}:${logicalBlockIndex}`
    : null;
  const responseHeight = response
    ? previousStreamingState?.responseId === responseId && previousStreamingState.mode === "anchored"
      ? viewportHeight + 1
      : measureResponseHeight(response.start, response.end)
    : 0;
  const update = updateStreamingResponseAutoscroll({
    state: state.conversationScroll.streamingResponse,
    responseId,
    responseStart: response?.start ?? -1,
    responseEnd: response?.end ?? -1,
    responseHeight,
    previousScrollOffset,
    scrollOffset: state.scrollOffset,
    totalLines,
    viewportHeight,
  });
  state.conversationScroll.streamingResponse = update.state;
  state.scrollOffset = update.scrollOffset;

  let placedResponse: RenderedTextBlockRows | null = null;
  let placementMode: FinalResponseViewportMode | null = null;

  if (pending) {
    // Any in-flight turn supersedes the completed response placement. It earns a
    // retained viewport only while its final text is still being followed.
    if (response && (update.state?.mode === "following" || update.state?.mode === "anchored")) {
      placedResponse = { ...response, owner: block! };
      placementMode = update.state.mode;
    }
  } else if (restore.handled) {
    placedResponse = restore.response;
    placementMode = restore.mode;
  } else {
    const latestResponse = latestAssistantFinalTextBlockRows(lineAnchors, messageBounds);
    if (retainedViewport && latestResponse?.owner === retainedViewport.owner) {
      placedResponse = latestResponse;
      placementMode = retainedViewport.mode === "following"
        ? responseViewportMode(latestResponse, viewportHeight, measureResponseHeight)
        : "anchored";
    } else if (!retainedViewportDismissed
      && latestResponse
      && (previousStreamingState?.mode === "following" || previousStreamingState?.mode === "anchored")
      && previousScrollOffset === previousStreamingState.lastScrollOffset) {
      // message_complete can replace every block object immediately before
      // clearing pendingAI. Transfer the stream placement to canonical history.
      placedResponse = latestResponse;
      placementMode = previousStreamingState.mode === "following"
        ? responseViewportMode(latestResponse, viewportHeight, measureResponseHeight)
        : "anchored";
    }
  }

  if (placedResponse && placementMode) {
    state.scrollOffset = placementMode === "anchored"
      ? getScrollOffsetForViewStart(totalLines, viewportHeight, placedResponse.start)
      : 0;
    state.conversationScroll.finalResponseViewport = {
      convId: state.convId,
      owner: placedResponse.owner,
      mode: placementMode,
      lastScrollOffset: state.scrollOffset,
    };
  } else {
    state.conversationScroll.finalResponseViewport = null;
  }

  return {
    topAnchorRow: placementMode === "anchored" ? placedResponse?.start ?? null : null,
  };
}
