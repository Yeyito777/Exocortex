/**
 * Opening a conversation from its on-disk copy (viewcache.ts) over /ssh.
 *
 * The copy paints at once, as if the daemon had answered, and the open's real
 * request goes out as before. Its answer then either matches what is on
 * screen (the usual case: only metadata is applied, nothing is redrawn) or
 * replaces it like an open landing, placed as that open would have been
 * unless the reader has already moved. A copy not known to be current is
 * marked as updating (topbar.ts) if that takes longer than a moment.
 */

import type { ConversationSummary } from "./messages";
import type { Event } from "./protocol";
import type { RenderState } from "./state";
import type { PendingConversationOpen } from "./conversationscroll/types";
import type { CachedView, HistoryPageEvent, LoadedEvent } from "./viewcache";
import { applyLoadedMetadata } from "./events/conversations";
import { markRelayout } from "./smoothscroll";

export interface ProvisionalOpen {
  convId: string;
  /** The real open's request: its answer confirms or replaces this view. */
  reqId: string;
  /** Known current when painted (its revision is the daemon's latest): never marked. */
  current: boolean;
  /** When it was painted: a stale copy is marked once STALE_COPY_MARK_DELAY_MS have passed. */
  paintedAt: number;
  /** pageKey of the painted opening page and backfill. */
  loadedKey: string;
  backfillKey: string | null;
  /** The request id the painted backfill pretended to answer. */
  cachedBackfillReqId: string | null;
  /** The open's placement intent, for an answer that replaces the view before the reader moves. */
  intent: PendingConversationOpen | null;
  scrollOffset: number;
  /** A matching answer whose backfill is still to compare. */
  confirmed: { loaded: LoadedEvent; backfillReqId: string } | null;
}

/** Everything a page shows: its entries and where it sits in the history. */
export function pageKey(event: Pick<LoadedEvent | HistoryPageEvent, "entries" | "historyStartIndex" | "historyStartBlockIndex" | "historyStartUserIndex" | "historyTotalEntries" | "hasOlderHistory"> & { historyEndIndex?: number; historyEndBlockIndex?: number }): string {
  return JSON.stringify([
    event.historyStartIndex ?? 0, event.historyStartBlockIndex ?? 0, event.historyStartUserIndex ?? 0,
    event.historyEndIndex ?? null, event.historyEndBlockIndex ?? 0,
    event.historyTotalEntries ?? null, event.hasOlderHistory ?? false,
    event.entries,
  ]);
}

/**
 * The events a cached view stands for, as answers to `reqId`. The sidebar's
 * summary is newer than the copy for the model, effort and goal, so it wins.
 */
export function cachedOpenEvents(
  view: CachedView,
  reqId: string,
  summary: ConversationSummary | undefined,
): { loaded: LoadedEvent; backfill: HistoryPageEvent | null } {
  const backfillReqId = view.backfill && view.loaded.hasOlderHistory ? `cached_${reqId}` : null;
  const loaded: LoadedEvent = {
    ...view.loaded,
    reqId,
    ...(backfillReqId ? { initialBackfillReqId: backfillReqId } : {}),
    ...(summary ? {
      provider: summary.provider, model: summary.model, effort: summary.effort, fastMode: summary.fastMode, goal: summary.goal ?? null,
    } : {}),
  };
  const backfill = backfillReqId ? { ...view.backfill!, reqId: backfillReqId, requestSource: "initial-backfill" as const } : null;
  return { loaded, backfill };
}

export function beginProvisionalOpen(state: RenderState, view: CachedView, reqId: string, current: boolean, backfillReqId: string | null): void {
  state.provisionalOpen = {
    convId: view.convId,
    reqId,
    current,
    paintedAt: Date.now(),
    loadedKey: pageKey(view.loaded),
    backfillKey: view.backfill ? pageKey(view.backfill) : null,
    cachedBackfillReqId: backfillReqId,
    intent: state.conversationScroll.pendingOpen ? { ...state.conversationScroll.pendingOpen } : null,
    scrollOffset: 0,
    confirmed: null,
  };
}

/** After the cached view's first layout: where the reader is, to tell whether they moved. */
export function noteProvisionalPlacement(state: RenderState): void {
  if (state.provisionalOpen) state.provisionalOpen.scrollOffset = state.scrollOffset;
}

export type ProvisionalOutcome =
  /** Not this view's business: handle it as usual. */
  | { kind: "pass" }
  /** The answer matched the view: nothing more to apply. */
  | { kind: "confirmed"; done: boolean; wasStale: boolean }
  /** The view is gone: handle these events (the answer) as usual instead. */
  | { kind: "replace"; events: Event[] };

/**
 * Compare an event with the provisional view it may answer. Called before
 * the event is handled; clears state.provisionalOpen once settled.
 */
export function reconcileProvisionalOpen(state: RenderState, event: Event): ProvisionalOutcome {
  const provisional = state.provisionalOpen;
  if (!provisional) return { kind: "pass" };
  if (provisional.convId !== state.convId) {
    state.provisionalOpen = null;
    return { kind: "pass" };
  }
  if (event.type === "conversation_loaded" && event.reqId === provisional.reqId && !provisional.confirmed) {
    const matches = event.convId === provisional.convId && !event.pendingAI
      && Boolean(event.initialBackfillReqId) === (provisional.backfillKey !== null)
      && pageKey(event) === provisional.loadedKey;
    if (!matches) return replace(state, provisional, [event]);
    applyLoadedMetadata(state, event);
    const wasStale = !provisional.current;
    provisional.current = true;
    if (event.initialBackfillReqId) {
      provisional.confirmed = { loaded: event, backfillReqId: event.initialBackfillReqId };
      return { kind: "confirmed", done: false, wasStale };
    }
    state.provisionalOpen = null;
    return { kind: "confirmed", done: true, wasStale };
  }
  if (event.type === "conversation_history_loaded" && provisional.confirmed
      && event.reqId === provisional.confirmed.backfillReqId) {
    // Older history changed under an unchanged opening page: apply the answer whole.
    if (event.convId !== provisional.convId || pageKey(event) !== provisional.backfillKey) {
      return replace(state, provisional, [provisional.confirmed.loaded, event]);
    }
    state.provisionalOpen = null;
    return { kind: "confirmed", done: true, wasStale: false };
  }
  if (event.type === "error" && (event.reqId === provisional.reqId || event.reqId === provisional.confirmed?.backfillReqId)) {
    // A deleted conversation's list update clears the view; a failed backfill keeps the confirmed page.
    state.provisionalOpen = null;
  }
  return { kind: "pass" };
}

function replace(state: RenderState, provisional: ProvisionalOpen, events: Event[]): ProvisionalOutcome {
  state.provisionalOpen = null;
  const moved = state.scrollOffset !== provisional.scrollOffset || state.pendingHistoryNavigation !== null
    || (state.panelFocus === "chat" && state.chatFocus === "history");
  if (!moved) {
    // Land like the open it answers: placed by that open's intent (unread
    // response, saved position), the copy staying up until it can paint.
    state.conversationLoading = { convId: provisional.convId, startedAt: Date.now() };
    state.conversationScroll.pendingOpen = provisional.intent;
  }
  // Newer content under a bottom anchor snaps; it is not output arriving.
  markRelayout(state);
  return { kind: "replace", events };
}
