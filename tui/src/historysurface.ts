/** Shared adapter for Vim navigation over chat history and the BTW history card. */

import type { MessageBound, RenderLineAnchor } from "./conversation";
import type { HistoryCursor } from "./historycursor";
import type { RenderState } from "./state";
import type { WrapCopyLine } from "./textwrap";
import { getViewStartFor } from "./chatscroll";

export interface HistorySurface {
  kind: "chat" | "btw";
  lines: string[];
  wrapContinuation: boolean[];
  wrapJoiners: string[];
  copyLines: Array<WrapCopyLine | null>;
  messageBounds: MessageBound[];
  lineAnchors: RenderLineAnchor[];
  cursor: HistoryCursor;
  setCursor(cursor: HistoryCursor): void;
  curswant: number | null;
  setCurswant(value: number | null): void;
  visualAnchor: HistoryCursor;
  setVisualAnchor(cursor: HistoryCursor): void;
  viewportHeight: number;
  scrollOffset: number;
  setScrollOffset(value: number): void;
}

export function isBtwHistoryFocused(state: RenderState): boolean {
  return state.panelFocus === "chat" && state.chatFocus === "btw" && state.btw !== null;
}

export function isAnyHistoryFocused(state: RenderState): boolean {
  return state.panelFocus === "chat"
    && (state.chatFocus === "history" || isBtwHistoryFocused(state));
}

/** Resolve the currently focused history-like document. */
export function activeHistorySurface(state: RenderState): HistorySurface {
  const btw = isBtwHistoryFocused(state) ? state.btw : null;
  if (btw) {
    return {
      kind: "btw",
      lines: btw.historyLines,
      wrapContinuation: btw.historyWrapContinuation,
      wrapJoiners: btw.historyWrapJoiners,
      copyLines: btw.historyCopyLines,
      messageBounds: btw.historyMessageBounds,
      lineAnchors: btw.historyLineAnchors,
      cursor: btw.historyCursor,
      setCursor: cursor => { btw.historyCursor = cursor; },
      curswant: btw.historyCurswant,
      setCurswant: value => { btw.historyCurswant = value; },
      visualAnchor: btw.historyVisualAnchor,
      setVisualAnchor: cursor => { btw.historyVisualAnchor = cursor; },
      viewportHeight: btw.viewportRows,
      scrollOffset: btw.scrollOffset,
      setScrollOffset: value => { btw.scrollOffset = value; },
    };
  }

  return {
    kind: "chat",
    lines: state.historyLines,
    wrapContinuation: state.historyWrapContinuation,
    wrapJoiners: state.historyWrapJoiners,
    copyLines: state.historyCopyLines,
    messageBounds: state.historyMessageBounds,
    lineAnchors: state.historyLineAnchors,
    cursor: state.historyCursor,
    setCursor: cursor => { state.historyCursor = cursor; },
    curswant: state.historyCurswant,
    setCurswant: value => { state.historyCurswant = value; },
    visualAnchor: state.historyVisualAnchor,
    setVisualAnchor: cursor => { state.historyVisualAnchor = cursor; },
    viewportHeight: state.layout.messageAreaHeight,
    scrollOffset: state.scrollOffset,
    setScrollOffset: value => { state.scrollOffset = value; },
  };
}

export function historySurfaceViewStart(surface: HistorySurface): number {
  return getViewStartFor(surface.lines.length, surface.viewportHeight, surface.scrollOffset);
}
