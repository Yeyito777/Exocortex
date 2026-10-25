import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, smoothScrollRects } from "./render";
import { createInitialState, type RenderState } from "./state";
import { invalidateFrame, setScrollRegionsEnabled } from "./frame";
import {
  SmoothScroller, easeRemaining, offsetPayload, parseSmoothScrollReport, rectsPayload, setSmoothScroller,
} from "./smoothscroll";
import { TerminalScreen } from "./testhelpers/terminalscreen";
import { TerminalControlBuffer } from "./terminalclipboard";

function capture(state: RenderState): string {
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    render(state);
  } finally {
    process.stdout.write = write as typeof process.stdout.write;
  }
  return out;
}

function historyState(tasks: boolean): RenderState {
  const state = createInitialState();
  state.cols = 140;
  state.rows = 30;
  state.convId = "c0";
  state.sidebar.open = true;
  state.sidebar.conversations = Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`,
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    createdAt: 1,
    updatedAt: 1000 - i,
    messageCount: 1,
    title: `Conversation ${String(i).padStart(2, "0")}`,
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: i,
    tasks: [],
  }));
  if (tasks) {
    state.sidebar.conversations[0].tasks = [{ id: "child", kind: "subagent", title: "Inspect renderer flow", startedAt: Date.now() - 2_000 }];
  }
  state.messages = Array.from({ length: 80 }, (_, index) => ({
    role: "assistant" as const,
    blocks: [{ type: "text" as const, text: `L${String(index).padStart(2, "0")} ${"history words ".repeat(8)}` }],
    metadata: null,
  }));
  return state;
}

function fullRepaint(state: RenderState): TerminalScreen {
  const screen = new TerminalScreen(state.rows, state.cols);
  invalidateFrame(state);
  screen.feed(capture(state));
  return screen;
}

const offsets = (out: string) => [...out.matchAll(/\x1b\]2032;o;(-?\d+)\x1b\\/g)].map(match => Number(match[1]));
const regionScrolls = (out: string) => [...out.matchAll(/\x1b\[\d+;\d+r\x1b\[(\d+)([ST])\x1b\[r/g)].map(match => `${match[2]}${match[1]}`);

describe("protocol", () => {
  test("DECRQM replies for mode 2032", () => {
    expect(parseSmoothScrollReport("\x1b[?2032;1$y")).toBe(true);
    expect(parseSmoothScrollReport("\x1b[?2032;2$y")).toBe(true);
    expect(parseSmoothScrollReport("\x1b[?2032;0$y")).toBe(false);
    expect(parseSmoothScrollReport("\x1b[?2032;4$y")).toBe(false);
    expect(parseSmoothScrollReport("\x1b[?2026;1$y")).toBeNull();
  });

  test("the reply reaches the control-sequence handler, not the keyboard", () => {
    const input: string[] = [];
    const control: string[] = [];
    const buffer = new TerminalControlBuffer(data => input.push(data), sequence => control.push(sequence));
    buffer.feed("\x1b[?2032;2$yj");
    expect(control).toEqual(["\x1b[?2032;2$y"]);
    expect(input).toEqual(["j"]);
    buffer.dispose();
  });

  test("payloads", () => {
    expect(rectsPayload([{ top: 3, left: 29, bottom: 40, right: 100 }, { top: 9, left: 101, bottom: 40, right: 140 }]))
      .toBe("\x1b]2032;r;3,29,40,100;9,101,40,140\x1b\\");
    expect(rectsPayload([])).toBe("\x1b]2032;r\x1b\\");
    expect(offsetPayload(-250)).toBe("\x1b]2032;o;-250\x1b\\");
  });

  test("the ease runs from 1 to exactly 0", () => {
    expect(easeRemaining(0)).toBe(1);
    expect(easeRemaining(0.5)).toBeCloseTo(0.125);
    expect(easeRemaining(1)).toBe(0);
    expect(easeRemaining(3)).toBe(0);
  });

  test("rectangles leave the Tasks panel's columns still above the row below it", () => {
    expect(smoothScrollRects({ start: 3, end: 27 }, 29, 112, null, 3)).toEqual([{ top: 3, left: 29, bottom: 27, right: 140 }]);
    expect(smoothScrollRects({ start: 3, end: 27 }, 29, 112, 90, 8)).toEqual([
      { top: 3, left: 29, bottom: 27, right: 89 },
      { top: 8, left: 90, bottom: 27, right: 140 },
    ]);
  });
});

describe("SmoothScroller", () => {
  let now = 0;
  const scroller = () => new SmoothScroller(100, () => now);
  beforeEach(() => { now = 1000; });

  test("lays out the next whole row in the direction of travel and offsets the rest", () => {
    const smooth = scroller();
    expect(smooth.layout(10, 100, 0, 20, "a")).toBe(10);
    expect(smooth.afterFlush(0, [{ top: 3, left: 1, bottom: 20, right: 80 }])).toContain("2032;r;3,1,20,80");
    // Towards older history: the grid is ahead (ceil), drawn higher (negative).
    expect(smooth.layout(13, 100, 0, 20, "a")).toBe(10);
    now += 8;
    expect(smooth.needsLayout()).toBe(true);
    const grid = smooth.layout(13, 100, 0, 20, "a");
    expect(grid).toBe(11);
    const out = smooth.afterFlush(-1, [{ top: 3, left: 1, bottom: 20, right: 80 }]);
    const [offset] = offsets(out);
    expect(offset).toBeLessThan(0);
    expect(offset).toBeGreaterThan(-1000);
    // It ends at rest on the target with offset 0.
    for (let i = 0; i < 20; i++) {
      now += 8;
      if (smooth.needsLayout()) {
        const before = grid;
        const next = smooth.layout(13, 100, 0, 20, "a");
        smooth.afterFlush(-(next - before), [{ top: 3, left: 1, bottom: 20, right: 80 }]);
      } else {
        smooth.tick();
      }
    }
    expect(smooth.layout(13, 100, 0, 20, "a")).toBe(13);
    smooth.afterFlush(0, [{ top: 3, left: 1, bottom: 20, right: 80 }]);
    expect(smooth.tick()).toBe("");
    expect(smooth.busy()).toBe(false);
  });

  test("towards newer history the grid is behind (floor) and drawn lower", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, [{ top: 3, left: 1, bottom: 20, right: 80 }]);
    smooth.layout(7, 100, 0, 20, "a");
    now += 8;
    expect(smooth.layout(7, 100, 0, 20, "a")).toBe(9);
    const [offset] = offsets(smooth.afterFlush(1, [{ top: 3, left: 1, bottom: 20, right: 80 }]));
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(1000);
  });

  test("pinning and a new context never animate", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, [{ top: 3, left: 1, bottom: 20, right: 80 }]);
    expect(smooth.layout(15, 100, 5, 20, "a")).toBe(15);
    expect(smooth.busy()).toBe(false);
    expect(smooth.layout(40, 100, 0, 20, "b")).toBe(40);
    expect(smooth.busy()).toBe(false);
  });

  test("jumps further than a screen glide in from one screen away", () => {
    const smooth = scroller();
    smooth.layout(0, 1000, 0, 20, "a");
    smooth.afterFlush(0, [{ top: 3, left: 1, bottom: 20, right: 80 }]);
    now += 1;
    const grid = smooth.layout(500, 1000, 0, 20, "a");
    expect(grid).toBeGreaterThanOrEqual(480);
    expect(grid).toBeLessThan(500);
    // The jump itself is a repaint: nothing to glide from, no stale offset.
    expect(offsets(smooth.afterFlush(0, [{ top: 3, left: 1, bottom: 20, right: 80 }]))).toEqual([]);
    expect(smooth.busy()).toBe(true);
  });

  test("content that moved by itself glides from where it was drawn", () => {
    const smooth = scroller();
    smooth.layout(0, 100, 0, 20, "a");
    smooth.afterFlush(0, [{ top: 3, left: 1, bottom: 20, right: 80 }]);
    smooth.layout(0, 100, 0, 20, "a");
    // A streamed line pushed everything up one row: draw it a row lower.
    expect(offsets(smooth.afterFlush(1, [{ top: 3, left: 1, bottom: 20, right: 80 }]))).toEqual([1000]);
    now += 50;
    const [half] = offsets(smooth.tick());
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1000);
    now += 60;
    expect(offsets(smooth.tick())).toEqual([0]);
    expect(smooth.busy()).toBe(false);
  });

  test("a resize makes it send its rectangles again", () => {
    const smooth = scroller();
    smooth.layout(0, 100, 0, 20, "a");
    const rects = [{ top: 3, left: 1, bottom: 20, right: 80 }];
    expect(smooth.afterFlush(0, rects)).toContain("2032;r;");
    smooth.layout(0, 100, 0, 20, "a");
    expect(smooth.afterFlush(0, rects)).toBe("");
    smooth.terminalReset();
    smooth.layout(0, 100, 0, 20, "a");
    expect(smooth.afterFlush(0, rects)).toContain("2032;r;");
  });
});

describe("rendering with app-driven smooth scrolling", () => {
  let now = 0;
  beforeEach(() => {
    now = 1000;
    setScrollRegionsEnabled(true);
  });
  afterEach(() => setScrollRegionsEnabled(null));

  function animate(state: RenderState, smooth: SmoothScroller, screen: TerminalScreen): string[] {
    const outs: string[] = [];
    for (let i = 0; i < 40 && (smooth.busy() || i === 0); i++) {
      now += 8;
      const out = smooth.needsLayout() ? capture(state) : smooth.tick();
      if (out) {
        outs.push(out);
        screen.feed(out);
      }
    }
    return outs;
  }

  for (const tasks of [false, true]) {
    test(`a wheel step is laid out row by row inside synchronized updates, then rests on a full repaint's screen (Tasks panel ${tasks ? "open" : "closed"})`, () => {
      const state = historyState(tasks);
      const smooth = new SmoothScroller(100, () => now);
      setSmoothScroller(state, smooth);
      const screen = new TerminalScreen(state.rows, state.cols);
      screen.feed(capture(state));
      state.scrollOffset = 20;
      screen.feed(capture(state));
      now += 200;
      screen.feed(capture(state));

      state.scrollOffset += 3;
      screen.feed(capture(state));
      const outs = animate(state, smooth, screen);
      const crossings = outs.filter(out => regionScrolls(out).length > 0);
      expect(crossings.length).toBeGreaterThanOrEqual(2);
      for (const out of crossings) {
        expect(out.startsWith("\x1b[?2026h")).toBe(true);
        // The offset rides in the same synchronized update as the scroll.
        expect(out.indexOf("\x1b]2032;o;")).toBeGreaterThan(out.indexOf("\x1b[r"));
        expect(out.indexOf("\x1b]2032;o;")).toBeLessThan(out.indexOf("\x1b[?2026l"));
      }
      expect(regionScrolls(outs.join("")).every(scroll => scroll.startsWith("T"))).toBe(true);
      // Between rows only offsets: tiny.
      for (const out of outs.filter(out => regionScrolls(out).length === 0)) expect(out.length).toBeLessThan(40);
      expect(offsets(outs.join("")).at(-1)).toBe(0);
      expect(smooth.busy()).toBe(false);
      expect(screen.plainRows()).toEqual(fullRepaint(state).plainRows());
      setSmoothScroller(state, null);
    });
  }

  test("with the Tasks panel the band includes the rows beside it and the panel's columns stay out of the rectangles", () => {
    const state = historyState(true);
    const smooth = new SmoothScroller(100, () => now);
    setSmoothScroller(state, smooth);
    const out = capture(state);
    const panel = state.layout.taskPanelRect!;
    const rects = /\x1b\]2032;r((?:;\d+,\d+,\d+,\d+)*)\x1b\\/.exec(out)![1].slice(1).split(";").map(rect => rect.split(",").map(Number));
    expect(rects).toHaveLength(2);
    expect(rects[0]).toEqual([3, rects[0][1], 2 + state.layout.messageAreaHeight, panel.left - 1]);
    expect(rects[1][0]).toBe(panel.bottom + 2);
    expect(rects[1][1]).toBe(panel.left);
    state.scrollOffset = 10;
    capture(state);
    now += 200;
    capture(state);
    state.scrollOffset += 2;
    capture(state);
    now += 20;
    const step = capture(state);
    expect(step).toMatch(/\x1b\[3;\d+r\x1b\[\d+T/);
    setSmoothScroller(state, null);
  });

  test("without the terminal's support nothing changes", () => {
    const state = historyState(true);
    const out = capture(state);
    expect(out).not.toContain("\x1b]2032");
    state.scrollOffset = 10;
    capture(state);
    state.scrollOffset += 3;
    const step = capture(state);
    expect(step).not.toContain("\x1b]2032");
    // Rows beside the panel stay out of the band, as before.
    expect(step).toMatch(new RegExp(`\\x1b\\[${state.layout.taskPanelRect!.bottom + 2};\\d+r\\x1b\\[3T`));
  });
});
