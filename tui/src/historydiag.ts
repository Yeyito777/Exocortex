/**
 * Warnings for history navigation that stops short of where it was sent:
 * gg waiting on older history no request is fetching, an older page dropped
 * on arrival, the cursor drawn off screen. Rate-limited; written to the TUI
 * log with the window's cursors so a report can be matched to the daemon's
 * requests (Nov 7: gg stopped a few rows below the first message over /ssh).
 */
import { getViewStart } from "./chatscroll";
import { log } from "./log";
import type { RenderState } from "./state";

const MIN_INTERVAL_MS = 1_000;
const lastLoggedAt = new Map<string, number>();

export function historyNavigationSnapshot(state: RenderState, now = Date.now()): Record<string, unknown> {
  const shown = state.layout.historyViewportRows.flatMap(row => row ? [row.lineIndex] : []);
  const provisional = state.provisionalOpen;
  return {
    convId: state.convId,
    focus: `${state.panelFocus}/${state.chatFocus}`,
    cursorRow: state.historyCursor.row,
    viewStart: getViewStart(state),
    shownRows: shown.length ? [shown[0], shown.at(-1)] : null,
    scrollOffset: state.scrollOffset,
    totalLines: state.layout.totalLines,
    historyLines: state.historyLines.length,
    height: state.layout.messageAreaHeight,
    messages: state.messages.length,
    startIndex: state.historyStartIndex,
    startBlockIndex: state.historyStartBlockIndex,
    hasOlder: state.historyHasOlder,
    loadingOlder: state.historyLoadingOlder,
    loadingRequestId: state.historyLoadingRequestId,
    loadingAgeMs: state.historyLoadingStartedAt === null ? null : now - state.historyLoadingStartedAt,
    pendingNavigation: state.pendingHistoryNavigation,
    provisional: provisional ? { convId: provisional.convId, current: provisional.current, confirmed: provisional.confirmed !== null, ageMs: now - provisional.paintedAt } : null,
    deferredRender: state.deferredHistoryRender ? { complete: state.deferredHistoryRender.complete, startMessageIndex: state.deferredHistoryRender.startMessageIndex } : null,
  };
}

export function logHistoryNavigation(reason: string, state: RenderState, extra: Record<string, unknown> = {}, now = Date.now()): boolean {
  const last = lastLoggedAt.get(reason) ?? 0;
  if (now - last < MIN_INTERVAL_MS) return false;
  lastLoggedAt.set(reason, now);
  log("warn", `tui: history navigation ${reason} ${JSON.stringify({ ...historyNavigationSnapshot(state, now), ...extra })}`);
  return true;
}

/** How long an older page may be in flight before a waiting gg/{/[ is worth a warning. */
export const SLOW_OLDER_PAGE_MS = 3_000;

/** A pending jump (gg, {, [) that no older-page request can move forward. */
export function noteStalledHistoryNavigation(state: RenderState, why: string, now = Date.now()): void {
  if (!state.pendingHistoryNavigation) return;
  if (why === "in-flight" && (state.historyLoadingStartedAt === null || now - state.historyLoadingStartedAt < SLOW_OLDER_PAGE_MS)) return;
  logHistoryNavigation("waits on older history that is not being fetched", state, { why }, now);
}

/** After a frame: the focused history cursor's row is not among the rows drawn. */
export function noteCursorOffScreen(state: RenderState, now = Date.now()): void {
  if (state.panelFocus !== "chat" || state.chatFocus !== "history" || state.historyLines.length === 0) return;
  const row = state.historyCursor.row;
  if (state.layout.historyViewportRows.some(viewportRow => viewportRow?.lineIndex === row)) return;
  logHistoryNavigation("cursor drawn off screen", state, {}, now);
}
