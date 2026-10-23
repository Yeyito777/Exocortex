import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";
import { flushFrame, invalidateFrame, resolveScrollRegionsSetting, setScrollRegionsEnabled } from "./frame";
import { configureInlineImages, inlineImagesInternalsForTest, setInlineImageMode } from "./inlineimages";
import { invalidateHistoryImagePlacements } from "./historyimages";
import { SIDEBAR_WIDTH } from "./sidebar";
import { TerminalScreen } from "./testhelpers/terminalscreen";

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

/** What a terminal that just got a full repaint of the current frame shows. */
function fullRepaint(state: RenderState): TerminalScreen {
  const screen = new TerminalScreen(state.rows, state.cols);
  invalidateFrame(state);
  invalidateHistoryImagePlacements(state);
  screen.feed(capture(state));
  return screen;
}

function historyState(options: { sidebar: boolean; cols?: number; rows?: number }): RenderState {
  const state = createInitialState();
  state.cols = options.cols ?? 100;
  state.rows = options.rows ?? 24;
  state.convId = "c0";
  state.sidebar.open = options.sidebar;
  // Distinct sidebar rows, so a scroll that dragged them along would show.
  state.sidebar.conversations = Array.from({ length: 30 }, (_, i) => ({
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
  state.messages = Array.from({ length: 60 }, (_, index) => ({
    role: "assistant" as const,
    blocks: [{ type: "text" as const, text: `history row ${String(index).padStart(2, "0")}` }],
    metadata: null,
  }));
  return state;
}

/** Rows (1-based) a payload clears and repaints in full. */
function repaintedRows(out: string): number[] {
  return [...out.matchAll(/\x1b\[(\d+);1H(?:\x1b\[[0-9;]*m)*\x1b\[2K/g)].map(match => Number(match[1]));
}

function region(state: RenderState): { start: number; end: number } {
  return { start: 3, end: 2 + state.layout.messageAreaHeight };
}

beforeEach(() => setScrollRegionsEnabled(true));
afterEach(() => {
  setScrollRegionsEnabled(null);
  inlineImagesInternalsForTest.reset();
});

describe("message-area region scrolls", () => {
  for (const sidebar of [false, true]) {
    test(`1–3 row scrolls emit DECSTBM + SU/SD and repaint only the exposed rows (sidebar ${sidebar ? "open" : "closed"})`, () => {
      const state = historyState({ sidebar });
      capture(state);
      state.scrollOffset = 10;
      capture(state);
      const { start, end } = region(state);

      for (const delta of [1, 2, 3, -1, -2, -3]) {
        state.scrollOffset += delta;
        const out = capture(state);
        const rows = Math.abs(delta);
        // scrollOffset grows toward older history: the content moves down (SD).
        const verb = delta > 0 ? "T" : "S";
        expect(out).toContain(`\x1b[${start};${end}r\x1b[${rows}${verb}\x1b[r`);
        expect(out.startsWith("\x1b[?2026h")).toBe(true);
        expect(out.endsWith("\x1b[?2026l")).toBe(true);

        const exposed = Array.from({ length: rows }, (_, i) => delta > 0 ? start + i : end - rows + 1 + i);
        expect(repaintedRows(out).filter(row => row >= start && row <= end)).toEqual(exposed);
      }
    });
  }

  test("the sidebar is repainted beside the scrolled rows, and nothing else in them", () => {
    const state = historyState({ sidebar: true });
    capture(state);
    state.scrollOffset = 10;
    capture(state);
    const { start, end } = region(state);

    state.scrollOffset -= 2;
    const out = capture(state);
    const repainted = new Set(repaintedRows(out));
    const sidebarWrites = [...out.matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1]))
      .filter(row => row >= start && row <= end && !repainted.has(row));
    const chatWrites = [...out.matchAll(/\x1b\[(\d+);(\d+)H/g)]
      .filter(match => Number(match[2]) === SIDEBAR_WIDTH + 1 && Number(match[1]) >= start && Number(match[1]) <= end - 2);
    // Rows the scroll supplied get their sidebar columns back...
    expect(sidebarWrites.length).toBeGreaterThan(0);
    expect(sidebarWrites.every(row => row <= end - 2)).toBe(true);
    // ...but their history text is not sent again.
    expect(chatWrites).toEqual([]);
  });

  for (const sidebar of [false, true]) {
    test(`after any sequence of scrolls the screen equals a full repaint (sidebar ${sidebar ? "open" : "closed"})`, () => {
      const state = historyState({ sidebar });
      const screen = new TerminalScreen(state.rows, state.cols);
      screen.feed(capture(state));
      state.scrollOffset = 25;
      screen.feed(capture(state));

      for (const delta of [1, 3, -2, 1, -1, 4, -3, 9, -9, 2, -18, 18, 40, -40]) {
        state.scrollOffset = Math.max(0, state.scrollOffset + delta);
        screen.feed(capture(state));
        expect(screen.plainRows()).toEqual(fullRepaint(state).plainRows());
      }
    });
  }

  test("following streamed output with the sidebar open scrolls the region and matches a full repaint", () => {
    const state = historyState({ sidebar: true });
    const screen = new TerminalScreen(state.rows, state.cols);
    screen.feed(capture(state));

    for (let i = 0; i < 6; i++) {
      state.messages.push({
        role: "assistant",
        blocks: [{ type: "text", text: `streamed line ${i}` }],
        metadata: null,
      });
      const out = capture(state);
      expect(out).toMatch(/\x1b\[3;\d+r\x1b\[\d+S\x1b\[r/);
      screen.feed(out);
      expect(screen.plainRows()).toEqual(fullRepaint(state).plainRows());
    }
  });

  test("the task panel beside scrolled history stays correct", () => {
    const state = historyState({ sidebar: true, cols: 140, rows: 30 });
    state.sidebar.conversations[0].tasks = [{
      id: "child",
      kind: "subagent",
      title: "Inspect renderer flow",
      startedAt: Date.now() - 2_000,
    }];
    state.messages = Array.from({ length: 60 }, (_, index) => ({
      role: "assistant" as const,
      blocks: [{ type: "text" as const, text: `L${String(index).padStart(2, "0")} ${"history words ".repeat(8)}` }],
      metadata: null,
    }));
    const screen = new TerminalScreen(state.rows, state.cols);
    screen.feed(capture(state));
    expect(state.layout.taskPanelRect).not.toBeNull();
    state.scrollOffset = 20;
    screen.feed(capture(state));

    let scrolled = 0;
    for (const delta of [1, 2, -1, 3, -3, 1]) {
      state.scrollOffset += delta;
      const out = capture(state);
      if (/\x1b\[3;\d+r/.test(out)) scrolled++;
      screen.feed(out);
      expect(screen.plainRows()).toEqual(fullRepaint(state).plainRows());
    }
    expect(scrolled).toBeGreaterThan(0);
  });

  test("jumps of a page or more repaint the region without scrolling it", () => {
    const state = historyState({ sidebar: true });
    capture(state);
    const height = state.layout.messageAreaHeight;
    state.scrollOffset = height;
    const out = capture(state);
    expect(out).not.toMatch(/\x1b\[\d+;\d+r/);
    const { start, end } = region(state);
    expect(repaintedRows(out).filter(row => row >= start && row <= end)).toHaveLength(height);
  });

  test("resizes still repaint everything", () => {
    const state = historyState({ sidebar: true });
    capture(state);
    state.scrollOffset = 10;
    capture(state);
    state.rows = 26;
    invalidateFrame(state);
    state.scrollOffset = 11;
    const out = capture(state);
    expect(out).not.toMatch(/\x1b\[\d+;\d+r/);
    expect(repaintedRows(out)).toHaveLength(state.rows);
  });

  test("images are placed again after a region scroll and match a full repaint", async () => {
    configureInlineImages({
      fetch: async request => ({ format: "png", width: request.width, height: Math.round(request.width / 2), base64: "UE5H" }),
      onChange: () => {},
    });
    setInlineImageMode("kitty");
    const state = historyState({ sidebar: true, rows: 40 });
    const ref = { id: "e".repeat(64), mediaType: "image/png" as const, width: 400, height: 200, sizeBytes: 5000, name: "chart.png" };
    state.messages.splice(20, 0, {
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "c1", toolName: "attach", input: { paths: ["chart.png"] }, summary: "chart.png" },
        { type: "tool_result", toolCallId: "c1", toolName: "attach", output: "Attached 1 image", isError: false, images: [ref] },
        { type: "text", text: "Here is the chart." },
      ],
      metadata: null,
    });
    const screen = new TerminalScreen(state.rows, state.cols);
    screen.feed(capture(state));
    const imageLine = state.historyLineAnchors.findIndex(anchor => anchor.images);
    // Image top on viewport row 6.
    state.scrollOffset = state.layout.totalLines - state.layout.messageAreaHeight - (imageLine - 6);
    screen.feed(capture(state));
    await Bun.sleep(0);
    screen.feed(capture(state));
    expect(screen.placements()).toHaveLength(1);

    // Scroll so the image slides partly out of the top, then back, then away.
    let scrolled = 0;
    for (const delta of [-2, -3, -3, 2, 3, 3, 1, -12, 12, 30]) {
      state.scrollOffset += delta;
      const out = capture(state);
      if (/\x1b\[3;\d+r/.test(out)) scrolled++;
      screen.feed(out);
      const full = fullRepaint(state);
      expect(screen.plainRows()).toEqual(full.plainRows());
      expect(screen.placements()).toEqual(full.placements());
      // No image data is sent again for a scroll.
      expect(out).not.toContain("a=t,");
    }
    expect(scrolled).toBeGreaterThanOrEqual(6);
  });
});

describe("flushFrame", () => {
  test("tells the graphics callback whether the region scrolled", () => {
    const owner = {};
    const rowsFor = (first: number) => Array.from({ length: 12 }, (_, i) => `\x1b[${i + 1};1H\x1b[2Kline ${first + i}`);
    const seen: boolean[] = [];
    const frame = (first: number) => ({
      rows: rowsFor(first),
      cursor: "",
      scrollRegion: { start: 2, end: 11 },
      viewStart: first,
      graphics: (scrolled: boolean) => {
        seen.push(scrolled);
        return "";
      },
    });
    const write = process.stdout.write;
    let out = "";
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    try {
      flushFrame(owner, frame(0));
      flushFrame(owner, frame(0));
      out = "";
      flushFrame(owner, frame(1));
    } finally {
      process.stdout.write = write;
    }
    expect(seen).toEqual([false, false, true]);
    expect(out).toContain("\x1b[2;11r\x1b[1S\x1b[r");
  });
});

describe("tui.scrollRegions: false", () => {
  test("keeps the older optimization: LF/RI region scrolls, full width only", () => {
    setScrollRegionsEnabled(false);
    const closed = historyState({ sidebar: false });
    capture(closed);
    closed.scrollOffset = 20;
    capture(closed);
    closed.scrollOffset -= 2;
    const up = capture(closed);
    const { start, end } = region(closed);
    expect(up).toContain(`\x1b[${start};${end}r\x1b[${end};1H\n\n\x1b[r`);
    expect(up).not.toMatch(/\x1b\[\d+S/);

    const open = historyState({ sidebar: true });
    capture(open);
    open.scrollOffset = 20;
    capture(open);
    open.scrollOffset -= 2;
    const repaint = capture(open);
    expect(repaint).not.toMatch(/\x1b\[\d+;\d+r/);
    expect(repaintedRows(repaint).filter(row => row >= start && row <= end)).toHaveLength(open.layout.messageAreaHeight);
  });

  test("config.json tui.scrollRegions defaults to on", () => {
    expect(resolveScrollRegionsSetting(() => ({}))).toBe(true);
    expect(resolveScrollRegionsSetting(() => ({ tui: { scrollRegions: true } }))).toBe(true);
    expect(resolveScrollRegionsSetting(() => ({ tui: { scrollRegions: false } }))).toBe(false);
    expect(resolveScrollRegionsSetting(() => { throw new Error("unreadable"); })).toBe(true);
  });
});
