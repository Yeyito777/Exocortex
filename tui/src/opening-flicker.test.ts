import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { beginConversationLoad } from "./events/conversations";
import { handleEvent, type DaemonActions } from "./events";
import { stripAnsi } from "./historycursor";
import {
  beginOlderHistoryLoad,
  beginOpeningFillHold,
  INITIAL_BUFFER_ADDITIONAL_TURNS,
  olderHistoryDue,
  olderHistoryDueAfterLayout,
  openingFillHoldMs,
  openingViewport,
  REMOTE_OPENING_FILL_HOLD_MS,
} from "./historypagination";
import type { ConversationSummary, DisplayEntry, Event } from "./protocol";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";

const daemon: DaemonActions = {
  subscribe() {},
  unsubscribe() {},
  sendMessage() {},
  setSystemInstructions() {},
  loadToolOutputs() {},
};

const CONV = "conv-open";
const OTHER = "conv-other";
const START = Date.UTC(2026, 9, 17, 20, 0, 0);
const INSTRUCTIONS = Array.from({ length: 24 }, (_, i) => `Instruction line ${i}: act with judgment.`).join("\n");

afterEach(() => setSystemTime());

function summary(id: string, withTasks: boolean, state: RenderState): ConversationSummary {
  return {
    id,
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 900,
    title: id,
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: id === CONV ? 0 : 1,
    tasks: withTasks
      ? [{ id: "chrono:1", kind: "chrono", title: "Hourly review", startedAt: START - 60_000, dueAt: START + 3_600_000, chronoMode: "wake" }]
      : [],
  };
}

function shortTurns(count: number, label: string): DisplayEntry[] {
  return Array.from({ length: count }, (_, i): DisplayEntry[] => [
    { type: "user", text: `${label} question ${i}` },
    { type: "ai", blocks: [{ type: "text", text: `${label} answer ${i}` }], metadata: { startedAt: 1, endedAt: 2, model: "claude-opus-5-5", tokens: 3 } },
  ]).flat();
}

/** The rows a presented frame shows in the message area. */
function visibleHistory(state: RenderState): string[] {
  return state.layout.historyViewportRows.map(row => (row ? stripAnsi(state.historyLines[row.lineIndex] ?? "") : ""));
}

const showsInstructions = (frame: string[]) => frame.some(line => line.includes("System Instructions") || line.includes("Instruction line"));

/**
 * Drives a TUI that is showing another conversation through a remote open of a
 * long conversation with pinned instructions, the way main.ts sequences it.
 */
class RemoteOpen {
  readonly state = createInitialState();
  readonly frames: Array<{ at: number; rows: string[] }> = [];
  private now = START;
  private backfillReqId: string | null = null;

  constructor(withTasks: boolean) {
    setSystemTime(new Date(this.now));
    const state = this.state;
    state.rows = 50;
    state.cols = 140;
    state.sidebar.open = false;
    state.sidebar.conversations = [summary(CONV, withTasks, state), summary(OTHER, false, state)];
    // The previous conversation is on screen and has laid out the history area.
    handleEvent(this.loaded(OTHER, shortTurns(30, "other"), false), state, daemon);
    this.paint();
    this.frames.length = 0;
  }

  loaded(convId: string, entries: DisplayEntry[], hasOlderHistory: boolean): Extract<Event, { type: "conversation_loaded" }> {
    return {
      type: "conversation_loaded",
      convId,
      provider: "anthropic",
      model: "claude-opus-5-5",
      effort: "high",
      fastMode: false,
      entries,
      historyStartIndex: hasOlderHistory ? 800 : 0,
      historyStartUserIndex: hasOlderHistory ? 400 : 0,
      historyTotalEntries: 800 + entries.length,
      hasOlderHistory,
      contextTokens: 100,
      toolOutputsIncluded: false,
    };
  }

  advance(ms: number): void {
    this.now += ms;
    setSystemTime(new Date(this.now));
  }

  paint(): boolean {
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    let presented: boolean;
    try {
      presented = render(this.state);
    } finally {
      process.stdout.write = write;
    }
    if (presented) this.frames.push({ at: this.now - START, rows: visibleHistory(this.state) });
    return presented;
  }

  /** openConversation(): placeholder spinner while the request crosses the network. */
  click(): void {
    beginConversationLoad(this.state, CONV, daemon);
    this.paint();
  }

  /** onDaemonEvent(conversation_loaded) in main.ts. */
  receiveOpeningWindow(entries: DisplayEntry[], hasOlderHistory = true): void {
    handleEvent(this.loaded(CONV, entries, hasOlderHistory), this.state, daemon);
    beginOpeningFillHold(this.state, Date.now(), openingFillHoldMs(true));
    this.paint();
    const request = beginOlderHistoryLoad(this.state, INITIAL_BUFFER_ADDITIONAL_TURNS);
    if (request) {
      this.backfillReqId = "history-backfill";
      this.state.historyLoadingRequestId = this.backfillReqId;
    }
    this.paint();
  }

  receive(event: Event): void {
    handleEvent(event, this.state, daemon);
    this.paint();
  }

  receiveBackfill(entries: DisplayEntry[], reqId = this.backfillReqId): void {
    this.receive({
      type: "conversation_history_loaded",
      reqId: reqId ?? undefined,
      convId: CONV,
      requestSource: "initial-backfill",
      entries,
      historyStartIndex: 800 - entries.length,
      historyStartUserIndex: 400 - entries.length / 2,
      historyEndIndex: 800,
      historyTotalEntries: 800 + 3,
      hasOlderHistory: true,
    });
  }

  /** The main.ts hold timer firing at the cap. */
  holdTimerFires(): void {
    this.state.historyOpeningFillUntil = null;
    this.paint();
  }
}

/** Pinned instructions plus a newest turn too short to fill the screen on its own. */
function shortOpeningWindow(): DisplayEntry[] {
  return [{ type: "system_instructions", text: INSTRUCTIONS }, ...shortTurns(4, "newest")];
}

describe("remote conversation open frames", () => {
  for (const withTasks of [false, true]) {
    const scenario = withTasks ? " with a task panel" : "";
    test(`never presents pinned system instructions while a remote conversation opens${scenario}`, () => {
      const open = new RemoteOpen(withTasks);
      open.click();
      // A sidebar update for the opened conversation lands before its history.
      open.advance(60);
      open.receive({ type: "conversation_updated", summary: summary(CONV, withTasks, open.state) });
      open.advance(80);
      open.receiveOpeningWindow(shortOpeningWindow());
      // Instructions render no rows: only the short newest turns are laid out.
      expect(open.state.layout.totalLines).toBeLessThan(open.state.layout.messageAreaHeight);

      // A stale page (from an earlier visit) arrives first and is discarded.
      open.advance(150);
      open.receiveBackfill(shortTurns(40, "stale"), "history-stale");
      // Broadcasts keep repainting while the backfill is still on the wire,
      // well past the local 300 ms hold.
      open.advance(250);
      open.receive({ type: "conversation_updated", summary: summary(CONV, withTasks, open.state) });
      open.advance(600);
      open.paint();
      expect(open.frames.every(frame => !showsInstructions(frame.rows))).toBe(true);

      open.advance(200);
      open.receiveBackfill(shortTurns(40, "older"));
      const final = open.frames.at(-1)!;
      expect(final.at).toBe(1340);
      expect(showsInstructions(final.rows)).toBe(false);
      expect(final.rows.some(line => line.includes("newest answer 3"))).toBe(true);
      // The placeholder spinner stays up until the opening window arrives at
      // 140 ms; from then on the only frame presented is the final view.
      for (const frame of open.frames.filter(frame => frame.at < 140)) {
        expect(frame.rows.join("\n")).toContain("Loading conversation");
      }
      for (const frame of open.frames) expect(showsInstructions(frame.rows)).toBe(false);
      expect(open.frames.filter(frame => frame.at >= 140).map(frame => frame.at)).toEqual([1340]);
    });
  }

  test("presents a whole conversation immediately, without its instructions", () => {
    const open = new RemoteOpen(false);
    open.click();
    open.advance(140);
    open.receiveOpeningWindow(shortOpeningWindow(), false);
    expect(open.frames.at(-1)!.at).toBe(140);
    expect(showsInstructions(open.frames.at(-1)!.rows)).toBe(false);
    expect(open.frames.at(-1)!.rows.some(line => line.includes("newest answer 3"))).toBe(true);
  });

  test("paints the opening window once the remote hold cap expires without a backfill", () => {
    const open = new RemoteOpen(false);
    open.click();
    open.advance(140);
    open.receiveOpeningWindow(shortOpeningWindow());
    expect(open.frames).toHaveLength(1);
    open.advance(REMOTE_OPENING_FILL_HOLD_MS);
    open.holdTimerFires();
    expect(open.frames).toHaveLength(2);
    expect(open.frames.at(-1)!.rows.some(line => line.includes("newest answer 3"))).toBe(true);
  });

  test("a failed backfill releases the hold instead of waiting for the cap", () => {
    const open = new RemoteOpen(false);
    open.click();
    open.advance(140);
    open.receiveOpeningWindow(shortOpeningWindow());
    open.advance(200);
    open.receive({ type: "error", reqId: "history-backfill", convId: CONV, message: "boom" });
    expect(open.frames).toHaveLength(2);
    expect(open.frames.at(-1)!.at).toBe(340);
  });

  test("sizes the opening request at the width history is laid out at, not beside the task panel", () => {
    const open = new RemoteOpen(true);
    open.click();
    open.advance(140);
    open.receiveOpeningWindow(shortTurns(60, "filled"));
    // The panel narrows only the rows beside it; history is laid out at the chat width.
    expect(open.state.layout.historyWidth).toBeLessThan(open.state.layout.chatWidth);
    expect(openingViewport(open.state).cols).toBe(open.state.layout.chatWidth);
  });

  test("an /ssh startup open that cannot fill the screen keeps paging once the history is laid out", () => {
    // Startup over /ssh: only the connection progress paints until the sidebar
    // and tools arrive, and the open and its backfill can land before that.
    const state = createInitialState();
    setSystemTime(new Date(START));
    state.rows = 50;
    state.cols = 140;
    state.sidebar.open = false;
    state.sidebar.conversations = [summary(CONV, false, state)];
    state.sshConnecting = { phase: "loading", message: "Loading…" };
    const paint = () => {
      const write = process.stdout.write;
      process.stdout.write = (() => true) as typeof process.stdout.write;
      try { render(state); } finally { process.stdout.write = write; }
    };
    beginConversationLoad(state, CONV, daemon);
    handleEvent({
      type: "conversation_loaded", convId: CONV, provider: "anthropic", model: "claude-opus-5-5", effort: "high", fastMode: false,
      entries: shortTurns(3, "newest"), historyStartIndex: 800, historyStartUserIndex: 400, historyTotalEntries: 806,
      hasOlderHistory: true, contextTokens: 100, toolOutputsIncluded: false,
    }, state, daemon);
    beginOpeningFillHold(state, Date.now(), openingFillHoldMs(true));
    paint();
    beginOlderHistoryLoad(state, INITIAL_BUFFER_ADDITIONAL_TURNS);
    state.historyLoadingRequestId = "history-backfill";
    handleEvent({
      type: "conversation_history_loaded", reqId: "history-backfill", convId: CONV, requestSource: "initial-backfill",
      entries: shortTurns(2, "older"), historyStartIndex: 796, historyStartUserIndex: 398, historyEndIndex: 800,
      historyTotalEntries: 806, hasOlderHistory: true,
    }, state, daemon);
    paint();
    // Not laid out yet: whether the screen needs more cannot be told.
    expect(state.layout.totalLines).toBe(0);
    expect(olderHistoryDue(state)).toBe(false);
    expect(olderHistoryDueAfterLayout(state)).toBe(false);

    // Connected: the first frame lays the short window out and paging resumes.
    state.sshConnecting = null;
    paint();
    expect(state.layout.totalLines).toBeGreaterThan(0);
    expect(state.layout.totalLines).toBeLessThan(state.layout.messageAreaHeight);
    expect(olderHistoryDueAfterLayout(state)).toBe(true);
    // Asked once: a later frame does not ask again on its own.
    expect(olderHistoryDueAfterLayout(state)).toBe(false);
  });
});
