import { describe, expect, test } from "bun:test";
import { MAX_TASK_PANEL_HEIGHT, isTaskPanelExpanded, toggleTaskPanelExpansion } from "./activitypanel";
import { handleEvent } from "./events";
import { stripAnsi } from "./historycursor";
import type { ConversationTaskSummary } from "./messages";
import { cursorZone, handleMouseEvent } from "./mouse";
import { render } from "./render";
import {
  isScratchpadExpanded,
  layoutSidePanels,
  MAX_SCRATCHPAD_PANEL_HEIGHT,
  parseScratchpad,
  renderScratchpadPanel,
  scratchpadHeaderCount,
  scratchpadOpenCount,
  toggleScratchpadExpansion,
  truncateRuns,
  wrapRuns,
} from "./scratchpadpanel";
import { createInitialState, type RenderState } from "./state";
import { ScratchpadStore } from "./scratchpadstore";
import { scratchpadHash } from "@exocortex/shared/scratchpad";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { termWidth } from "./textwidth";
import { theme } from "./theme";

const MOCK = [
  "# Today",
  "- [ ] ECO: Lectures 6–8 slides",
  "- [ ] MAT: TQ3 prep **Wed 11:00**",
  "- [ ] Z Fellows video + submit",
  "- [x] ECO Writing 6",
  "- [X] VIC186 narrative printed",
  "",
  "## This week",
  "- [ ] J6 Mon 23:59",
  "- [ ] Prep 9 Wed 9:00",
  "- [ ] SIF application **Nov 15**",
  "",
  "### Notes",
  "Claude main renews Nov 8 ($200).",
  "- Option+drag selects text in st now.",
].join("\n");

const NOW = Date.UTC(2026, 10, 7, 15, 0, 0);
const plain = (lines: string[]) => lines.map(stripAnsi);

function conversation(state: RenderState, id: string, tasks: ConversationTaskSummary[] = []) {
  return {
    id, provider: state.provider, model: state.model, effort: state.effort, fastMode: state.fastMode,
    createdAt: 1, updatedAt: 2, messageCount: 0, title: id, marked: false, pinned: false, streaming: false,
    unread: false, sortOrder: 0, tasks,
  };
}

function tasks(count: number): ConversationTaskSummary[] {
  return Array.from({ length: count }, (_, i) => ({ id: `bash:${i}`, kind: "background" as const, title: `Command ${i}`, startedAt: NOW - 1_000, toolName: "bash" }));
}

/** What the daemon sends: the contents (held by hash), and the summary naming them. */
function hold(state: RenderState, convId: string, content: string): void {
  const hash = scratchpadHash(content);
  state.scratchpads.put(hash, content);
  const summary = state.sidebar.conversations.find(conversation => conversation.id === convId);
  if (summary) summary.scratchpad = hash;
}

function stateWith(content: string | null, taskList: ConversationTaskSummary[] = []): RenderState {
  const state = createInitialState();
  state.convId = "conv";
  state.sidebar.conversations = [conversation(state, "conv", taskList), conversation(state, "other")];
  if (content !== null) hold(state, "conv", content);
  return state;
}

describe("scratchpad markdown subset", () => {
  test("headings, to-dos, done items, bullets and notes, blank lines dropped", () => {
    const lines = parseScratchpad(MOCK);
    expect(lines.map(line => line.kind)).toEqual([
      "heading", "open", "open", "open", "done", "done", "heading", "open", "open", "open", "heading", "note", "bullet",
    ]);
    expect(lines[0].runs).toEqual([{ text: "Today", urgent: false }]);
    expect(lines[2].runs).toEqual([{ text: "MAT: TQ3 prep ", urgent: false }, { text: "Wed 11:00", urgent: true }]);
    expect(lines[12].runs).toEqual([{ text: "Option+drag selects text in st now.", urgent: false }]);
  });

  test("nested items indent, an unpaired ** stays, an empty checkbox is still a to-do", () => {
    const lines = parseScratchpad("- [ ] parent\n  - [ ] child\n    * deeper\n- [ ]\nhalf **open\n1. numbered");
    expect(lines.map(line => [line.kind, line.indent])).toEqual([["open", 0], ["open", 2], ["bullet", 4], ["open", 0], ["note", 0], ["note", 0]]);
    expect(lines[4].runs).toEqual([{ text: "half **open", urgent: false }]);
    expect(lines[5].runs).toEqual([{ text: "1. numbered", urgent: false }]);
  });

  test("the header counts open to-dos, and shows nothing without checkboxes", () => {
    const lines = parseScratchpad(MOCK);
    expect(scratchpadOpenCount(lines)).toBe(6);
    expect(scratchpadHeaderCount(lines)).toBe("6");
    expect(scratchpadHeaderCount(parseScratchpad("- [x] all done"))).toBe("0");
    expect(scratchpadHeaderCount(parseScratchpad("# Notes\njust text\n- a bullet"))).toBe("");
  });

  test("rows: ○ and ✓ glyphs, • bullets, no markup, urgent text in the warning colour", () => {
    const state = stateWith(MOCK);
    toggleScratchpadExpansion(state);
    const panel = renderScratchpadPanel(state, 50, 40)!;
    const rows = plain(panel.lines);
    expect(rows[0]).toBe(`╭─ Scratchpad ${"─".repeat(48 - 17)} 6 ─╮`);
    expect(rows[1]).toBe(`│ Today${" ".repeat(41)} │`);
    expect(rows[3]).toStartWith("│ ○ MAT: TQ3 prep Wed 11:00 ");
    expect(rows[5]).toStartWith("│ ✓ ECO Writing 6 ");
    expect(rows[12]).toStartWith("│ Claude main renews Nov 8 ($200).");
    expect(rows[13]).toStartWith("│ • Option+drag selects text in st now.");
    expect(rows.join("\n")).not.toContain("**");
    expect(rows.join("\n")).not.toContain("[ ]");
    expect(panel.lines[3]).toContain(`${theme.warning}Wed 11:00`);
    expect(panel.lines[5]).toContain(`${theme.dim}${theme.text}ECO Writing 6`);
    expect(panel.lines[1]).toContain(theme.bold);
    expect(panel.lines[12]).toContain(`${theme.muted}Claude main`);
    expect(panel.lines.every(line => termWidth(stripAnsi(line)) === 50)).toBe(true);
  });

  test("a header without checkboxes has no count", () => {
    expect(plain(renderScratchpadPanel(stateWith("plain note"), 40, 20)!.lines)[0]).toBe(`╭─ Scratchpad ${"─".repeat(38 - 13)}╮`);
  });

  test("long lines truncate with an ellipsis collapsed and wrap under their text expanded", () => {
    const runs = [{ text: "Submit the ", urgent: false }, { text: "SIF application", urgent: true }, { text: " before the deadline", urgent: false }];
    expect(truncateRuns(runs, 12)).toEqual([{ text: "Submit the", urgent: false }, { text: "…", urgent: false }]);
    expect(truncateRuns(runs, 20)).toEqual([{ text: "Submit the ", urgent: false }, { text: "SIF appl", urgent: true }, { text: "…", urgent: true }]);
    expect(truncateRuns(runs, 46)).toEqual(runs);
    expect(wrapRuns(runs, 20).map(row => row.map(run => run.text).join(""))).toEqual(["Submit the SIF", "application before", "the deadline"]);
    expect(wrapRuns([{ text: "x".repeat(25), urgent: false }], 10).map(row => row[0].text)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);

    const long = `- [ ] ${"word ".repeat(30).trim()}`;
    const state = stateWith(long);
    const collapsed = plain(renderScratchpadPanel(state, 100, 20)!.lines);
    expect(collapsed).toHaveLength(3);
    expect(collapsed[0].length).toBe(50);
    expect(collapsed[1]).toEndWith("… │");
    toggleScratchpadExpansion(state);
    const expanded = plain(renderScratchpadPanel(state, 100, 20)!.lines);
    expect(expanded[0].length).toBe(75);
    expect(expanded.length).toBeGreaterThan(3);
    expect(expanded[2]).toMatch(/^│ {3}word/);
  });
});

describe("collapsed scratchpad", () => {
  test("shows what fits under its cap and counts the rest on a ▸ N more row, with no hint", () => {
    const many = Array.from({ length: 20 }, (_, i) => `- [ ] item ${i}`).join("\n");
    const state = stateWith(many);
    const panel = renderScratchpadPanel(state, 50, 40)!;
    const rows = plain(panel.lines);
    expect(rows).toHaveLength(MAX_SCRATCHPAD_PANEL_HEIGHT);
    expect(rows.at(-2)).toBe(`│ ▸ ${20 - (MAX_SCRATCHPAD_PANEL_HEIGHT - 3)} more${" ".repeat(48 - 2 - 9)} │`);
    expect(rows.join("\n")).not.toContain("click");
    expect(panel.toggleable).toBe(true);

    // Shorter than the cap: the rows it is given.
    const short = plain(renderScratchpadPanel(state, 50, 6)!.lines);
    expect(short).toHaveLength(6);
    expect(short.at(-2)).toContain(`▸ ${20 - 3} more`);

    // Everything fits: nothing to expand.
    const fits = renderScratchpadPanel(stateWith("- [ ] one\n- [ ] two"), 50, 40)!;
    expect(plain(fits.lines)).toHaveLength(4);
    expect(fits.toggleable).toBe(false);
  });

  test("no panel for a missing or blank file, another conversation's file, or a narrow pane", () => {
    expect(renderScratchpadPanel(stateWith(null), 50, 40)).toBeNull();
    expect(renderScratchpadPanel(stateWith("\n \n"), 50, 40)).toBeNull();
    const state = stateWith(MOCK);
    state.convId = "other";
    expect(renderScratchpadPanel(state, 50, 40)).toBeNull();
    expect(renderScratchpadPanel(stateWith(MOCK), 29, 40)).toBeNull();
    expect(layoutSidePanels(stateWith(MOCK, tasks(2)), 60, 40, NOW)).toMatchObject({ panel: null, scratchpad: null, column: null, historyWidth: 60 });
  });
});

describe("the right-hand column", () => {
  test("Scratchpad sits directly below Tasks, or at the top without them", () => {
    const both = layoutSidePanels(stateWith(MOCK, tasks(2)), 120, 40, NOW);
    expect(plain(both.panel!.lines)[0]).toContain("Tasks");
    expect(plain(both.scratchpad!.lines)[0]).toContain("Scratchpad");
    expect(both.column).toEqual({ width: 50, height: both.panel!.lines.length + both.scratchpad!.lines.length });
    expect(both.historyWidth).toBe(120 - 50 - 1);

    const alone = layoutSidePanels(stateWith(MOCK), 120, 40, NOW);
    expect(alone.panel).toBeNull();
    expect(alone.column).toEqual({ width: 50, height: alone.scratchpad!.lines.length });
  });

  test("on a short pane Tasks leaves room for the smallest Scratchpad card", () => {
    const layout = layoutSidePanels(stateWith(MOCK, tasks(20)), 120, 10, NOW);
    expect(layout.panel!.lines).toHaveLength(6);
    expect(plain(layout.scratchpad!.lines)).toHaveLength(4);
    expect(plain(layout.scratchpad!.lines)[2]).toContain("▸ 12 more");
    // Tasks alone keeps the whole height up to its cap.
    expect(layoutSidePanels(stateWith(null, tasks(20)), 120, 10, NOW).panel!.lines).toHaveLength(Math.min(10, MAX_TASK_PANEL_HEIGHT));
  });

  test("expanding one card collapses the other", () => {
    const state = stateWith(MOCK, tasks(20));
    toggleTaskPanelExpansion(state);
    toggleScratchpadExpansion(state);
    expect(isScratchpadExpanded(state)).toBe(true);
    expect(isTaskPanelExpanded(state)).toBe(false);
    toggleTaskPanelExpansion(state);
    expect(isTaskPanelExpanded(state)).toBe(true);
    expect(isScratchpadExpanded(state)).toBe(false);
  });
});

// ── Through the renderer and mouse ────────────────────────────────

function capture(fn: () => void): void {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try { fn(); } finally { process.stdout.write = write as typeof process.stdout.write; }
}

const mouse = (col: number, row: number, action: "press" | "release", button = 0) =>
  ({ type: "mouse" as const, shift: false, meta: false, ctrl: false, col, row, button, action });

function click(state: RenderState, col: number, row: number): void {
  capture(() => {
    handleMouseEvent(mouse(col, row, "press"), state);
    handleMouseEvent(mouse(col, row, "release"), state);
  });
}

function screen(content: string, taskList: ConversationTaskSummary[] = [], rows = 30): RenderState {
  const state = stateWith(content, taskList);
  state.cols = 120;
  state.rows = rows;
  state.sidebar.open = false;
  state.messages = Array.from({ length: 60 }, (_, i) => ({ role: "system" as const, text: `history row ${i} with words`, metadata: null }));
  capture(() => render(state));
  return state;
}

const LONG = [MOCK, ...Array.from({ length: 20 }, (_, i) => `- [ ] extra ${i} ${"padding words ".repeat(5)}`)].join("\n");

describe("scratchpad clicks", () => {
  test("a click expands it and a second click collapses it; history and Tasks stay as they were", () => {
    const state = screen(LONG, tasks(2));
    const tasksRect = state.layout.taskPanelRect!;
    const collapsed = state.layout.scratchpadRect!;
    expect(collapsed.top).toBe(tasksRect.bottom + 1);
    expect(collapsed.right).toBe(120);
    expect(collapsed.bottom - collapsed.top + 1).toBe(MAX_SCRATCHPAD_PANEL_HEIGHT);
    expect(cursorZone(collapsed.left + 5, collapsed.top + 2, state)).toBe("hand");

    const before = { cursor: { ...state.historyCursor }, mode: state.vim.mode, focus: state.chatFocus };
    click(state, collapsed.left + 5, collapsed.top + 2);
    expect(isScratchpadExpanded(state)).toBe(true);
    expect(isTaskPanelExpanded(state)).toBe(false);
    expect({ cursor: state.historyCursor, mode: state.vim.mode, focus: state.chatFocus }).toEqual(before);
    capture(() => render(state));
    const expanded = state.layout.scratchpadRect!;
    expect(expanded.top).toBe(collapsed.top);
    expect(expanded.right).toBe(120);
    expect(expanded.right - expanded.left + 1).toBe(75);
    expect(expanded.bottom).toBe(state.layout.sepAbove - 1);
    expect(state.layout.historyWidth).toBe(120 - 75 - 1);
    expect(state.layout.taskPanelRect).toEqual(tasksRect);

    // Too tall for the pane: the wheel scrolls it, not the history.
    expect(state.layout.scratchpadMaxScroll).toBeGreaterThan(0);
    const offset = state.scrollOffset;
    capture(() => handleMouseEvent(mouse(expanded.left + 4, expanded.top + 3, "press", 65), state));
    expect(state.scratchpadExpansion?.scroll).toBe(3);
    expect(state.scrollOffset).toBe(offset);

    click(state, expanded.left + 3, expanded.bottom);
    expect(isScratchpadExpanded(state)).toBe(false);
    capture(() => render(state));
    expect(state.layout.scratchpadRect).toEqual(collapsed);
  });

  test("a card that already shows everything ignores clicks", () => {
    const state = screen("- [ ] one\n- [x] two");
    const rect = state.layout.scratchpadRect!;
    expect(rect.top).toBe(3);
    expect(cursorZone(rect.left + 5, rect.top + 1, state)).toBe("pointer");
    click(state, rect.left + 5, rect.top + 1);
    expect(isScratchpadExpanded(state)).toBe(false);
    expect(state.vim.mode).not.toBe("visual");
  });

  test("an update redraws it, and an emptied file removes it and its expansion", () => {
    const state = screen(LONG);
    click(state, state.layout.scratchpadRect!.left + 2, state.layout.scratchpadRect!.top + 1);
    expect(isScratchpadExpanded(state)).toBe(true);
    const summary = () => state.sidebar.conversations.find(conversation => conversation.id === "conv")!;
    const update = (content: string | null) => {
      if (content !== null) handleEvent({ type: "scratchpad_updated", convId: "conv", content, hash: scratchpadHash(content) }, state, {} as never);
      const { scratchpad: _old, ...rest } = summary();
      handleEvent({ type: "conversation_updated", summary: { ...rest, ...(content !== null ? { scratchpad: scratchpadHash(content) } : {}) } }, state, {} as never);
      capture(() => render(state));
    };
    update("- [ ] only one");
    expect(state.layout.scratchpadRect!.bottom - state.layout.scratchpadRect!.top + 1).toBe(3);
    update(null);
    expect(state.layout.scratchpadRect).toBeNull();
    expect(state.scratchpadExpansion).toBeNull();
    expect(state.layout.historyWidth).toBe(120);
    // Another conversation's contents never show here.
    handleEvent({ type: "scratchpad_updated", convId: "other", content: "- [ ] elsewhere", hash: scratchpadHash("- [ ] elsewhere") }, state, {} as never);
    capture(() => render(state));
    expect(state.layout.scratchpadRect).toBeNull();
  });
});

describe("the card paints with the summaries, like Tasks", () => {
  test("a bootstrap's contents and list paint both cards in the same frame", () => {
    const state = createInitialState();
    state.cols = 120;
    state.rows = 30;
    state.sidebar.open = false;
    state.convId = "conv";
    const summary = { ...conversation(state, "conv", tasks(2)), scratchpad: scratchpadHash(MOCK) };
    handleEvent({ type: "scratchpads", scratchpads: [{ hash: scratchpadHash(MOCK), content: MOCK }] }, state, {} as never);
    handleEvent({ type: "conversations_list", conversations: [summary], folders: [] }, state, {} as never);
    capture(() => render(state));
    expect(state.layout.taskPanelRect).not.toBeNull();
    expect(state.layout.scratchpadRect!.top).toBe(state.layout.taskPanelRect!.bottom + 1);
  });

  test("switching conversations shows each one's card at once, and never another version's", () => {
    const state = screen(MOCK, tasks(1));
    state.sidebar.conversations[1]!.tasks = tasks(1);
    hold(state, "other", "- [ ] the other one");
    state.convId = "other";
    capture(() => render(state));
    expect(state.layout.scratchpadRect!.bottom - state.layout.scratchpadRect!.top + 1).toBe(3);
    // A summary naming contents not held yet shows no card rather than older contents.
    state.sidebar.conversations[1]!.scratchpad = scratchpadHash("- [ ] newer");
    capture(() => render(state));
    expect(state.layout.scratchpadRect).toBeNull();
    expect(state.layout.taskPanelRect).not.toBeNull();
    state.scratchpads.put(scratchpadHash("- [ ] newer"), "- [ ] newer");
    capture(() => render(state));
    expect(state.layout.scratchpadRect).not.toBeNull();
  });

  test("a fresh TUI paints it from the disk store with its first summaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-scratchpad-store-"));
    try {
      const path = join(dir, "scratchpad-cache.json");
      const first = new ScratchpadStore(path);
      first.put(scratchpadHash(MOCK), MOCK);
      first.flushSync();

      const state = stateWith(null, tasks(2));
      state.scratchpads = new ScratchpadStore(path);
      expect(state.scratchpads.hashes()).toEqual([scratchpadHash(MOCK)]);
      state.sidebar.conversations[0]!.scratchpad = scratchpadHash(MOCK);
      state.cols = 120;
      state.rows = 30;
      state.sidebar.open = false;
      capture(() => render(state));
      expect(state.layout.taskPanelRect).not.toBeNull();
      expect(state.layout.scratchpadRect).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scratchpad store", () => {
  test("round-trips through its file, keeping the most recently used within its bounds", () => {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-scratchpad-store-"));
    try {
      const path = join(dir, "nested", "scratchpad-cache.json");
      const store = new ScratchpadStore(path, { maxEntries: 3, maxBytes: 1_000 });
      for (const name of ["a", "b", "c"]) expect(store.put(name, `- [ ] ${name}`)).toBe(true);
      expect(store.put("a", "- [ ] a")).toBe(false);
      store.put("d", "- [ ] d");
      expect(store.hashes()).toEqual(["d", "a", "c"]);
      expect(store.has("b")).toBe(false);
      store.put("big", "x".repeat(995));
      expect(store.hashes()).toEqual(["big"]);
      store.flushSync();
      const reread = new ScratchpadStore(path, { maxEntries: 3, maxBytes: 1_000 });
      expect(reread.hashes()).toEqual(["big"]);
      expect(reread.get("big")).toBe("x".repeat(995));
      // Tighter bounds on the next start keep the newest.
      store.put("e", "- [ ] e");
      store.flushSync();
      expect(new ScratchpadStore(path, { maxEntries: 1, maxBytes: 1_000 }).hashes()).toEqual(["e"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a damaged file starts empty, and a memory-only store writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "exocortex-scratchpad-store-"));
    try {
      const path = join(dir, "scratchpad-cache.json");
      Bun.write(path, "{not json");
      expect(new ScratchpadStore(path).size).toBe(0);
      const memory = new ScratchpadStore();
      memory.put("a", "x");
      memory.flushSync();
      expect(memory.get("a")).toBe("x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
