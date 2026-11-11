import { describe, expect, test } from "bun:test";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";
import { TerminalScreen } from "./testhelpers/terminalscreen";

/**
 * A reply whose table starts beside the Tasks/Scratchpad cards. A table's
 * border is one unbreakable run wider than the narrow rows there.
 */

function captureRenderOutput(state: RenderState): string {
  let out = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    render(state);
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
  return out;
}

const TABLE_REPLY = [
  "It's not you: whale is overloaded and its connection is dropping packets.",
  "",
  "**What I checked:**",
  "",
  "| | Result |",
  "|---|---|",
  "| **Whale CPU** | Load around 41 on 12 cores. Processes spend 72% of the time waiting for a CPU. |",
  "| **Whale's internet** | Router: 0% packet loss. Beyond it: 17.5% loss to 1.1.1.1, with spikes up to 120 ms. |",
  "| **Your Mac** | Load about 3.5, fine. A full SSH round trip to whale takes 1.4–2.6 s, which is slow. |",
  "",
  ...Array.from({ length: 30 }, (_, index) => `Closing paragraph ${index + 1} runs on after the table for long enough to wrap at the chat width.\n`),
].join("\n");

function makeState(replyText: string): RenderState {
  const state = createInitialState();
  state.cols = 107;
  state.rows = 67;
  state.convId = "table-beside-cards";
  state.sidebar.open = false;
  state.panelFocus = "chat";
  state.messages = [
    ...Array.from({ length: 6 }, (_, index) => [
      { role: "user" as const, text: `Earlier question ${index}`, metadata: null },
      { role: "assistant" as const, blocks: [{ type: "text" as const, text: `Earlier answer ${index}. `.repeat(20) }], metadata: null },
    ]).flat(),
    { role: "user", text: "why is everything so laggy today?", metadata: null },
    { role: "assistant", blocks: [{ type: "text", text: replyText }], metadata: null },
  ];
  state.scratchpads.put("pad", ["# Today", ...Array.from({ length: 12 }, (_, index) => `- [ ] To-do item number ${index}`)].join("\n"));
  state.sidebar.conversations = [{
    id: state.convId,
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    createdAt: 1,
    updatedAt: 2,
    messageCount: state.messages.length,
    title: "Table beside the cards",
    marked: false,
    pinned: false,
    streaming: false,
    unread: true,
    sortOrder: 0,
    scratchpad: "pad",
    tasks: [],
  }];
  return state;
}

/** The history's text on each row of the message area, as the terminal shows it. */
function historyRows(state: RenderState): string[] {
  const screen = new TerminalScreen(state.rows, state.cols);
  screen.feed(captureRenderOutput(state));
  const { messageAreaHeight, scratchpadRect } = state.layout;
  return screen.plainRows().slice(2, 2 + messageAreaHeight).map((row, index) => {
    const screenRow = index + 3;
    const besideCard = scratchpadRect && screenRow >= scratchpadRect.top && screenRow <= scratchpadRect.bottom;
    return (besideCard ? row.slice(0, scratchpadRect.left - 1) : row).trimEnd();
  });
}

describe("a table beside the Tasks/Scratchpad cards", () => {
  test("wraps beside the cards on an unread reply's first display instead of leaving a gap", () => {
    const state = makeState(TABLE_REPLY);
    state.conversationScroll.pendingRestore = { convId: state.convId!, mode: "unread-response", waitForInitialBackfill: false };

    const rows = historyRows(state);

    expect(state.conversationScroll.finalResponseViewport?.mode).toBe("anchored");
    const cardBottom = state.layout.scratchpadRect!.bottom - 3;
    const heading = rows.findIndex(row => row.includes("What I checked:"));
    const tableTop = rows.findIndex(row => row.includes("┌"));
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(heading).toBeLessThan(cardBottom);
    // One blank row separates the paragraph from its table, as everywhere else.
    expect(tableTop).toBe(heading + 2);
    // Every row from the reply's start to the cards' bottom has the reply's
    // text; the only blank ones are the two paragraph breaks.
    expect(rows.slice(0, cardBottom + 1).filter(row => row.trim() === "").length).toBe(2);
  });

  test("lays the reply out the same from the top of a short conversation", () => {
    const state = makeState(TABLE_REPLY);
    state.messages = state.messages.slice(-1);
    state.scrollOffset = 1_000_000;

    const rows = historyRows(state);

    const heading = rows.findIndex(row => row.includes("What I checked:"));
    expect(rows.findIndex(row => row.includes("┌"))).toBe(heading + 2);
  });

  test("breaks a border in two without a blank row once the history is scrolled", () => {
    const state = makeState(TABLE_REPLY);
    captureRenderOutput(state);
    // Bring the table's last rows beside the cards with the bottom-anchored layout.
    const tableBottom = state.historyLines.findIndex(line => line.includes("└"));
    const viewStart = tableBottom - 6;
    state.scrollOffset = state.layout.totalLines - state.layout.messageAreaHeight - viewStart;

    const rows = historyRows(state);

    const borderStart = rows.findIndex(row => row.includes("└"));
    expect(borderStart).toBeGreaterThan(0);
    expect(borderStart).toBeLessThan(state.layout.scratchpadRect!.bottom - 3);
    expect(rows[borderStart - 1]).toContain("│");
    expect(rows[borderStart + 1]).toMatch(/^ {2}─+┘$/);
  });
});
