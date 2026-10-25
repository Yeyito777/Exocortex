import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, smoothScrollRects } from "./render";
import { createInitialState, type RenderState } from "./state";
import { invalidateFrame, setScrollRegionsEnabled } from "./frame";
import {
  SMOOTH_SCROLL_MARGIN_ROWS, SmoothScroller, markScrollIntent, easeRemaining, offsetPayload, parseSmoothScrollReport, rectsPayload, setSmoothScroller,
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
  const rects = [{ top: 3, left: 1, bottom: 20, right: 80 }];
  const scroller = () => new SmoothScroller(100, () => now, 30);
  beforeEach(() => { now = 1000; });
  const moves = (out: string) => [...out.matchAll(/\x1b\]2032;m;(-?\d+)(?:;(-?\d+);(\d+))?\x1b\\/g)]
    .map(match => [Number(match[1]), Number(match[2] ?? 0)]);

  /** Run the animation to rest the way main.ts does; returns everything sent. */
  function settle(smooth: SmoothScroller, logical: number): string {
    let out = "";
    for (let i = 0; i < 40 && smooth.busy(); i++) {
      now += 8;
      if (!smooth.needsLayout()) continue;
      const before = (smooth as unknown as { grid: number }).grid;
      const grid = smooth.layout(logical, 100, 0, 20, "a");
      out += smooth.afterFlush(before - grid, rects);
    }
    return out;
  }

  test("an input is one move: the step, eased out by st, and rows laid out ahead", () => {
    const smooth = scroller();
    expect(smooth.layout(10, 100, 0, 20, "a")).toBe(10);
    expect(smooth.afterFlush(0, rects)).toBe(rectsPayload(rects));
    // Three rows towards older history: laid out ahead (the row just past
    // the position), so the offset (position - grid) is drawn higher, over
    // lines st kept below.
    smooth.intend();
    const grid = smooth.layout(13, 100, 0, 20, "a");
    expect(grid).toBe(11);
    const out = smooth.afterFlush(10 - grid, rects);
    // base += 3 (target) - 1 (row laid out); -3 rows easing from now: no jump.
    expect(moves(out)).toEqual([[2000, -3000]]);
    expect(out).toContain(";100\x1b\\");
    // Each further row is a region scroll plus base -1; nothing in between.
    const rest = settle(smooth, 13);
    expect(moves(rest)).toEqual([[-1000, 0], [-1000, 0]]);
    expect(smooth.busy()).toBe(false);
    expect(smooth.needsLayout()).toBe(false);
  });

  test("towards newer history rows are laid out behind (floor) and drawn lower", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.intend();
    const grid = smooth.layout(7, 100, 0, 20, "a");
    expect(grid).toBe(9);
    expect(moves(smooth.afterFlush(10 - grid, rects))).toEqual([[-2000, 3000]]);
    settle(smooth, 7);
    expect(smooth.busy()).toBe(false);
  });

  test("a second input mid-glide adds to the first without a jump", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.intend();
    const first = smooth.layout(13, 100, 0, 20, "a");
    smooth.afterFlush(10 - first, rects);
    now += 40;
    smooth.intend();
    const second = smooth.layout(16, 100, 0, 20, "a");
    const out = smooth.afterFlush(first - second, rects);
    const [[delta, ease]] = moves(out);
    expect(ease).toBe(-3000);
    expect(delta).toBe(3000 - (second - first) * 1000);
    settle(smooth, 16);
    expect(smooth.busy()).toBe(false);
  });

  test("however fast inputs stack up, rows are laid out at most one past the glide", () => {
    // Trackpad momentum / key repeat: 3 rows every 8 ms, laid out as often as
    // the TUI checks (every 4 ms). The offset st draws stays within a row, so
    // text that re-wraps (beside the Tasks panel) is never shown far from
    // where it was laid out.
    const smooth = scroller();
    const offsetNow = () => (smooth as unknown as { offsetAt(time: number): number }).offsetAt(now);
    smooth.layout(100, 1000, 0, 40, "a");
    smooth.afterFlush(0, rects);
    let logical = 100;
    let worst = 0;
    for (let i = 0; i < 60; i++) {
      now += 4;
      if (i % 2 === 0 && i < 40) {
        logical -= 3;
        smooth.intend();
      }
      const before = (smooth as unknown as { grid: number }).grid;
      const grid = smooth.layout(logical, 1000, 0, 40, "a");
      smooth.afterFlush(before - grid, rects);
      worst = Math.max(worst, Math.abs(offsetNow()));
    }
    expect(worst).toBeLessThanOrEqual(1 + SMOOTH_SCROLL_MARGIN_ROWS);
    for (let i = 0; i < 40 && smooth.busy(); i++) {
      now += 4;
      const before = (smooth as unknown as { grid: number }).grid;
      smooth.afterFlush(before - smooth.layout(logical, 1000, 0, 40, "a"), rects);
    }
    expect(smooth.busy()).toBe(false);
    expect((smooth as unknown as { grid: number }).grid).toBe(logical);
  });

  test("the next row is due before the glide reaches the laid-out one, and the wait says when", () => {
    // st's clock runs a little behind this one; if the glide reached the
    // laid-out rows before the next frame arrived, st would hold it still.
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.intend();
    let grid = smooth.layout(13, 100, 0, 20, "a");
    smooth.afterFlush(10 - grid, rects);
    const position = () => grid + (smooth as unknown as { offsetAt(time: number): number }).offsetAt(now);
    for (let i = 0; i < 200 && smooth.busy(); i++) {
      const wait = smooth.msUntilLayout(16);
      expect(wait).toBeGreaterThanOrEqual(0);
      now += Math.max(1, wait);
      if (!smooth.needsLayout()) continue;
      // Laid out with about a quarter row to spare (a 1 ms step moves < 0.1 row).
      if (grid < 13) expect(grid - position()).toBeGreaterThanOrEqual(SMOOTH_SCROLL_MARGIN_ROWS - 0.1);
      const next = smooth.layout(13, 100, 0, 20, "a");
      smooth.afterFlush(grid - next, rects);
      grid = next;
    }
    expect(grid).toBe(13);
    expect(smooth.busy()).toBe(false);
  });

  test("pinning and a new context never animate", () => {
    const smooth = scroller();
    smooth.layout(10, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    expect(smooth.layout(15, 100, 5, 20, "a")).toBe(15);
    expect(smooth.afterFlush(0, rects)).toBe("");
    expect(smooth.busy()).toBe(false);
    expect(smooth.layout(40, 100, 0, 20, "b")).toBe(40);
    expect(smooth.busy()).toBe(false);
  });

  test("jumps further than a screen glide in from one screen away", () => {
    const smooth = scroller();
    smooth.layout(0, 1000, 0, 20, "a");
    smooth.afterFlush(0, rects);
    now += 1;
    smooth.intend();
    const grid = smooth.layout(500, 1000, 0, 20, "a");
    expect(grid).toBeGreaterThanOrEqual(480);
    expect(grid).toBeLessThan(500);
    // A repaint: st starts over at the laid-out rows and eases from there.
    const out = smooth.afterFlush(0, rects);
    expect(out).toContain(offsetPayload((500 - grid) * 1000));
    expect(moves(out)).toEqual([[0, -(500 - grid) * 1000]]);
    expect(smooth.busy()).toBe(true);
  });

  test("content that moved by itself eases from where it was drawn", () => {
    const smooth = scroller();
    smooth.layout(0, 100, 0, 20, "a");
    smooth.afterFlush(0, rects);
    smooth.layout(0, 100, 0, 20, "a");
    // A streamed line pushed everything up one row: draw it a row lower.
    expect(moves(smooth.afterFlush(1, rects, true))).toEqual([[0, 1000]]);
    expect(smooth.busy()).toBe(true);
    now += 120;
    expect(smooth.busy()).toBe(false);
  });

  test("a resize makes it send its rectangles again", () => {
    const smooth = scroller();
    smooth.layout(0, 100, 0, 20, "a");
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
      if (!smooth.needsLayout()) continue;
      const out = capture(state);
      outs.push(out);
      screen.feed(out);
    }
    return outs;
  }

  for (const tasks of [false, true]) {
    test(`a wheel step is laid out row by row inside synchronized updates, then rests on a full repaint's screen (Tasks panel ${tasks ? "open" : "closed"})`, () => {
      const state = historyState(tasks);
      const smooth = new SmoothScroller(100, () => now, 30);
      setSmoothScroller(state, smooth);
      const screen = new TerminalScreen(state.rows, state.cols);
      screen.feed(capture(state));
      state.scrollOffset = 20;
      screen.feed(capture(state));
      now += 200;
      screen.feed(capture(state));

      markScrollIntent(state);
      state.scrollOffset += 3;
      const first = capture(state);
      screen.feed(first);
      const outs = [first, ...animate(state, smooth, screen)];
      const crossings = outs.filter(out => regionScrolls(out).length > 0);
      expect(crossings.length).toBeGreaterThanOrEqual(2);
      for (const out of crossings) {
        expect(out.startsWith("\x1b[?2026h")).toBe(true);
        // The move rides in the same synchronized update as the scroll.
        expect(out.indexOf("\x1b]2032;m;")).toBeGreaterThan(out.indexOf("\x1b[r"));
        expect(out.indexOf("\x1b]2032;m;")).toBeLessThan(out.indexOf("\x1b[?2026l"));
      }
      expect(regionScrolls(outs.join("")).every(scroll => scroll.startsWith("T"))).toBe(true);
      // Three rows: one eased move, three rows laid out, nothing else.
      expect(regionScrolls(outs.join("")).reduce((sum, scroll) => sum + Number(scroll.slice(1)), 0)).toBe(3);
      expect(outs.join("").match(/\x1b\]2032;m;-?\d+;-?\d+;\d+/g)).toHaveLength(1);
      expect(offsets(outs.join(""))).toEqual([]);
      expect(smooth.busy()).toBe(false);
      expect(screen.plainRows()).toEqual(fullRepaint(state).plainRows());
      setSmoothScroller(state, null);
    });
  }

  test("with the Tasks panel the band includes the rows beside it and the panel's columns stay out of the rectangles", () => {
    const state = historyState(true);
    const smooth = new SmoothScroller(100, () => now, 30);
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
    markScrollIntent(state);
    state.scrollOffset += 2;
    // Rows are laid out ahead of the glide: the input's own frame scrolls.
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
