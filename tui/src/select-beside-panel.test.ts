import { describe, expect, test } from "bun:test";
import { render } from "./render";
import { invalidateFrame } from "./frame";
import { createInitialState, type RenderState } from "./state";
import { theme } from "./theme";
import { contentBounds, getHistoryVisualSelection, joinLogicalLines, logicalLineRange } from "./historycursor";
import { stripAnsi } from "./historymotions";
import { handleMouseEvent } from "./mouse";

const userText = [
  "Recently I did a lot of work desloppifying the codebase before I get back to making strategies better. I have a few ideas with E. The work I did ranges from:",
  "1. The arms fix and how arms interact with each other so they can't block each other.",
  "2. fixing bad limits on the arms and on E specifically specially after it got a filter",
  "",
  "all of these things which fall into: bug fixes and the deslop category have help me build a good foundation already and have increased my understanding of the codebase.",
  "go find such issues in the codebase and tell me about them. If it's already mostly correct then lmk that.",
].join("\n");

const assistantText = "The base is mostly sound. Order tracking, the router's lot and self-cross checks, the stop path and the flight checks all hold up, and the stop path isn't losing money across nine stops. What's left sits in three places: how the gate enforces limits, caps that overlap or contradict each other, and settings still passed on the command line.";

function captureOutput(run: () => void): string {
  let out = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = origWrite as typeof process.stdout.write;
  }
  return out;
}

const captureRenderOutput = (state: RenderState) => captureOutput(() => render(state));

/** The last text written to each screen row, starting at column 1. */
function rowWrites(output: string): Map<number, string> {
  const rows = new Map<number, string>();
  const moveRe = /\x1b\[(\d+);(\d+)H/g;
  const moves = [...output.matchAll(moveRe)];
  moves.forEach((match, index) => {
    if (Number(match[2]) !== 1) return;
    const start = match.index! + match[0].length;
    rows.set(Number(match[1]), output.slice(start, moves[index + 1]?.index ?? output.length));
  });
  return rows;
}

/** The characters of one row painted with the selection (or the cursor inside it). */
function highlightedText(write: string): string {
  let text = "";
  let selected = false;
  for (let index = 0; index < write.length;) {
    const escape = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(write.slice(index))?.[0];
    if (escape) {
      if (escape === theme.selectionBg || escape === theme.cursorBg) selected = true;
      else if (escape === theme.reset || escape === "\x1b[0m") selected = false;
      index += escape.length;
      continue;
    }
    const char = String.fromCodePoint(write.codePointAt(index)!);
    if (selected) text += char;
    index += char.length;
  }
  return text;
}

function panelState(taskCount: number, messages: RenderState["messages"]): RenderState {
  const state = createInitialState();
  state.cols = 120;
  state.rows = 40;
  state.convId = "parent";
  state.panelFocus = "chat";
  state.chatFocus = "history";
  state.messages = messages;
  state.sidebar.conversations = [{
    id: "parent",
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    fastMode: state.fastMode,
    createdAt: 1,
    updatedAt: 2,
    messageCount: messages.length,
    title: "Parent",
    marked: false,
    pinned: false,
    streaming: false,
    unread: false,
    sortOrder: 0,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `child-${index}`,
      kind: "subagent" as const,
      title: `Task ${index} with a fairly long title`,
      startedAt: Date.now() - 2_000,
    })),
  }];
  return state;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Select from (startRow, startCol) to (endRow, endCol) of the canonical history
 * and return what the screen highlights next to what a yank copies.
 */
function selectAndRender(
  state: RenderState,
  mode: "visual" | "visual-line",
  anchor: { row: number; col: number },
  cursor: { row: number; col: number },
): { highlighted: string; copied: string } {
  state.vim.mode = mode;
  state.historyVisualAnchor = anchor;
  state.historyCursor = cursor;
  // Every row in full, not just the cells that changed since the last frame.
  invalidateFrame(state);
  const writes = rowWrites(captureRenderOutput(state));
  const highlighted = state.layout.historyViewportRows
    .map((row, index) => row ? highlightedText(writes.get(3 + index) ?? "") : "")
    .filter(Boolean)
    .join(" ");
  return { highlighted: squash(highlighted), copied: squash(getHistoryVisualSelection(state)) };
}

/** Canonical rows of one segment, with columns a few characters into and before the end of their text. */
function textRows(state: RenderState, segment: string): Array<{ row: number; first: number; last: number }> {
  return state.historyLineAnchors.flatMap((anchor, row) => {
    if (anchor?.segment !== segment) return [];
    const plain = stripAnsi(state.historyLines[row]);
    if (plain.trim().length < 8) return [];
    const bounds = contentBounds(plain);
    return [{ row, first: bounds.start + 3, last: bounds.end - 4 }];
  });
}

function expectSelectionsMatch(state: RenderState, segment: string): void {
  captureRenderOutput(state);
  const rows = textRows(state, segment);
  expect(rows.length).toBeGreaterThan(2);
  for (const mode of ["visual", "visual-line"] as const) {
    for (let from = 0; from < rows.length; from++) {
      for (let to = from; to < rows.length; to++) {
        const anchor = { row: rows[from].row, col: rows[from].first };
        const cursor = { row: rows[to].row, col: rows[to].last };
        const label = `${mode} ${anchor.row}:${anchor.col} → ${cursor.row}:${cursor.col}`;
        const { highlighted, copied } = selectAndRender(state, mode, anchor, cursor);
        expect(copied.length, label).toBeGreaterThan(0);
        expect(highlighted, label).toBe(copied);
      }
    }
  }
}

describe("visual selection beside the Tasks panel", () => {
  const messages: RenderState["messages"] = [
    { role: "user", text: userText, metadata: null },
    { role: "assistant", blocks: [{ type: "text", text: assistantText }], metadata: null },
  ];

  test("highlights exactly the copied text of a right-aligned bubble reflowed beside the panel", () => {
    const state = panelState(12, messages);
    captureRenderOutput(state);
    const bufferBottom = (state.layout.taskPanelRect?.bottom ?? 0) + 1;
    const userRows = state.layout.historyViewportRows
      .map((row, index) => ({ row, screenRow: 3 + index }))
      .filter(({ row }) => row && state.historyLineAnchors[row.lineIndex]?.segment === "user_content");
    expect(userRows.every(({ screenRow }) => screenRow <= bufferBottom)).toBe(true);
    expectSelectionsMatch(state, "user_content");
  });

  test("highlights exactly the copied text of a bubble that starts beside the panel and continues below it", () => {
    const state = panelState(1, messages);
    captureRenderOutput(state);
    const bufferBottom = (state.layout.taskPanelRect?.bottom ?? 0) + 1;
    const screenRows = state.layout.historyViewportRows
      .map((row, index) => ({ row, screenRow: 3 + index }))
      .filter(({ row }) => row && state.historyLineAnchors[row.lineIndex]?.segment === "user_content")
      .map(({ screenRow }) => screenRow);
    expect(screenRows.some(row => row <= bufferBottom)).toBe(true);
    expect(screenRows.some(row => row > bufferBottom)).toBe(true);
    expectSelectionsMatch(state, "user_content");
  });

  test("highlights exactly the copied text of left-aligned assistant text beside the panel", () => {
    const state = panelState(12, [
      { role: "assistant", blocks: [{ type: "text", text: `${assistantText}\n\n${assistantText}` }], metadata: null },
    ]);
    expectSelectionsMatch(state, "assistant_block");
  });

  test("a click on a reflowed bubble lands on the character shown under it", () => {
    for (const taskCount of [1, 12]) {
      const state = panelState(taskCount, messages);
      invalidateFrame(state);
      const writes = rowWrites(captureRenderOutput(state));
      let checked = 0;
      state.layout.historyViewportRows.forEach((row, index) => {
        if (!row?.userText) return;
        const shown = stripAnsi(writes.get(3 + index) ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
        for (let col = row.userText.col; col < row.userText.col + row.userText.length; col += 5) {
          if (shown[col] === " ") continue;
          const press = { type: "mouse" as const, shift: false, meta: false, ctrl: false, col: state.layout.chatCol + col, row: 3 + index, button: 0, action: "press" as const };
          captureOutput(() => handleMouseEvent(press, state));
          const { row: line, col: at } = state.historyCursor;
          expect(stripAnsi(state.historyLines[line])[at], `tasks=${taskCount} screen ${3 + index}:${col}`).toBe(shown[col]);
          checked++;
        }
      });
      expect(checked).toBeGreaterThan(10);
    }
  });

  test("the normal-mode line tint covers exactly the line yy copies", () => {
    const saved = theme.historyLineBg;
    // A terminal without truecolor maps every background to one colour: pin the tint apart.
    theme.historyLineBg = "\x1b[48;2;1;2;3m";
    try {
    for (const taskCount of [1, 12]) {
      const state = panelState(taskCount, messages);
      state.vim.mode = "normal";
      captureRenderOutput(state);
      const lines = state.historyLineAnchors.flatMap((anchor, row) =>
        anchor?.segment === "user_content" ? [row] : []);
      expect(lines.length).toBeGreaterThan(2);
      for (const row of lines) {
        state.historyCursor = { row, col: contentBounds(stripAnsi(state.historyLines[row])).start };
        invalidateFrame(state);
        const writes = rowWrites(captureRenderOutput(state));
        const tinted = state.layout.historyViewportRows
          .map((viewportRow, index) => viewportRow && (writes.get(3 + index) ?? "").startsWith(theme.historyLineBg)
            ? stripAnsi(writes.get(3 + index) ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
            : "")
          .filter(Boolean)
          .join(" ");
        // What yy copies: the cursor's whole logical line.
        const { first, last } = logicalLineRange(row, state.historyWrapContinuation);
        const copied = joinLogicalLines(state.historyLines, state.historyWrapContinuation, first, last, state.historyWrapJoiners, state.historyCopyLines);
        expect(squash(tinted), `tasks=${taskCount} row=${row}`).toBe(squash(copied));
      }
    }
    } finally {
      theme.historyLineBg = saved;
    }
  });
});
