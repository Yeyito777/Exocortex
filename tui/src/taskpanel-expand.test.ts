import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  EXPANDED_PANEL_WIDTH_FACTOR,
  isTaskPanelExpanded,
  layoutTaskPanel,
  MAX_TASK_PANEL_HEIGHT,
  renderTaskPanel,
  toggleTaskPanelExpansion,
} from "./activitypanel";
import { disposeHistoryImages, invalidateHistoryImagePlacements } from "./historyimages";
import { stripAnsi } from "./historycursor";
import { configureInlineImages, inlineImagesInternalsForTest, setInlineImageCellSize, setInlineImageMode } from "./inlineimages";
import type { ConversationTaskSummary, ImageRef } from "./messages";
import { cursorZone, handleMouseEvent } from "./mouse";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";
import { termWidth, visibleLength } from "./textwidth";

const NOW = Date.UTC(2026, 9, 11, 15, 0, 0);
const HOURLY = "Hourly review: sweep-family run status, live log anomalies and the replay comparison against yesterday";

function chronoTasks(now = NOW): ConversationTaskSummary[] {
  return [
    { id: "chrono:hourly", kind: "chrono", title: HOURLY, startedAt: now - 3_600_000, dueAt: now + 42 * 60_000, chronoMode: "wake" },
    { id: "chrono:recorder", kind: "chrono", title: "Running: Daily recorder rotation and spool bloat check", startedAt: now - 75_000, dueAt: now - 75_000, chronoMode: "wake", chronoRunning: true },
    { id: "chrono:build", kind: "chrono", title: "Resume the build after the deploy window closes", startedAt: now - 60_000, dueAt: now + 3 * 86_400_000, chronoMode: "sleep" },
    { id: "child", kind: "subagent", title: "Map daemon events and write the protocol notes", startedAt: now - 200_000 },
    { id: "bash:1", kind: "background", title: "bun run test --watch tui/src/activitypanel.test.ts", startedAt: now - 30_000, toolName: "bash" },
    { id: "agent:1", kind: "background", title: "JS engine core", startedAt: now - 30_000, toolName: "Agent" },
    { id: "chrono:digest", kind: "chrono", title: "Evening digest of every open PMV5 question for the owner", startedAt: now - 60_000, dueAt: now + 5 * 3_600_000, chronoMode: "wake" },
  ];
}

/** `copies` × the seven tasks above: two copies already overflow the collapsed card. */
function manyTasks(copies: number, now = NOW): ConversationTaskSummary[] {
  return Array.from({ length: copies }, (_, copy) => chronoTasks(now).map(task => ({ ...task, id: `${task.id}:${copy}` }))).flat();
}

function stateWithTasks(tasks = chronoTasks()): RenderState {
  const state = createInitialState();
  state.convId = "conv";
  state.sidebar.conversations = [{
    id: "conv",
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    title: "Conversation",
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: 0,
    tasks,
  }, {
    id: "other",
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 0,
    title: "Other",
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: 1,
    tasks: [{ id: "other:1", kind: "background", title: "Other work", startedAt: NOW }],
  }];
  return state;
}

const plain = (lines: string[]) => lines.map(stripAnsi);

describe("collapsed task panel", () => {
  test("invites a click on its overflow row, falling back to the count alone when narrow", () => {
    const state = stateWithTasks(manyTasks(3));
    const panel = renderTaskPanel(state, 100, 60, NOW)!;
    expect(panel.lines).toHaveLength(MAX_TASK_PANEL_HEIGHT);
    expect(plain(panel.lines).at(-2)).toContain("▸ 12 more · click to expand");

    const narrow = plain(renderTaskPanel(state, 30, 60, NOW)!.lines);
    expect(narrow.at(-2)).toContain("▸ 12 more");
    expect(narrow.at(-2)).not.toContain("click");
    expect(narrow.every(line => termWidth(line) === 30)).toBe(true);
  });

  test("truncates titles to one row each", () => {
    const panel = plain(renderTaskPanel(stateWithTasks(), 100, 60, NOW)!.lines);
    // The subagent leads; the Chrono rows follow in the daemon's order.
    expect(panel[1]).toContain("◆ Exocortex Map daemon events");
    expect(panel[2]).toContain("◷ Chrono Hourly review:");
    expect(panel[2]).toContain("…");
    expect(panel.join("\n")).not.toContain("yesterday");
  });
});

describe("expanded task panel", () => {
  /** Rows of the card between its top and bottom borders. */
  const bodyOf = (lines: string[]) => plain(lines).slice(1, -1);

  test("lists every entry, wider and wrapped, without the overflow row", () => {
    const state = stateWithTasks(manyTasks(3));
    toggleTaskPanelExpansion(state);
    const panel = renderTaskPanel(state, 100, 200, NOW)!;
    expect(EXPANDED_PANEL_WIDTH_FACTOR).toBe(1.5);
    expect(panel.width).toBe(75);
    expect(panel.maxScroll).toBe(0);
    expect(panel.lines.every(line => visibleLength(line) === 75)).toBe(true);
    const text = plain(panel.lines);
    const joined = text.join("\n");
    expect(joined).not.toContain("more");
    expect(joined).not.toContain("…");
    // Every copy of every title is there in full, the long one over two rows.
    expect(joined.match(/◷ Chrono Hourly review/g)).toHaveLength(3);
    expect(joined.match(/against yesterday/g)).toHaveLength(3);
    expect(text.filter(line => line.includes("Evening digest"))).toHaveLength(3);
    expect(text.at(-1)).toContain("click to collapse");
    // The header keeps the entry count, not the row count.
    expect(text[0].trimEnd()).toEndWith("21 ─╮");
    expect(text.length - 2).toBeGreaterThan(21);
  });

  test("wraps a long title under its title column, keeping the status on the first row", () => {
    const state = stateWithTasks();
    toggleTaskPanelExpansion(state);
    const body = bodyOf(renderTaskPanel(state, 100, 60, NOW)!.lines);
    const first = body.findIndex(line => line.includes("Hourly review"));
    const titleCol = body[first].indexOf("Hourly");
    expect(body[first].trimEnd()).toEndWith("in 42m │");
    // Continuations start in the title column, leave the label and status columns blank.
    const continuations: string[] = [];
    for (let i = first + 1; !body[i].startsWith("│ ◷") && !body[i].startsWith("│ ◆") && !body[i].startsWith("│ $"); i++) continuations.push(body[i]);
    expect(continuations.length).toBeGreaterThan(0);
    for (const line of continuations) {
      expect(line.slice(0, titleCol).trim()).toBe("│");
      expect(line[titleCol]).not.toBe(" ");
      expect(line.slice(-9)).toBe("        │");
    }
    expect([body[first], ...continuations].map(line => line.slice(titleCol, -9).trim()).join(" ")).toBe(HOURLY);
    // Every entry's status ends in the same column as the next entry's.
    const statusEnds = body.filter(line => /^│ [◷◆$]/.test(line)).map(line => line.trimEnd().length);
    expect(new Set(statusEnds).size).toBe(1);
  });

  test("wraps subscription titles under their own title column", () => {
    const state = stateWithTasks([]);
    state.externalToolStyles = [{ cmd: "discord", label: "Discord", color: "#5865f2" }];
    state.sidebar.conversations[0].integrations = [{
      id: "integration:dms",
      toolName: "discord",
      sourceId: "dm:1",
      label: "Paramount DMs and mentions from every server the bot account belongs to, plus replies",
      delivery: "wake",
      status: "active",
      createdAt: NOW,
    }];
    toggleTaskPanelExpansion(state);
    const body = bodyOf(renderTaskPanel(state, 100, 60, NOW)!.lines);
    expect(body.length).toBeGreaterThan(1);
    expect(body[0]).toStartWith("│ Discord Paramount DMs");
    expect(body[0].trimEnd()).toEndWith("wake active │");
    expect(body[1]).toStartWith(`│ ${" ".repeat("Discord ".length)}`);
    expect(body.join(" ")).toContain("plus replies");
  });

  test("keeps the subscriptions divider and lists every subscription", () => {
    const state = stateWithTasks(manyTasks(2));
    state.sidebar.conversations[0].integrations = ["one", "two", "three"].map(id => ({
      id: `integration:${id}`,
      toolName: "discord",
      sourceId: `channel:${id}`,
      label: `Subscription ${id}`,
      delivery: "wake" as const,
      status: "active" as const,
      createdAt: NOW,
    }));
    toggleTaskPanelExpansion(state);
    const text = plain(renderTaskPanel(state, 100, 60, NOW)!.lines);
    const divider = text.findIndex(line => line.includes("Subscriptions"));
    expect(divider).toBeGreaterThan(14);
    expect(text).toHaveLength(divider + 3 + 2);
    expect(text.slice(divider + 1, divider + 4).map(line => line.match(/Subscription \w+/)?.[0])).toEqual(["Subscription one", "Subscription two", "Subscription three"]);
  });

  test("caps its height to the pane, scrolling by rows", () => {
    const state = stateWithTasks(manyTasks(3));
    toggleTaskPanelExpansion(state);
    const all = plain(renderTaskPanel(state, 34, 1_000, NOW)!.lines);
    const rows = all.length - 2;
    const first = renderTaskPanel(state, 34, 12, NOW)!;
    expect(first.width).toBe(34);
    expect(first.lines).toHaveLength(12);
    expect(first.maxScroll).toBe(rows - 10);
    expect(first.lines.every(line => termWidth(stripAnsi(line)) === 34)).toBe(true);
    expect(plain(first.lines).at(-1)).toContain(`↓ ${rows - 10} below`);
    expect(plain(first.lines).at(-1)).not.toContain("↑");

    state.taskPanelExpansion!.scroll = 4;
    const middle = renderTaskPanel(state, 34, 12, NOW)!;
    expect(middle.scroll).toBe(4);
    expect(plain(middle.lines).slice(1, -1)).toEqual(all.slice(5, 15));
    expect(plain(middle.lines).at(-1)).toContain(`↑ 4 above · ↓ ${rows - 14} below`);

    state.taskPanelExpansion!.scroll = 1_000;
    const last = renderTaskPanel(state, 34, 12, NOW)!;
    expect(last.scroll).toBe(last.maxScroll);
    expect(plain(last.lines).slice(1, -1)).toEqual(all.slice(-11, -1));
    expect(plain(last.lines).at(-1)).not.toContain("↓");
  });

  test("grows to 1.5x the collapsed width, clamped to keep the history column readable", () => {
    const state = stateWithTasks();
    const widths = (chatWidth: number) => {
      state.taskPanelExpansion = null;
      const collapsed = layoutTaskPanel(state, chatWidth, 30, NOW).panel?.width;
      toggleTaskPanelExpansion(state);
      const expanded = layoutTaskPanel(state, chatWidth, 30, NOW);
      return { collapsed, expanded: expanded.panel?.width, historyWidth: expanded.historyWidth, lines: expanded.panel?.lines ?? [] };
    };
    // Room to spare: the full 1.5x.
    expect(widths(160)).toMatchObject({ collapsed: 50, expanded: 75, historyWidth: 160 - 75 - 1 });
    // Between the two: as wide as leaves the 30-column history beside it.
    expect(widths(100)).toMatchObject({ collapsed: 50, expanded: 69, historyWidth: 30 });
    // Already at the limit collapsed: it only grows taller.
    expect(widths(80)).toMatchObject({ collapsed: 49, expanded: 49, historyWidth: 30 });
    // The narrowest chat with a card at all keeps the minimum card.
    expect(widths(61)).toMatchObject({ collapsed: 30, expanded: 30, historyWidth: 30 });
    for (const chatWidth of [160, 100, 80, 61]) {
      const { expanded, lines } = widths(chatWidth);
      expect(lines.every(line => visibleLength(line) === expanded)).toBe(true);
    }
    // Too narrow for any card: still none when expanded.
    expect(widths(60)).toMatchObject({ collapsed: undefined, expanded: undefined, historyWidth: 60 });
  });

  test("collapsing restores the exact collapsed card, still one truncated row per entry", () => {
    const state = stateWithTasks(manyTasks(3));
    const before = renderTaskPanel(state, 100, 60, NOW)!;
    toggleTaskPanelExpansion(state);
    expect(renderTaskPanel(state, 100, 60, NOW)!.lines).not.toEqual(before.lines);
    toggleTaskPanelExpansion(state);
    const after = renderTaskPanel(state, 100, 60, NOW)!;
    expect(after).toEqual(before);
    expect(after.width).toBe(50);
    expect(plain(after.lines)[1]).toContain("…");
  });

  test("belongs to the conversation it was opened in", () => {
    const state = stateWithTasks();
    toggleTaskPanelExpansion(state);
    expect(isTaskPanelExpanded(state)).toBe(true);
    state.convId = "other";
    expect(isTaskPanelExpanded(state)).toBe(false);
    expect(plain(renderTaskPanel(state, 100, 60, NOW)!.lines).at(-1)).not.toContain("collapse");
    state.convId = "conv";
    toggleTaskPanelExpansion(state);
    expect(isTaskPanelExpanded(state)).toBe(false);
  });
});

// ── Through the renderer and mouse ────────────────────────────────

function capture(fn: () => void): string {
  let out = "";
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = write as typeof process.stdout.write;
  }
  return out;
}

const mouse = (col: number, row: number, action: "press" | "release" | "motion", button = 0) =>
  ({ type: "mouse" as const, shift: false, meta: false, ctrl: false, col, row, button, action });

/** A click as the terminal reports it: press then release on the same cell. */
function click(state: RenderState, col: number, row: number): string[] {
  const results: string[] = [];
  capture(() => {
    results.push(handleMouseEvent(mouse(col, row, "press"), state).type);
    results.push(handleMouseEvent(mouse(col, row, "release"), state).type);
  });
  return results;
}

const filler = (count: number, label = "history row") => Array.from({ length: count }, (_, i) => ({
  role: "system" as const,
  text: `${label} ${i} with some words to wrap beside the panel`,
  metadata: null,
}));

function chatState(cols = 120, rows = 30, messages: RenderState["messages"] = filler(80)): RenderState {
  const state = stateWithTasks(manyTasks(2, Date.now()));
  state.cols = cols;
  state.rows = rows;
  state.sidebar.open = false;
  state.messages = messages;
  capture(() => render(state));
  return state;
}

function screenText(state: RenderState): string {
  // The test terminal is not real; re-render and read the panel rows back from its rectangle.
  const rect = state.layout.taskPanelRect!;
  return renderTaskPanel(state, rect.right - rect.left + 1, rect.bottom - rect.top + 1)!.lines.map(stripAnsi).join("\n");
}

describe("task panel clicks", () => {
  test("a click expands and a second click collapses, with a hand over the whole card", () => {
    const state = chatState();
    const collapsed = state.layout.taskPanelRect!;
    expect(collapsed.right).toBe(120);
    expect(collapsed.right - collapsed.left + 1).toBe(50);
    for (const [col, row] of [[collapsed.left, collapsed.top], [collapsed.right, collapsed.bottom], [collapsed.left + 10, collapsed.top + 2]]) {
      expect(cursorZone(col, row, state)).toBe("hand");
    }
    expect(cursorZone(collapsed.left - 2, collapsed.top + 2, state)).toBe("text");

    expect(click(state, collapsed.left + 10, collapsed.top + 2)).toEqual(["handled", "handled"]);
    expect(isTaskPanelExpanded(state)).toBe(true);
    capture(() => render(state));
    const expanded = state.layout.taskPanelRect!;
    // Right edge anchored, grown leftward to 1.5x and down to fit every (wrapped) row.
    expect(expanded.right).toBe(120);
    expect(expanded.left).toBe(collapsed.left - 25);
    expect(expanded.right - expanded.left + 1).toBe(75);
    expect(expanded.bottom - expanded.top + 1).toBe(renderTaskPanel(state, 75, 1_000)!.lines.length);
    expect(expanded.bottom - expanded.top + 1).toBeGreaterThan(14 + 2);
    expect(expanded.bottom).toBeLessThan(state.layout.sepAbove);
    expect(state.layout.historyWidth).toBe(120 - 75 - 1);
    // The whole wider card is the click target, and history beside it is still text.
    expect(cursorZone(expanded.left, expanded.top + 2, state)).toBe("hand");
    expect(cursorZone(expanded.left - 2, expanded.top + 2, state)).toBe("text");
    expect(cursorZone(expanded.left, expanded.bottom, state)).toBe("hand");
    expect(screenText(state)).not.toContain("more");
    expect(screenText(state).split("\n").at(-3)).toContain("Evening digest of every open PMV5 question for the");
    expect(screenText(state).split("\n").at(-2)).toContain("owner");

    click(state, expanded.left + 3, expanded.bottom);
    expect(isTaskPanelExpanded(state)).toBe(false);
    capture(() => render(state));
    expect(state.layout.taskPanelRect).toEqual(collapsed);
  });

  test("clicks on the card never reach the history under it", () => {
    const state = chatState();
    const rect = state.layout.taskPanelRect!;
    const before = { cursor: { ...state.historyCursor }, mode: state.vim.mode, focus: state.chatFocus };
    expect(click(state, rect.left + 5, rect.top + 1)).toEqual(["handled", "handled"]);
    expect({ cursor: state.historyCursor, mode: state.vim.mode, focus: state.chatFocus }).toEqual(before);
    expect(state.mouseLinkPress ?? null).toBeNull();
    expect(state.mouseImagePress ?? null).toBeNull();

    // Outside the card, a click still selects history as before.
    capture(() => render(state));
    capture(() => handleMouseEvent(mouse(3, rect.top + 1, "press"), state));
    expect(state.vim.mode).toBe("visual");
    expect(state.chatFocus).toBe("history");
  });

  test("the wheel scrolls a card too tall for the screen, and the history otherwise", () => {
    const state = chatState(120, 16);
    const rect = state.layout.taskPanelRect!;
    const wheel = (button: 64 | 65, col = rect.left + 4) => capture(() => handleMouseEvent(mouse(col, rect.top + 2, "press", button), state));

    // Collapsed: the wheel over the card scrolls history, as before.
    const offset = state.scrollOffset;
    wheel(64);
    expect(state.scrollOffset).toBeGreaterThan(offset);
    state.scrollOffset = offset;

    click(state, rect.left + 4, rect.top + 2);
    capture(() => render(state));
    expect(state.layout.taskPanelMaxScroll).toBeGreaterThan(0);
    wheel(65);
    expect(state.taskPanelExpansion?.scroll).toBe(3);
    expect(state.scrollOffset).toBe(offset);
    capture(() => render(state));
    expect(screenText(state).split("\n").at(-1)).toContain("↑ 3 above");
    wheel(64);
    wheel(64);
    expect(state.taskPanelExpansion?.scroll).toBe(0);
    expect(state.scrollOffset).toBe(offset);
    for (let i = 0; i < 40; i++) wheel(65);
    expect(state.taskPanelExpansion?.scroll).toBe(state.layout.taskPanelMaxScroll);

    // Beside the card, the wheel still scrolls history.
    wheel(64, 3);
    expect(state.scrollOffset).toBeGreaterThan(offset);
  });

  test("switching conversations collapses it, even on the way back", () => {
    const state = chatState();
    const rect = state.layout.taskPanelRect!;
    click(state, rect.left + 4, rect.top + 1);
    expect(isTaskPanelExpanded(state)).toBe(true);
    state.convId = "other";
    capture(() => render(state));
    expect(state.taskPanelExpansion).toBeNull();
    state.convId = "conv";
    capture(() => render(state));
    expect(isTaskPanelExpanded(state)).toBe(false);
    expect(state.layout.taskPanelRect!.right - state.layout.taskPanelRect!.left + 1).toBe(50);
  });

  test("stays expanded while tasks come and go, and ends with the last one", () => {
    const state = chatState();
    const rect = state.layout.taskPanelRect!;
    click(state, rect.left + 4, rect.top + 1);
    capture(() => render(state));
    const height = state.layout.taskPanelRect!.bottom - state.layout.taskPanelRect!.top;

    const conversation = state.sidebar.conversations[0];
    conversation.tasks = [...conversation.tasks!, { id: "bash:new", kind: "background", title: "A command that started just now", startedAt: Date.now() }];
    capture(() => render(state));
    expect(isTaskPanelExpanded(state)).toBe(true);
    expect(state.layout.taskPanelRect!.bottom - state.layout.taskPanelRect!.top).toBe(height + 1);
    expect(screenText(state)).toContain("A command that started");
    expect(screenText(state).split("\n")[0].trimEnd()).toEndWith("15 ─╮");

    conversation.tasks = [];
    capture(() => render(state));
    expect(state.layout.taskPanelRect).toBeNull();
    expect(state.taskPanelExpansion).toBeNull();
    conversation.tasks = manyTasks(2, Date.now());
    capture(() => render(state));
    expect(state.layout.taskPanelRect!.right - state.layout.taskPanelRect!.left + 1).toBe(50);
  });
});

describe("images under the expanded card", () => {
  const ref: ImageRef = { id: "a".repeat(64), mediaType: "image/png", width: 2400, height: 900, sizeBytes: 533_000, name: "shot.png" };
  const fetchPreview = async (request: { width: number; height: number; format: string }) => request.format === "png"
    ? { format: "png" as const, width: request.width, height: request.height, base64: "UE5H" }
    : { format: "rgba" as const, width: request.width, height: request.height, base64: Buffer.alloc(request.width * request.height * 4, 128).toString("base64") };

  beforeEach(() => inlineImagesInternalsForTest.reset());
  afterEach(() => inlineImagesInternalsForTest.reset());

  function imageState(): RenderState {
    // Below the compact card, wider than the history column beside a card.
    return chatState(100, 40, [
      ...filler(6, "before"),
      {
        role: "assistant",
        blocks: [
          { type: "tool_call", toolCallId: "c1", toolName: "attach", input: { paths: ["shot.png"] }, summary: "" },
          { type: "tool_result", toolCallId: "c1", toolName: "attach", output: "Attached 1 image", isError: false, images: [ref] },
          // The reply after the call stays in view, as the folded call's row used to.
          { type: "text", text: "Here it is." },
        ],
        metadata: { startedAt: 1, endedAt: 2, model: "gpt-5.5", tokens: 10 },
      },
      ...filler(3, "after"),
    ]);
  }

  async function frame(state: RenderState): Promise<string> {
    capture(() => render(state));
    await Bun.sleep(0);
    await Bun.sleep(0);
    return capture(() => render(state));
  }

  const placementRows = (out: string) => [...out.matchAll(/\x1b\[(\d+);(\d+)H\x1b_Ga=p[^;]*,c=(\d+),r=(\d+)/g)]
    .map(match => ({ row: Number(match[1]), col: Number(match[2]), cols: Number(match[3]), rows: Number(match[4]) }));

  test("a Kitty image the taller card would cover stays clear of it", async () => {
    configureInlineImages({ fetch: fetchPreview, onChange: () => {} });
    setInlineImageMode("kitty");
    setInlineImageCellSize({ width: 8, height: 16 });
    const state = imageState();
    const [collapsed] = placementRows(await frame(state));
    const rect = state.layout.taskPanelRect!;
    // Below the compact card it fits; the expanded card grows down over its rows and columns.
    expect(collapsed.row).toBeGreaterThan(rect.bottom);
    expect(collapsed.col + collapsed.cols - 1).toBeGreaterThanOrEqual(rect.left);
    click(state, rect.left + 4, rect.top + 1);
    await frame(state);
    // Re-send every placement so the frame lists all of them, not just the changes.
    invalidateHistoryImagePlacements(state);
    const out = capture(() => render(state));
    const expanded = state.layout.taskPanelRect!;
    expect(expanded.bottom).toBeGreaterThanOrEqual(collapsed.row);
    const shown = placementRows(out);
    // The wide image still shows, clear of the card.
    expect(shown.length).toBeGreaterThan(0);
    for (const placement of shown) {
      const overlapsRows = placement.row <= expanded.bottom && placement.row + placement.rows - 1 >= expanded.top;
      const overlapsCols = placement.col + placement.cols - 1 >= expanded.left;
      expect(overlapsRows && overlapsCols).toBe(false);
    }
    disposeHistoryImages(state);
  });

  test("half-block images stay left of the card and the card is painted over them", async () => {
    configureInlineImages({ fetch: fetchPreview, onChange: () => {} });
    setInlineImageMode("halfblock");
    setInlineImageCellSize({ width: 8, height: 16 });
    const state = imageState();
    await frame(state);
    const rect = state.layout.taskPanelRect!;
    click(state, rect.left + 4, rect.top + 1);
    const out = capture(() => render(state));
    expect(out).not.toContain("\x1b_G");
    const expanded = state.layout.taskPanelRect!;
    // Every row the card grew over is written at the card's column after the history row beside it.
    for (let row = rect.bottom + 1; row <= expanded.bottom; row++) {
      const cardAt = out.lastIndexOf(`\x1b[${row};${expanded.left}H`);
      expect(cardAt).toBeGreaterThanOrEqual(0);
      expect(cardAt).toBeGreaterThan(out.lastIndexOf(`\x1b[${row};1H`));
    }
    disposeHistoryImages(state);
  });
});
