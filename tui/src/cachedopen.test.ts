import { describe, expect, test } from "bun:test";
import { handleEvent, type DaemonActions } from "./events";
import { createInitialState, isProvisionalStale, isStaleCopyMarked, noteConversationOpenRequest, STALE_COPY_MARK_DELAY_MS, type RenderState } from "./state";
import { prepareConversationOpen } from "./conversationscroll";
import { beginProvisionalOpen, cachedOpenEvents, liveCatchup, noteProvisionalPlacement, reconcileProvisionalOpen } from "./cachedopen";
import type { ConversationSummary } from "./messages";
import type { DisplayEntry, Event } from "./protocol";
import type { CachedView } from "./viewcache";

const daemon: DaemonActions = { subscribe() {}, unsubscribe() {}, sendMessage() {}, setSystemInstructions() {}, loadToolOutputs() {} };
type Loaded = Extract<Event, { type: "conversation_loaded" }>;
type Page = Extract<Event, { type: "conversation_history_loaded" }>;

const user = (text: string): DisplayEntry => ({ type: "user", text, metadata: null });
const ai = (text: string): DisplayEntry => ({ type: "ai", blocks: [{ type: "text", text }], metadata: null });
const ENTRIES = [user("u3"), ai("a3"), user("u4"), ai("a4")];
const OLDER = [user("u1"), ai("a1"), user("u2"), ai("a2")];

function answer(reqId: string, entries = ENTRIES, extra: Partial<Loaded> = {}): Loaded {
  return {
    type: "conversation_loaded", reqId, convId: "c", provider: "openai", model: "gpt-5.4", effort: "high", fastMode: false,
    entries, historyStartIndex: 4, historyStartUserIndex: 2, historyTotalEntries: 4 + entries.length, hasOlderHistory: true,
    contextTokens: 50, toolOutputsIncluded: false, historyRev: "e.1", initialBackfillReqId: `${reqId}-b`, ...extra,
  };
}
function backfillAnswer(reqId: string, entries = OLDER): Page {
  return {
    type: "conversation_history_loaded", reqId, convId: "c", requestSource: "initial-backfill", entries,
    historyStartIndex: 0, historyStartUserIndex: 0, historyEndIndex: 4, historyTotalEntries: 8, hasOlderHistory: false, historyRev: "e.1",
  };
}

const cached: CachedView = (() => {
  const { reqId: _r, initialBackfillReqId: _b, ...loaded } = answer("old");
  const { reqId: _p, ...backfill } = backfillAnswer("old-b");
  return { convId: "c", rev: "e.1", folded: true, loaded: loaded as Loaded, backfill: backfill as Page, live: null };
})();

const summary = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: "c", provider: "openai", model: "gpt-5.4", effort: "high", fastMode: false, createdAt: 1, updatedAt: 2, messageCount: 8,
  title: "Cached", marked: false, pinned: false, streaming: false, unread: false, sortOrder: 0, ...overrides,
});

/** The cached paint as main.ts does it: the copy stands in for the open's answer to reqId "open". */
function paint(current: boolean, overrides: Partial<ConversationSummary> = {}): RenderState {
  const state = createInitialState();
  state.sidebar.conversations = [summary({ id: "prev" }), summary(overrides)];
  state.convId = "prev";
  prepareConversationOpen(state, "c");
  noteConversationOpenRequest(state, "c", "open");
  const { loaded, backfill } = cachedOpenEvents(cached, "open", state.sidebar.conversations[1]);
  beginProvisionalOpen(state, cached, "open", current, backfill!.reqId ?? null);
  handleEvent(loaded, state, daemon);
  state.historyLoadingOlder = true;
  state.historyLoadingRequestId = backfill!.reqId!;
  handleEvent(backfill!, state, daemon);
  noteProvisionalPlacement(state);
  return state;
}

const texts = (state: RenderState) => state.messages.map(message => "text" in message ? message.text : message.role === "assistant" ? message.blocks.map(block => "text" in block ? block.text : "").join("") : "");

describe("opening a conversation from its cached copy", () => {
  test("paints the whole copy at once, with the sidebar's newer model and goal", () => {
    const state = paint(true, { model: "gpt-5.5", effort: "low" });
    expect(state.convId).toBe("c");
    expect(state.conversationLoading).toBeNull();
    expect(texts(state)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"]);
    expect(state.model).toBe("gpt-5.5");
    expect(state.effort).toBe("low");
    expect(isProvisionalStale(state)).toBe(false);
  });

  test("an answer matching the copy changes nothing on screen, only metadata", () => {
    const state = paint(false);
    const messages = state.messages;
    expect(isProvisionalStale(state)).toBe(true);
    const confirmed = reconcileProvisionalOpen(state, answer("open", ENTRIES, { contextTokens: 77 }));
    expect(confirmed).toEqual({ kind: "confirmed", done: false, wasStale: true });
    expect(state.contextTokens).toBe(77);
    expect(isProvisionalStale(state)).toBe(false);
    expect(reconcileProvisionalOpen(state, backfillAnswer("open-b"))).toEqual({ kind: "confirmed", done: true, wasStale: false });
    expect(state.provisionalOpen).toBeNull();
    expect(state.messages).toBe(messages);
  });

  test("a changed answer replaces the copy as the open landing, placed by that open's intent", () => {
    const state = paint(false, { unread: true });
    const newer = [user("u4"), ai("a4"), user("u5"), ai("a5")];
    const real = answer("open", newer, { historyStartIndex: 6, historyStartUserIndex: 3 });
    const outcome = reconcileProvisionalOpen(state, real);
    expect(outcome).toEqual({ kind: "replace", events: [real] });
    expect(state.provisionalOpen).toBeNull();
    // Applied like the placeholder open it stands for.
    expect(state.conversationLoading?.convId).toBe("c");
    expect(state.conversationScroll.pendingOpen).toEqual({ convId: "c", unreadAtOpen: true });
    handleEvent(real, state, daemon);
    expect(texts(state)).toEqual(["u4", "a4", "u5", "a5"]);
    expect(state.conversationLoading).toBeNull();
    expect(state.conversationScroll.pendingRestore?.mode).toBe("unread-response");
  });

  test("once the reader has moved, a changed answer reloads where they are instead", () => {
    const state = paint(false);
    state.scrollOffset += 5;
    const outcome = reconcileProvisionalOpen(state, answer("open", [user("u4"), ai("edited")]));
    expect(outcome.kind).toBe("replace");
    expect(state.conversationLoading).toBeNull();
  });

  test("a running turn, a missing backfill or changed older history is never taken as a match", () => {
    const streaming = paint(false);
    expect(reconcileProvisionalOpen(streaming, answer("open", ENTRIES, { pendingAI: { blocks: [], metadata: null } })).kind).toBe("replace");

    const noBackfill = paint(false);
    expect(reconcileProvisionalOpen(noBackfill, answer("open", ENTRIES, { initialBackfillReqId: undefined })).kind).toBe("replace");

    const olderChanged = paint(true);
    const real = answer("open");
    expect(reconcileProvisionalOpen(olderChanged, real).kind).toBe("confirmed");
    const page = backfillAnswer("open-b", [user("u1"), ai("rewritten")]);
    expect(reconcileProvisionalOpen(olderChanged, page)).toEqual({ kind: "replace", events: [real, page] });
  });

  test("other conversations' events pass, and leaving or a failed open drops the copy's claim", () => {
    const state = paint(false);
    expect(reconcileProvisionalOpen(state, { ...answer("other"), convId: "x" })).toEqual({ kind: "pass" });
    expect(state.provisionalOpen).not.toBeNull();
    expect(reconcileProvisionalOpen(state, { type: "error", reqId: "open", convId: "c", message: "Conversation c not found" })).toEqual({ kind: "pass" });
    expect(state.provisionalOpen).toBeNull();

    const left = paint(false);
    left.convId = "elsewhere";
    expect(reconcileProvisionalOpen(left, answer("open"))).toEqual({ kind: "pass" });
    expect(left.provisionalOpen).toBeNull();
  });

  test("a stale copy is marked only once the answer is late", () => {
    const state = paint(false);
    const paintedAt = state.provisionalOpen!.paintedAt;
    expect(isStaleCopyMarked(state, paintedAt + STALE_COPY_MARK_DELAY_MS - 1)).toBe(false);
    expect(isStaleCopyMarked(state, paintedAt + STALE_COPY_MARK_DELAY_MS)).toBe(true);
    expect(isStaleCopyMarked(paint(true), paintedAt + 10_000)).toBe(false);
  });
});

describe("opening a streaming conversation from its copy", () => {
  const live = { blocks: [{ type: "thinking" as const, text: "Reading the code" }, { type: "tool_call" as const, toolCallId: "t1", toolName: "bash", input: { command: "ls" }, summary: "ls" }], blockOffset: 0, metadata: { startedAt: 5_000, endedAt: null, model: "gpt-5.4", tokens: 120 } };
  const streamingCopy: CachedView = { ...cached, live, loaded: { ...cached.loaded } };

  function paintStreaming(current = true, summaryOverrides: Partial<ConversationSummary> = { streaming: true }): RenderState {
    const state = createInitialState();
    state.sidebar.conversations = [summary({ id: "prev" }), summary(summaryOverrides)];
    state.convId = "prev";
    prepareConversationOpen(state, "c");
    noteConversationOpenRequest(state, "c", "open");
    const { loaded, backfill, catchup } = cachedOpenEvents(streamingCopy, "open", state.sidebar.conversations[1]);
    beginProvisionalOpen(state, streamingCopy, "open", current, backfill!.reqId ?? null, loaded.pendingAI ?? null);
    handleEvent(loaded, state, daemon);
    if (catchup) handleEvent(catchup, state, daemon);
    state.historyLoadingOlder = true;
    state.historyLoadingRequestId = backfill!.reqId!;
    handleEvent(backfill!, state, daemon);
    noteProvisionalPlacement(state);
    return state;
  }

  test("paints the finished messages and the turn in progress at once", () => {
    const state = paintStreaming();
    expect(texts(state).slice(0, 8)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"]);
    expect(state.pendingAI?.blocks).toEqual(live.blocks);
    expect(state.pendingAI?.metadata?.tokens).toBe(120);
  });

  test("an answer whose live part only grew is applied as streaming, nothing else redrawn", () => {
    const state = paintStreaming();
    const messages = state.messages;
    const grown = { ...live, blocks: [{ type: "thinking" as const, text: "Reading the code closely" }, live.blocks[1]!, { type: "tool_result" as const, toolCallId: "t1", toolName: "bash", output: "", isError: false }] };
    const outcome = reconcileProvisionalOpen(state, answer("open", ENTRIES, { pendingAI: grown }));
    expect(outcome).toMatchObject({ kind: "confirmed", live: grown });
    handleEvent(liveCatchup(answer("open"), grown, true), state, daemon);
    expect(state.pendingAI?.blocks.map(block => block.type)).toEqual(["thinking", "tool_call", "tool_result"]);
    expect((state.pendingAI?.blocks[0] as { text: string }).text).toBe("Reading the code closely");
    expect(state.messages).toBe(messages);
  });

  test("a live part that changed, ended or started meanwhile replaces the copy", () => {
    const rewritten = { ...live, blocks: [{ type: "text" as const, text: "Different" }] };
    expect(reconcileProvisionalOpen(paintStreaming(), answer("open", ENTRIES, { pendingAI: rewritten })).kind).toBe("replace");
    expect(reconcileProvisionalOpen(paintStreaming(), answer("open", ENTRIES, { pendingAI: { ...live, blockOffset: 3 } })).kind).toBe("replace");
    expect(reconcileProvisionalOpen(paintStreaming(), answer("open")).kind).toBe("replace");
    // The sidebar says the turn ended: its copy's live part is not shown, and an answer with one replaces it.
    const ended = paintStreaming(false, { streaming: false });
    expect(ended.pendingAI).toBeNull();
    expect(reconcileProvisionalOpen(ended, answer("open", ENTRIES, { pendingAI: live })).kind).toBe("replace");
  });
});
