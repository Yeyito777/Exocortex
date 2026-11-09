import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createInitialState, type RenderState } from "./state";
import { holdFrames, invalidateFrame, releaseFrames, setScrollRegionsEnabled } from "./frame";
import { SmoothScroller, markScrollIntent, setSmoothScroller, smoothScrollerFor } from "./smoothscroll";
import { createPendingAI } from "./messages";
import {
  preserveViewportAcrossHistoryMutation, preserveViewportAcrossResize, toggleSidebarPreservingViewport,
  toggleToolOutputPreservingViewport,
} from "./chatscroll";
import { TerminalScreen } from "./testhelpers/terminalscreen";
import { render } from "./render";
import { captureRender as capture, glides } from "./testhelpers/smoothframes";

// Only scrolling glides. Every other reason the conversation pane's offset or
// content moves (a re-layout that keeps the user's place, a jump to the
// bottom after sending) snaps: no eased move goes to st (mode 2032).

let now = 0;
let screen: TerminalScreen;

function conversationState(): RenderState {
  const state = createInitialState();
  state.cols = 120;
  state.rows = 32;
  state.convId = "c0";
  state.sidebar.open = false;
  state.sidebar.conversations = [{
    id: "c0", provider: state.provider, model: state.model, effort: state.effort, fastMode: state.fastMode,
    createdAt: 1, updatedAt: 1, messageCount: 1, title: "Conversation", marked: false, pinned: false,
    streaming: false, unread: false, sortOrder: 0, tasks: [],
  }];
  state.messages = Array.from({ length: 40 }, (_, i) => i % 2 === 0
    ? { role: "user" as const, text: `Question ${i}: ${"what about this ".repeat(4)}`, metadata: null }
    : {
      role: "assistant" as const,
      blocks: [
        { type: "tool_call" as const, toolCallId: `t${i}`, toolName: "bash", input: { command: `ls -la /tmp/${i}` }, summary: `ls -la /tmp/${i}` },
        { type: "tool_result" as const, toolCallId: `t${i}`, toolName: "bash", output: Array.from({ length: 6 }, (_, k) => `file-${i}-${k}.txt`).join("\n"), isError: false },
        { type: "text" as const, text: `Answer ${i}: ${"some words that wrap across the pane ".repeat(5)}` },
      ],
      metadata: { startedAt: 1, endedAt: 2, model: state.model, tokens: 100 },
    }) as RenderState["messages"];
  const smooth = new SmoothScroller(100, () => now);
  setSmoothScroller(state, smooth);
  screen = new TerminalScreen(state.rows, state.cols);
  return state;
}

/** Renders like main.ts for a while (each row a glide crosses); returns everything sent. */
function frames(state: RenderState, ms = 300): string {
  let out = capture(state);
  screen.feed(out);
  for (let t = 0; t < ms; t += 4) {
    now += 4;
    const next = capture(state);
    screen.feed(next);
    out += next;
  }
  return out;
}

const topRow = (_state: RenderState) => screen.plainRows()[2]?.trim() ?? "";
/** Every move sent to st (OSC 2032 ; m / o), but a reset to rest: anything still sliding. */
const motion = (out: string) => [...out.matchAll(/\x1b\]2032;([mo];[-;\d]*)\x1b\\/g)].map(match => match[1]!).filter(move => move !== "o;0");

function settle(state: RenderState, scrollOffset: number): void {
  screen.feed(capture(state));
  state.scrollOffset = scrollOffset;
  frames(state, 400);
}

beforeEach(() => {
  now = 1000;
  setScrollRegionsEnabled(true);
});
afterEach(() => setScrollRegionsEnabled(null));

describe("re-layouts never glide", () => {
  for (const where of ["at the bottom", "scrolled up"] as const) {
    const offset = where === "at the bottom" ? 0 : 25;

    test(`Ctrl+I (tool output) twice, ${where}`, () => {
      const state = conversationState();
      settle(state, offset);
      const before = topRow(state);
      expect(glides(frames(state, 0) + (toggleToolOutputPreservingViewport(state), frames(state)))).toEqual([]);
      expect(glides((toggleToolOutputPreservingViewport(state), frames(state)))).toEqual([]);
      if (where === "scrolled up") expect(topRow(state)).toBe(before);
    });

    test(`Ctrl+O (turn work), ${where}`, () => {
      const state = conversationState();
      settle(state, offset);
      preserveViewportAcrossHistoryMutation(state, () => { state.showTurnWork = !state.showTurnWork; });
      expect(glides(frames(state))).toEqual([]);
      preserveViewportAcrossHistoryMutation(state, () => { state.showTurnWork = !state.showTurnWork; });
      expect(glides(frames(state))).toEqual([]);
    });

    test(`the sidebar opening and closing, ${where}`, () => {
      const state = conversationState();
      settle(state, offset);
      toggleSidebarPreservingViewport(state);
      expect(glides(frames(state))).toEqual([]);
      toggleSidebarPreservingViewport(state);
      expect(glides(frames(state))).toEqual([]);
    });

    test(`a turn finishing, ${where}`, () => {
      const state = conversationState();
      state.pendingAI = createPendingAI(1, state.model);
      state.pendingAI.blocks.push({ type: "text", text: `Streaming ${"answer words ".repeat(30)}` });
      settle(state, offset);
      const before = topRow(state);
      const done = state.pendingAI!;
      done.metadata = { ...done.metadata!, endedAt: 5, tokens: 300 };
      state.messages.push(done);
      state.pendingAI = null;
      expect(glides(frames(state))).toEqual([]);
      // A scrolled-up view keeps its first line.
      if (where === "scrolled up") expect(topRow(state)).toBe(before);
    });

    test(`the Tasks panel appearing and going, ${where}`, () => {
      const state = conversationState();
      settle(state, offset);
      state.sidebar.conversations[0].tasks = [{ id: "child", kind: "subagent", title: "Inspect renderer flow", startedAt: 1 }];
      expect(glides(frames(state))).toEqual([]);
      state.sidebar.conversations[0].tasks = [];
      expect(glides(frames(state))).toEqual([]);
    });

    test(`the terminal resizing, ${where}`, () => {
      const state = conversationState();
      settle(state, offset);
      preserveViewportAcrossResize(state, 100, 30);
      screen = new TerminalScreen(state.rows, state.cols);
      expect(glides(frames(state))).toEqual([]);
    });
  }

  test("Ctrl+O in the middle of a scroll's glide shows the new view in place", () => {
    const state = conversationState();
    settle(state, 10);
    markScrollIntent(state);
    state.scrollOffset += 6;
    expect(glides(frames(state, 20)).length).toBe(1);
    preserveViewportAcrossHistoryMutation(state, () => { state.showTurnWork = !state.showTurnWork; });
    expect(motion(frames(state))).toEqual([]);
    preserveViewportAcrossHistoryMutation(state, () => { state.showTurnWork = !state.showTurnWork; });
    expect(motion(frames(state))).toEqual([]);
  });

  test("sending from a scrolled-up view jumps to the bottom without a glide", () => {
    const state = conversationState();
    settle(state, 25);
    state.messages.push({ role: "user", text: "a new question", metadata: null });
    state.scrollOffset = 0;
    expect(glides(frames(state))).toEqual([]);
  });

  test("a remote open's load replacing its placeholder lands at the bottom without a glide", () => {
    // Over /ssh the open paints a spinner first, with the conversation's queued
    // message under it. The load puts that message ~a screen lower, intact.
    const state = conversationState();
    const history = state.messages;
    state.messages = [];
    state.conversationLoading = { convId: "c0", startedAt: 1 };
    state.queuedMessages = [{
      id: "q1", convId: "c0", timing: "message-end", source: "daemon",
      text: `Queued: ${"a long queued paragraph that wraps across the box ".repeat(4)}`,
    }];
    settle(state, 0);
    expect(screen.plainRows().some(row => row.includes("Loading conversation"))).toBe(true);
    state.conversationLoading = null;
    state.messages = history;
    state.pendingAI = createPendingAI(1, state.model);
    state.pendingAI.blocks.push({ type: "tool_call", toolCallId: "live", toolName: "bash", input: { command: "make test" }, summary: "make test" });
    const out = frames(state);
    expect(out).toMatch(/\x1b\[\d+T/);
    expect(glides(out)).toEqual([]);
    const rows = screen.plainRows();
    expect(rows.findLastIndex(row => row.includes("queued: message end"))).toBe(state.layout.sepAbove - 2);
  });

  test("streamed output while scrolled up keeps the view still", () => {
    const state = conversationState();
    state.pendingAI = createPendingAI(1, state.model);
    state.pendingAI.blocks.push({ type: "text", text: "Streaming" });
    settle(state, 25);
    const before = topRow(state);
    for (let i = 0; i < 5; i++) {
      (state.pendingAI!.blocks[0] as { type: "text"; text: string }).text += " more streamed words".repeat(12);
      expect(glides(frames(state, 40))).toEqual([]);
    }
    expect(topRow(state)).toBe(before);
  });
});

describe("what still glides", () => {
  test("scrolling", () => {
    const state = conversationState();
    settle(state, 10);
    markScrollIntent(state);
    state.scrollOffset += 3;
    expect(glides(frames(state)).length).toBe(1);
  });

  test("output arriving at the bottom while following it", () => {
    const state = conversationState();
    settle(state, 0);
    state.messages.push({
      role: "assistant",
      blocks: [{ type: "text", text: "A notification that arrived: two short lines\nof output" }],
      metadata: { startedAt: 3, endedAt: 4, model: state.model, tokens: 10 },
    } as RenderState["messages"][number]);
    expect(glides(frames(state)).length).toBe(1);
  });

});

describe("the bottom growing and shrinking while following it", () => {
  /** A live turn whose latest step (under its Working row) is a tool call of `rows` wrapped rows. */
  function liveTurn(state: RenderState, rows: number, step = 0): void {
    const command = `run-step-${step} ${"--with-a-long-argument ".repeat(Math.max(0, rows * 5 - 1))}`.trim();
    state.pendingAI = createPendingAI(1, state.model);
    state.pendingAI.blocks.push(
      { type: "tool_call", toolCallId: "p0", toolName: "bash", input: { command: "echo first" }, summary: "echo first" },
      { type: "tool_result", toolCallId: "p0", toolName: "bash", output: "first", isError: false },
      { type: "tool_call", toolCallId: `p${step + 1}`, toolName: "bash", input: { command }, summary: command },
    );
  }
  /** Eased moves' easing rows (positive: drawn lower, the content moved up). */
  const eases = (out: string) => glides(out).map(match => Number(match[1]));

  test("a taller latest step slides the history up, a shorter one slides it back down", () => {
    const state = conversationState();
    liveTurn(state, 1);
    settle(state, 0);
    liveTurn(state, 3, 1);
    const grew = eases(frames(state));
    expect(grew.length).toBe(1);
    expect(grew[0]).toBeGreaterThan(0);
    liveTurn(state, 1, 2);
    const shrank = eases(frames(state));
    expect(shrank.length).toBe(1);
    expect(shrank[0]).toBeLessThan(0);
    expect(shrank[0]).toBe(-grew[0]);
  });

  test("growing and shrinking in quick succession ends where a full repaint does", () => {
    // The working spinner follows the wall clock; both paints must see one frame.
    setSystemTime(new Date("2026-10-29T00:00:00Z"));
    try {
      const state = conversationState();
      liveTurn(state, 1);
      settle(state, 0);
      for (let i = 0; i < 8; i++) {
        liveTurn(state, i % 2 === 0 ? 3 : 1, i + 1);
        frames(state, 24);
      }
      frames(state, 400);
      const settled = screen.plainRows();
      setSmoothScroller(state, null);
      const fresh = new TerminalScreen(state.rows, state.cols);
      invalidateFrame(state);
      fresh.feed(capture(state));
      expect(settled).toEqual(fresh.plainRows());
    } finally {
      setSystemTime();
    }
  });

  /** The Tasks panel (a card at the top right of the pane): rows beside it re-wrap narrower. */
  function openTasks(state: RenderState): void {
    state.sidebar.conversations[0].tasks = [
      { id: "child-a", kind: "subagent", title: "Inspect renderer flow", startedAt: 1 },
      { id: "child-b", kind: "subagent", title: "Measure the glide in st", startedAt: 1 },
      { id: "child-c", kind: "subagent", title: "Write the frame-stream test", startedAt: 1 },
    ];
  }

  for (const rows of [3, 8, 12] as const) {
    test(`beside the Tasks panel a step ${rows} rows taller slides the history up, and back down`, () => {
      const state = conversationState();
      openTasks(state);
      liveTurn(state, 1);
      settle(state, 0);
      liveTurn(state, rows, 1);
      const grew = eases(frames(state));
      expect(grew.length).toBe(1);
      expect(grew[0]).toBeGreaterThan(0);
      liveTurn(state, 1, 2);
      const shrank = eases(frames(state));
      expect(shrank.length).toBe(1);
      expect(shrank[0]).toBe(-grew[0]);
    });
  }

  for (const tasks of [false, true]) {
    test(`a new step replacing a shorter one slides the history up, and a short one after it back down (Tasks panel ${tasks ? "open" : "closed"})`, () => {
      // The newest step's own rows change as it is replaced, not only the rows below them.
      const state = conversationState();
      if (tasks) openTasks(state);
      liveTurn(state, 4);
      settle(state, 0);
      liveTurn(state, 12, 1);
      const grew = eases(frames(state));
      expect(grew.length).toBe(1);
      expect(grew[0]).toBeGreaterThan(0);
      liveTurn(state, 2, 2);
      const shrank = eases(frames(state));
      expect(shrank.length).toBe(1);
      expect(shrank[0]).toBeLessThan(0);
    });
  }

  test("the frame starting the bottom's slide goes out with the row laid out next to it, in one write", () => {
    // main.ts renders again at once when the next row is due and releases both
    // together: st never draws the first frame alone (beside the Tasks panel
    // its re-wrapped rows would show displaced by the whole move).
    const state = conversationState();
    openTasks(state);
    liveTurn(state, 1);
    settle(state, 0);
    const writes: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    try {
      holdFrames();
      liveTurn(state, 9, 1);
      render(state);
      expect(smoothScrollerFor(state)!.needsLayout()).toBe(true);
      render(state);
      expect(writes).toEqual([]);
      releaseFrames();
    } finally {
      process.stdout.write = write as typeof process.stdout.write;
    }
    expect(writes.length).toBe(1);
    expect(glides(writes[0]!).length).toBe(1);
    expect(writes[0]!.split("\x1b[?2026l").length - 1).toBe(2);
  });

  /**
   * st's offset base after a stream (OSC 2032 ; o sets it, ; m adds to it),
   * in thousandths of a row: where st's offset rests once every easing term
   * has run out. At rest it must be 0, or st draws the content off its rows
   * and keeps the lines its scrolls pushed out painted (Nov 7).
   */
  function stBase(out: string, base = 0): number {
    for (const match of out.matchAll(/\x1b\]2032;([om]);(-?\d+)(?:;-?\d+;\d+)?\x1b\\/g)) {
      base = match[1] === "o" ? Number(match[2]) : base + Number(match[2]);
    }
    return base;
  }

  for (const tasks of [false, true]) {
    for (const seed of [1, 2, 3]) {
      test(`after any run of grows, shrinks, replaced steps and scrolls st rests at 0 on a full repaint's screen (Tasks panel ${tasks ? "open" : "closed"}, run ${seed})`, () => {
        setSystemTime(new Date("2026-10-29T00:00:00Z"));
        try {
          let random = seed * 7919;
          const next = (n: number) => {
            random = (random * 1103515245 + 12345) % 2147483648;
            return random % n;
          };
          const state = conversationState();
          if (tasks) openTasks(state);
          liveTurn(state, 1);
          let out = capture(state);
          screen.feed(out);
          let step = 1;
          for (let op = 0; op < 24; op++) {
            const kind = next(4);
            if (kind <= 1) liveTurn(state, 1 + next(12), step++);
            else if (kind === 2) {
              markScrollIntent(state);
              state.scrollOffset = Math.max(0, state.scrollOffset + next(9) - 4);
            } else {
              markScrollIntent(state);
              state.scrollOffset = 0;
            }
            out += frames(state, 4 * next(30));
          }
          markScrollIntent(state);
          state.scrollOffset = 0;
          out += frames(state, 600);
          expect(glides(out).length).toBeGreaterThan(0);
          expect(stBase(out)).toBe(0);
          const settled = screen.plainRows();
          setSmoothScroller(state, null);
          const fresh = new TerminalScreen(state.rows, state.cols);
          invalidateFrame(state);
          fresh.feed(capture(state));
          expect(settled).toEqual(fresh.plainRows());
        } finally {
          setSystemTime();
        }
      });
    }
  }

  test("in a conversation shorter than the pane nothing slides", () => {
    const state = conversationState();
    state.messages = state.messages.slice(0, 2);
    liveTurn(state, 3);
    settle(state, 0);
    liveTurn(state, 1, 1);
    expect(glides(frames(state))).toEqual([]);
    liveTurn(state, 3, 2);
    expect(glides(frames(state))).toEqual([]);
  });

  // The live turn's newest step got taller as the key was pressed: the view it
  // switches to is all new rows, nothing of the slide carries on. Pressed at
  // any point of the slide (st draws it for 100 ms); one test per point, each
  // well inside the timeout on a loaded machine.
  for (const key of ["Ctrl+O", "Ctrl+I"] as const) {
    for (let into = 4; into < 100; into += 4) {
      test(`${key} ${into} ms into the bottom's slide shows the new view in place`, () => {
        setSystemTime(new Date("2026-10-29T00:00:00Z"));
        try {
          const state = conversationState();
          liveTurn(state, 1);
          settle(state, 0);
          liveTurn(state, 11, 1);
          expect(eases(frames(state, into)).length).toBe(1);
          if (key === "Ctrl+O") preserveViewportAcrossHistoryMutation(state, () => { state.showTurnWork = !state.showTurnWork; });
          else toggleToolOutputPreservingViewport(state);
          expect({ into, moves: motion(frames(state)) }).toEqual({ into, moves: [] });
          const settled = screen.plainRows();
          setSmoothScroller(state, null);
          const fresh = new TerminalScreen(state.rows, state.cols);
          invalidateFrame(state);
          fresh.feed(capture(state));
          expect(settled).toEqual(fresh.plainRows());
        } finally {
          setSystemTime();
        }
      });
    }
  }

  test("Ctrl+I at the bottom still snaps even when only the last turn changes", () => {
    const state = conversationState();
    settle(state, 0);
    toggleToolOutputPreservingViewport(state);
    expect(glides(frames(state))).toEqual([]);
    toggleToolOutputPreservingViewport(state);
    expect(glides(frames(state))).toEqual([]);
  });
});

