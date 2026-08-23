import type { BtwPanelState } from "../btw/state";
import { updateStreamingResponseAutoscroll } from "./response";

/** Apply the shared final-response follow/hold policy to the `/btw` viewport. */
export function applyBtwConversationScroll(
  btw: BtwPanelState,
  finalTextRows: { start: number; end: number } | null,
  previousScrollOffset: number,
  totalLines: number,
  viewportHeight: number,
  maxScroll: number,
): void {
  const activeFinalTextRows = btw.phase === "running" ? finalTextRows : null;
  const responseId = activeFinalTextRows
    ? `${btw.sourceConvId}:${btw.sessionId}:${btw.turns.at(-1)?.id ?? "legacy"}:${btw.blocks.length > 0 ? btw.blocks.length - 1 : "legacy"}`
    : null;
  const autoscroll = updateStreamingResponseAutoscroll({
    state: btw.streamingResponseAutoscroll,
    responseId,
    responseStart: activeFinalTextRows?.start ?? -1,
    responseEnd: activeFinalTextRows?.end ?? -1,
    previousScrollOffset,
    scrollOffset: btw.scrollOffset,
    totalLines,
    viewportHeight,
  });
  btw.streamingResponseAutoscroll = autoscroll.state;
  btw.scrollOffset = Math.max(0, Math.min(autoscroll.scrollOffset, maxScroll));
}
