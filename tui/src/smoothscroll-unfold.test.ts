import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createInitialState, type RenderState } from "./state";
import { invalidateFrame, setScrollRegionsEnabled } from "./frame";
import { SmoothScroller, setSmoothScroller, smoothScrollerFor } from "./smoothscroll";
import { createPendingAI, type Block, type Message } from "./messages";
import { getViewStart, preserveViewportAcrossResize } from "./chatscroll";
import { handleFocusedKey } from "./focus";
import { handleEvent } from "./events";
import { requestElidedBlocksIfNeeded } from "./events/elided-blocks";
import type { DaemonActions } from "./events/types";
import { beginOlderHistoryLoad, olderHistoryDue } from "./historypagination";
import type { DisplayEntry } from "./protocol";
import { TerminalScreen } from "./testhelpers/terminalscreen";
import { captureRender, glides } from "./testhelpers/smoothframes";

// Showing folded work (Ctrl+O, Ctrl+I) drops the loaded history above the
// view; folding it again must land where it was, at once: no history missing
// above the live turn (which then sat at the top of the pane), no older pages
// gliding in under it a round trip later (st mode 2032).

let now = 0;
let screen: TerminalScreen;

/** Renders like main.ts for a while (each row a glide crosses); returns everything sent. */
function frames(state: RenderState, ms = 300): string {
  let out = "";
  for (let t = 0; t <= ms; t += 4) {
    if (t > 0) now += 4;
    const next = captureRender(state);
    screen.feed(next);
    out += next;
  }
  return out;
}

/** The pane's rows (between the top bar and the prompt). */
const pane = (state: RenderState) => screen.plainRows().slice(2, state.layout.sepAbove - 1);

const call = (id: string, command: string, output = "ok"): Block[] => [
  { type: "tool_call", toolCallId: id, toolName: "bash", input: { command }, summary: command },
  { type: "tool_result", toolCallId: id, toolName: "bash", output, isError: false },
];

/** A folded page's copy of a block: its work left out (daemon elideFoldedWork). */
function elide(block: Block, entry: number, index: number): Block {
  if (block.type === "tool_call") return { type: "tool_call", toolCallId: block.toolCallId, toolName: block.toolName, input: {}, summary: "", elided: { entry, block: index } };
  if (block.type === "thinking") return { type: "thinking", text: "", elided: { entry, block: index } };
  return block;
}

interface Owner {
  state: RenderState;
  /** Full blocks of each entry, as load_display_blocks answers. */
  full: Map<number, Block[]>;
  daemon: DaemonActions;
  /** load_display_blocks requests: reqId and ranges. */
  requests: Array<{ reqId: string; ranges: Array<{ entry: number; start: number; end: number }> }>;
}

/**
 * The owner's conversation: answers with long wrapped trees, then "Ok lets go"
 * and a live turn (woken by subagent completions) whose earlier pieces have no
 * reply, its newest step a running multi-line heredoc. Folded pages leave the
 * older turns' work out; the newest screen's is in (the open's prefetch)
 * unless `prefetched` is false.
 */
function ownerConversation(prefetched = true): Owner {
  const state = createInitialState();
  state.cols = 100;
  state.rows = 40;
  state.convId = "c0";
  state.sidebar.open = false;
  state.showTurnWork = false;
  state.sidebar.conversations = [{
    id: "c0", provider: state.provider, model: state.model, effort: state.effort, fastMode: state.fastMode,
    createdAt: 1, updatedAt: 1, messageCount: 1, title: "Conversation", marked: false, pinned: false,
    streaming: true, unread: false, sortOrder: 0, tasks: [],
  }];
  const meta = (startedAt: number) => ({ startedAt, endedAt: startedAt + 1, model: state.model, tokens: 100 });
  const full = new Map<number, Block[]>();
  const messages: Message[] = [];
  const assistant = (blocks: Block[], startedAt: number, elided: boolean) => {
    const entry = messages.length;
    full.set(entry, blocks);
    messages.push({ role: "assistant", blocks: elided ? blocks.map((block, index) => elide(block, entry, index)) : blocks, metadata: meta(startedAt) } as Message);
  };
  const user = (text: string, automation?: { kind: "subagent_completion" }) => messages.push({
    role: "user", text, metadata: { ...meta(1), ...(automation ? { automation } : {}) },
  } as Message);
  for (let turn = 0; turn < 20; turn++) {
    user(`Question ${turn}: ${"what about this ".repeat(4)}`);
    const tree = Array.from({ length: 4 }, (_, row) => `| tree/${turn}/${row} ${"a wrapped directory listing line ".repeat(5)}`).join("\n");
    assistant([
      { type: "thinking", text: `Looking ${turn}` },
      ...Array.from({ length: 6 }, (_, k) => call(`o${turn}-${k}`, `ls /tmp/${turn}/${k}`)).flat(),
      { type: "text", text: `Answer ${turn}:\n${tree}` },
    ], 1, true);
  }
  user("Ok lets go");
  assistant(Array.from({ length: 38 }, (_, k) => call(`g${k}`, `step ${k}`)).flat(), 3, !prefetched);
  for (let n = 0; n < 3; n++) {
    user(`[notification] Subagent completed: exo:${n}`, { kind: "subagent_completion" });
    assistant(call(`n${n}`, `check ${n}`), 5, !prefetched);
  }
  user("[notification] Subagent completed: exo:9", { kind: "subagent_completion" });
  state.messages = messages;
  state.pendingAI = createPendingAI(8, state.model);
  const heredoc = `cd ~/digest && python3 -I - <<'EOF'\n${Array.from({ length: 20 }, (_, i) => `line ${i} = ${"x".repeat(i * 4)}`).join("\n")}\nEOF`;
  state.pendingAI.blocks.push(...call("p0", "ls"), { type: "tool_call", toolCallId: "live", toolName: "bash", input: { command: heredoc }, summary: heredoc });
  setSmoothScroller(state, new SmoothScroller(100, () => now));
  screen = new TerminalScreen(state.rows, state.cols);
  const requests: Owner["requests"] = [];
  const daemon = {
    loadDisplayBlocks: (_convId: string, ranges: Array<{ entry: number; start: number; end: number }>) => {
      const reqId = `blocks-${requests.length + 1}`;
      requests.push({ reqId, ranges });
      return reqId;
    },
    loadToolOutputs: () => "outputs",
  } as unknown as DaemonActions;
  return { state, full, daemon, requests };
}

/** The daemon answers a load_display_blocks request. */
function answer(owner: Owner, request: Owner["requests"][number]): void {
  const ranges = request.ranges.map(range => ({ entry: range.entry, start: range.start, blocks: owner.full.get(range.entry)!.slice(range.start, range.end) }));
  handleEvent({ type: "display_blocks_loaded", reqId: request.reqId, convId: "c0", ranges }, owner.state, owner.daemon);
}

/** A key, then what main.ts does after it: the fetches it needs, older history if due. */
function press(owner: Owner, key: "ctrl-o" | "ctrl-i"): void {
  handleFocusedKey({ type: key }, owner.state);
  requestElidedBlocksIfNeeded(owner.state, owner.daemon);
  if (olderHistoryDue(owner.state)) beginOlderHistoryLoad(owner.state, 15);
}

beforeEach(() => {
  now = 1000;
  // The Working row's spinner and clock follow the wall clock.
  setSystemTime(new Date("2026-10-29T19:10:00Z"));
  setScrollRegionsEnabled(true);
});
afterEach(() => {
  setScrollRegionsEnabled(null);
  setSystemTime();
});

describe("folding shown work back", () => {
  for (const key of ["ctrl-o", "ctrl-i"] as const) {
    test(`${key === "ctrl-o" ? "Ctrl+O" : "Ctrl+I"} closed at the bottom of a live turn lands at the bottom at once`, () => {
      const owner = ownerConversation();
      const { state } = owner;
      frames(state);
      const before = pane(state);
      const loaded = state.messages.length;

      press(owner, key);
      expect(state.showTurnWork || state.showToolOutput).toBe(true);
      // The history above the view went, so its work is never fetched.
      expect(state.messages.length).toBeLessThan(loaded);
      expect(glides(frames(state))).toEqual([]);

      press(owner, key);
      expect(state.showTurnWork || state.showToolOutput).toBe(false);
      // The very next frame is the view it left, with nothing to page back in.
      expect(state.messages).toHaveLength(loaded);
      expect(state.historyStartIndex).toBe(0);
      expect(state.historyLoadingOlder).toBe(false);
      screen.feed(captureRender(state));
      expect(pane(state)).toEqual(before);
      expect(glides(frames(state))).toEqual([]);
      expect(pane(state)).toEqual(before);
    });
  }

  test("while the work loads the folded view keeps its history, and a second press leaves it whole", () => {
    const owner = ownerConversation(false);
    const { state } = owner;
    frames(state);
    const before = pane(state);
    const loaded = state.messages.length;

    press(owner, "ctrl-o");
    expect(owner.requests).toHaveLength(1);
    expect(state.showTurnWork).toBe(false);
    expect(state.messages).toHaveLength(loaded);
    expect(state.historyLoadingOlder).toBe(false);
    expect(glides(frames(state))).toEqual([]);
    expect(pane(state)).toEqual(before);

    // A second press cancels: the reply fills the work in, the view stays folded.
    press(owner, "ctrl-o");
    answer(owner, owner.requests[0]!);
    expect(state.showTurnWork).toBe(false);
    expect(state.messages).toHaveLength(loaded);
    expect(glides(frames(state))).toEqual([]);
    expect(pane(state)).toEqual(before);
  });

  test("the work shows once it is in, from the bottom, and folds back to the same view", () => {
    const owner = ownerConversation(false);
    const { state } = owner;
    frames(state);
    const before = pane(state);
    press(owner, "ctrl-o");
    answer(owner, owner.requests[0]!);
    expect(state.showTurnWork).toBe(true);
    expect(glides(frames(state))).toEqual([]);
    expect(pane(state).at(-1)).toBe(before.at(-1));
    press(owner, "ctrl-o");
    expect(glides(frames(state))).toEqual([]);
    expect(pane(state)).toEqual(before);
  });

  test("scrolled up, Ctrl+O on and off keeps the first row in view and the history above it", () => {
    const owner = ownerConversation(false);
    const { state } = owner;
    frames(state);
    state.scrollOffset = 30;
    frames(state);
    const before = pane(state);
    const loaded = state.messages.length;

    press(owner, "ctrl-o");
    for (let i = 0; i < 4 && owner.requests.length > 0 && !state.showTurnWork; i++) answer(owner, owner.requests.at(-1)!);
    expect(state.showTurnWork).toBe(true);
    expect(glides(frames(state))).toEqual([]);
    expect(pane(state)[0]).toBe(before[0]);
    // The rest of the work in the window follows, out of view.
    while (state.elidedBlocksRequestId !== null) answer(owner, owner.requests.at(-1)!);
    frames(state);
    expect(pane(state)[0]).toBe(before[0]);

    press(owner, "ctrl-o");
    expect(state.messages).toHaveLength(loaded);
    expect(glides(frames(state))).toEqual([]);
    expect(pane(state)).toEqual(before);
  });

  test("work still on its way when the view folds fills in without moving it", () => {
    const owner = ownerConversation(false);
    const { state } = owner;
    frames(state);
    state.scrollOffset = 30;
    frames(state);
    const before = pane(state);
    press(owner, "ctrl-o");
    for (let i = 0; i < 4 && !state.showTurnWork; i++) answer(owner, owner.requests.at(-1)!);
    expect(state.showTurnWork).toBe(true);
    frames(state);
    // The work below the view is still being fetched when Ctrl+O folds it.
    const late = owner.requests.at(-1)!;
    expect(state.elidedBlocksRequestId).toBe(late.reqId);
    press(owner, "ctrl-o");
    expect(glides(frames(state))).toEqual([]);
    expect(pane(state)).toEqual(before);
    answer(owner, late);
    expect(owner.requests.at(-1)).toBe(late);
    expect(glides(frames(state))).toEqual([]);
    expect(pane(state)).toEqual(before);
  });

  test("once older pages moved the window's start, folding keeps them instead", () => {
    const owner = ownerConversation();
    const { state } = owner;
    frames(state);
    press(owner, "ctrl-o");
    expect(state.historyTrimmedAboveView).not.toBeNull();
    // Scrolling up while unfolded paged older history back in, in full.
    const page: Message[] = [
      { role: "user", text: "Ok lets go", metadata: null },
      { role: "assistant", blocks: call("paged", "ls paged"), metadata: null },
    ] as Message[];
    state.messages = [...page, ...state.messages];
    state.historyStartIndex -= 2;
    state.historyStartBlockIndex = 0;
    const loaded = state.messages.length;
    press(owner, "ctrl-o");
    expect(state.showTurnWork).toBe(false);
    expect(state.historyTrimmedAboveView).toBeNull();
    expect(state.messages).toHaveLength(loaded);
    expect(glides(frames(state))).toEqual([]);
  });

  test("a terminal resize while the work shows, at the bottom and scrolled up, never glides", () => {
    for (const offset of [0, 12]) {
      const owner = ownerConversation();
      const { state } = owner;
      frames(state);
      press(owner, "ctrl-o");
      state.scrollOffset = offset;
      frames(state);
      const top = pane(state)[0];
      // As main.ts does on SIGWINCH.
      preserveViewportAcrossResize(state, 90, 36);
      invalidateFrame(state);
      smoothScrollerFor(state)?.terminalReset();
      screen = new TerminalScreen(state.rows, state.cols);
      expect(glides(frames(state))).toEqual([]);
      if (offset === 0) expect(state.scrollOffset).toBe(0);
      else expect(pane(state)[0]?.trim().slice(0, 30)).toBe(top?.trim().slice(0, 30));
    }
  });
});

describe("older history going in above", () => {
  test("under a history shorter than the pane, at the bottom, it snaps instead of gliding", () => {
    const state = createInitialState();
    state.cols = 100;
    state.rows = 40;
    state.convId = "c0";
    state.sidebar.open = false;
    state.messages = [
      { role: "user", text: "Ok lets go", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "On it." }], metadata: { startedAt: 1, endedAt: 2, model: state.model, tokens: 3 } },
    ] as Message[];
    state.historyStartIndex = 40;
    state.historyStartUserIndex = 20;
    state.historyHasOlder = true;
    setSmoothScroller(state, new SmoothScroller(100, () => now));
    screen = new TerminalScreen(state.rows, state.cols);
    frames(state);
    expect(olderHistoryDue(state)).toBe(true);
    beginOlderHistoryLoad(state, 15);
    state.historyLoadingRequestId = "history-1";
    frames(state);
    const entries: DisplayEntry[] = Array.from({ length: 20 }, (_, index): DisplayEntry[] => [
      { type: "user", text: `Question ${index}` },
      { type: "ai", blocks: [{ type: "text", text: `Answer ${index}\n${"a tree line\n".repeat(3)}` }], metadata: { startedAt: 1, endedAt: 2, model: state.model, tokens: 3 } },
    ]).flat();
    handleEvent({
      type: "conversation_history_loaded", reqId: "history-1", convId: "c0", requestSource: "viewport", entries,
      historyStartIndex: 0, historyStartUserIndex: 0, historyEndIndex: 40, historyTotalEntries: 42, hasOlderHistory: false,
    }, state, {} as DaemonActions);
    const out = frames(state);
    expect(glides(out)).toEqual([]);
    expect(pane(state).findLastIndex(row => row.includes("On it."))).toBeGreaterThan(pane(state).length - 4);
    expect(getViewStart(state)).toBeGreaterThan(0);
  });
});
