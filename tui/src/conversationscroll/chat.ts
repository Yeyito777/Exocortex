import type { MessageBound, RenderLineAnchor } from "../conversation";
import { getScrollOffsetForViewStart } from "../chatscroll";
import type { RenderState } from "../state";
import { scrollOffsetForPercentage } from "./position";
import { updateStreamingResponseAutoscroll } from "./response";

interface RenderedTextRows {
  start: number;
  end: number;
}

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
export function latestAssistantFinalTextRows(
  lineAnchors: RenderLineAnchor[],
  messageBounds: MessageBound[],
): RenderedTextRows | null {
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
    if (finalOwner) return textRowsForOwner(lineAnchors, finalOwner, bound.contentStart, bound.contentEnd);
  }
  return null;
}

function applyPendingOpenRestore(
  state: RenderState,
  lineAnchors: RenderLineAnchor[],
  messageBounds: MessageBound[],
  totalLines: number,
  viewportHeight: number,
): void {
  const pending = state.conversationScroll.pendingRestore;
  if (!pending || pending.convId !== state.convId || pending.waitForInitialBackfill || viewportHeight <= 0) return;

  if (pending.mode === "unread-response") {
    const response = latestAssistantFinalTextRows(lineAnchors, messageBounds);
    state.scrollOffset = response && response.end - response.start > viewportHeight
      ? getScrollOffsetForViewStart(totalLines, viewportHeight, response.start)
      : 0;
  } else {
    state.scrollOffset = scrollOffsetForPercentage(
      totalLines,
      viewportHeight,
      pending.percentage ?? 1,
    );
  }
  state.conversationScroll.pendingRestore = null;
}

/** Apply open-time restoration and live final-response follow/hold behavior. */
export function applyChatConversationScroll(
  state: RenderState,
  lineAnchors: RenderLineAnchor[],
  messageBounds: MessageBound[],
  totalLines: number,
  viewportHeight: number,
  previousScrollOffset: number,
): void {
  applyPendingOpenRestore(state, lineAnchors, messageBounds, totalLines, viewportHeight);

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
  const update = updateStreamingResponseAutoscroll({
    state: state.conversationScroll.streamingResponse,
    responseId,
    responseStart: response?.start ?? -1,
    responseEnd: response?.end ?? -1,
    previousScrollOffset,
    scrollOffset: state.scrollOffset,
    totalLines,
    viewportHeight,
  });
  state.conversationScroll.streamingResponse = update.state;
  state.scrollOffset = update.scrollOffset;
}
