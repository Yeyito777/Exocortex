import { getViewStart } from "./chatscroll";
import type { Message } from "./messages";
import type { RenderState } from "./state";

export const INITIAL_BUFFER_ADDITIONAL_TURNS = 10;
export const OLDER_HISTORY_PAGE_TURNS = 15;
/** Daemons reject history requests outside 1..100 turns. */
export const MAX_HISTORY_REQUEST_TURNS = 100;
/** Rows of the shortest ordinary turn: prompt, reply, metadata and a gap. */
const MIN_RENDERED_TURN_ROWS = 4;
/** Coarse steps keep the transport cache key stable across small resizes. */
const OPENING_TURNS_STEP = 5;
/**
 * Longest the first paint of an opening window waits for older history when
 * that window cannot fill the screen (e.g. byte-budgeted tool-heavy turns).
 */
export const OPENING_FILL_HOLD_MS = 300;
/**
 * The same cap over /ssh, where the backfill needs a network round trip plus
 * up to a byte-budgeted page on the wire: 300 ms is less than that on a
 * ~100 ms link, so the partial window used to flash before older rows arrived.
 */
export const REMOTE_OPENING_FILL_HOLD_MS = 1500;

/** How long an opening window may wait for its backfill on this transport. */
export function openingFillHoldMs(remote: boolean): number {
  return remote ? REMOTE_OPENING_FILL_HOLD_MS : OPENING_FILL_HOLD_MS;
}

/**
 * Turns to request when opening a conversation: enough for a screen of the
 * shortest turns, so the first paint fills the viewport in one round trip.
 * The daemon's byte budget still bounds what long tool-heavy turns transfer.
 */
export function openingHistoryTurns(terminalRows: number): number {
  const rows = Number.isFinite(terminalRows) ? Math.max(1, terminalRows) : 24;
  const turns = Math.ceil(rows / MIN_RENDERED_TURN_ROWS / OPENING_TURNS_STEP) * OPENING_TURNS_STEP;
  return Math.min(MAX_HISTORY_REQUEST_TURNS, Math.max(OPENING_TURNS_STEP, turns));
}

/** Rows of the screen around history (title, prompt, status) before the first layout. */
const NON_HISTORY_ROWS = 6;
/** The daemon's accepted viewport range. */
const MAX_VIEWPORT_ROWS = 1000;
const MAX_VIEWPORT_COLS = 4000;

/**
 * History viewport sent with an open, so the daemon can size the opening
 * window to fill it (plus a screen of scrollback) in rendered rows. Uses the
 * last layout, or the terminal size before the first one. Columns are the
 * width history is laid out at, not the narrower rows beside a task panel:
 * estimating at that width overstated each turn's rows, so the window came
 * back too short to fill the screen.
 */
export function openingViewport(state: RenderState): { rows: number; cols: number; folded?: boolean } {
  const rows = state.layout.messageAreaHeight > 0 ? state.layout.messageAreaHeight : state.rows - NON_HISTORY_ROWS;
  const cols = state.layout.chatWidth > 0 ? state.layout.chatWidth : state.cols;
  const clamp = (value: number, max: number) => Math.min(max, Math.max(1, Math.floor(Number.isFinite(value) ? value : 1)));
  // Folded turns are a few rows each, so the window needs more of them.
  const folded = !state.showTurnWork && !state.showToolOutput;
  return { rows: clamp(rows, MAX_VIEWPORT_ROWS), cols: clamp(cols, MAX_VIEWPORT_COLS), ...(folded ? { folded } : {}) };
}

/** Start holding presentation of a just-opened window until it fills the screen. */
export function beginOpeningFillHold(state: RenderState, now = Date.now(), holdMs = OPENING_FILL_HOLD_MS): void {
  state.historyOpeningFillUntil = now + holdMs;
}

/**
 * Rows at the top of the rendered window that older history will push away:
 * the pinned system instructions and the older-history spinner below them.
 */
function openingWindowLeadRows(state: RenderState): number {
  const anchors = state.historyLineAnchors;
  let rows = 0;
  while (rows < anchors.length) {
    const segment = anchors[rows]?.segment;
    if (segment !== "history_loading" && !segment?.startsWith("system_instructions_")) break;
    rows++;
  }
  return rows;
}

/**
 * Whether painting the rendered window now would show a partially filled
 * screen, or the top of the window (its pinned system instructions), that
 * older history, already on its way, is about to push down. Ends the hold
 * once a frame may be presented.
 */
export function shouldHoldOpeningFrame(state: RenderState, now = Date.now()): boolean {
  const until = state.historyOpeningFillUntil;
  if (until === null) return false;
  if (now < until && hasOlderHistoryCursor(state)
      && state.layout.totalLines - openingWindowLeadRows(state) < state.layout.messageAreaHeight) return true;
  state.historyOpeningFillUntil = null;
  return false;
}

export interface OlderHistoryRequest {
  convId: string;
  beforeEntryIndex: number;
  beforeBlockIndex: number;
  turns: number;
}

/** Whether the loaded window's start cursor has anything before it. */
export function hasOlderHistoryCursor(state: RenderState): boolean {
  return state.historyHasOlder && (state.historyStartIndex > 0 || state.historyStartBlockIndex > 0);
}

export function beginOlderHistoryLoad(state: RenderState, turns: number): OlderHistoryRequest | null {
  if (!state.convId || state.historyLoadingOlder || !hasOlderHistoryCursor(state)) return null;
  state.historyLoadingOlder = true;
  state.historyLoadingStartedAt = Date.now();
  return {
    convId: state.convId,
    beforeEntryIndex: state.historyStartIndex,
    beforeBlockIndex: state.historyStartBlockIndex,
    turns,
  };
}

/** Load before the viewport reaches the oldest rendered row. */
export function shouldLoadOlderHistory(state: RenderState): boolean {
  if (!state.convId || state.historyLoadingOlder || !hasOlderHistoryCursor(state)) return false;
  if (state.pendingHistoryNavigation) return true;
  if (state.layout.messageAreaHeight <= 0 || state.layout.totalLines <= 0) return false;
  const thresholdRows = Math.max(3, Math.ceil(state.layout.messageAreaHeight / 2));
  return getViewStart(state) <= thresholdRows;
}

/**
 * A history window may begin inside a long AI entry. When the leading blocks of
 * that entry arrive (as the last message of `older`), join them onto the loaded
 * tail (the first message of `newer`) so every display entry stays one message.
 */
export function joinSplitAssistantEntry(older: Message[], newer: Message[]): void {
  const head = older.at(-1);
  const tail = newer[0];
  if (head?.role !== "assistant" || tail?.role !== "assistant") return;
  older.pop();
  newer[0] = { ...tail, blocks: [...head.blocks, ...tail.blocks] };
}
