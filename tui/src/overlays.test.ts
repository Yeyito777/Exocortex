import { describe, expect, test } from "bun:test";
import { renderEditMessageOverlay, renderQueuePromptOverlay } from "./overlays";
import { render } from "./render";
import { createInitialState, type EditMessageState, type QueuePromptState, type RenderState } from "./state";
import { invalidateFrame } from "./frame";
import type { ScreenRect } from "./historyimages";
import type { ImageAttachment } from "./messages";
import { TerminalScreen } from "./testhelpers/terminalscreen";

const ROWS = 24;
const SEP_ROW = 20;
const WIDTHS = [120, 80, 45, 30, 24, 20, 16, 12, 8, 4, 3, 2, 1];

const PREVIEWS: Array<[name: string, text: string]> = [
  ["the reported prompt", "btw I run a fork of karabiner / aerospace on my mac and it eats some of the key repeats"],
  ["wide CJK text", "日本語のメッセージをキューに入れるとプレビューが枠からはみ出していました"],
  ["emoji", "🎉👍🏽🇵🇦 ship it 🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀"],
  ["multi-line text", "first line\nsecond line\nthird line that keeps going and going"],
  ["a short message", "hi"],
];

const IMAGE = { mediaType: "image/png", sizeBytes: 95_334, base64: "" } as unknown as ImageAttachment;

/** Paint a payload onto an st-like screen as wide as the terminal. */
function paint(payload: string, cols: number): TerminalScreen {
  const screen = new TerminalScreen(ROWS, cols, { autowrap: true });
  screen.feed(payload);
  return screen;
}

/** The box is fully bordered, inside the terminal, and nothing is drawn outside it. */
function expectBoxed(screen: TerminalScreen, rect: ScreenRect, cols: number): void {
  expect(screen.autoWrapCount).toBe(0);
  expect(rect.left).toBeGreaterThanOrEqual(1);
  expect(rect.right).toBeLessThanOrEqual(cols);
  for (let row = rect.top; row <= rect.bottom; row++) {
    const left = screen.cell(row - 1, rect.left - 1);
    const right = screen.cell(row - 1, rect.right - 1);
    if (row === rect.top) expect(left + right).toBe("┌┐");
    else if (row === rect.bottom) expect(left + right).toBe("└┘");
    else expect(left + right).toBe("││");
  }
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < cols; col++) {
      const inside = row + 1 >= rect.top && row + 1 <= rect.bottom && col + 1 >= rect.left && col + 1 <= rect.right;
      if (!inside) expect(`${row + 1}:${col + 1}:${screen.cell(row, col)}`).toBe(`${row + 1}:${col + 1}: `);
    }
  }
}

function queuePrompt(text: string, images: ImageAttachment[] = []): QueuePromptState {
  return { text, images, selection: "next-turn" };
}

describe("the queue prompt stays inside its box at any width", () => {
  for (const cols of WIDTHS) {
    for (const [name, text] of PREVIEWS) {
      test(`${name} at ${cols} columns`, () => {
        const { payload, rect } = renderQueuePromptOverlay(queuePrompt(text, [IMAGE]), cols, 1, SEP_ROW);
        if (cols < 2) {
          expect(payload).toBe("");
          return;
        }
        expectBoxed(paint(payload, cols), rect, cols);
      });
    }
  }

  test("beside the sidebar, the box stays within the chat area", () => {
    const sidebar = 32;
    for (const chatW of [45, 20, 6]) {
      const cols = sidebar + chatW;
      const { payload, rect } = renderQueuePromptOverlay(queuePrompt(PREVIEWS[0][1]), chatW, sidebar + 1, SEP_ROW);
      const screen = paint(payload, cols);
      expectBoxed(screen, rect, cols);
      expect(rect.left).toBeGreaterThan(sidebar);
    }
  });

  test("a narrow terminal keeps margins and cuts the preview with an ellipsis", () => {
    const { payload, rect } = renderQueuePromptOverlay(queuePrompt(PREVIEWS[0][1]), 45, 1, SEP_ROW);
    expect(rect.left).toBe(2);
    expect(rect.right).toBe(44);
    const rows = paint(payload, 45).plainRows();
    expect(rows.some(row => row.includes("Queue message:"))).toBe(true);
    expect(rows.some(row => /"btw I run a fork of karabiner \/ aeros[^"]*…" *│/.test(row))).toBe(true);
  });

  test("a wide terminal keeps the preview at its usual size", () => {
    const { rect } = renderQueuePromptOverlay(queuePrompt(PREVIEWS[0][1]), 120, 1, SEP_ROW);
    // 40-cell preview + quotes + 4 padding, plus the borders.
    expect(rect.right - rect.left + 1).toBe(48);
  });

  test("a very narrow terminal drops the preview before the options", () => {
    const { payload } = renderQueuePromptOverlay(queuePrompt(PREVIEWS[0][1]), 12, 1, SEP_ROW);
    const text = paint(payload, 12).plainRows().join("\n");
    expect(text).not.toContain('"');
    expect(text).toContain("Queue:");
    expect(text).toContain("│  message…│");
    expect(text).toContain("│▸ steer n…│");
  });
});

describe("the edit menu stays inside its box at any width", () => {
  const menu = (): EditMessageState => ({
    items: PREVIEWS.map(([, text], index) => ({ userMessageIndex: index, text, isQueued: false })),
    selection: PREVIEWS.length - 1,
    scrollOffset: 0,
  });

  for (const cols of WIDTHS) {
    test(`at ${cols} columns`, () => {
      const { payload, rect } = renderEditMessageOverlay(menu(), cols, 1, SEP_ROW, 4);
      if (!rect || cols < 2) {
        expect(payload).toBe("");
        return;
      }
      expectBoxed(paint(payload, cols), rect, cols);
    });
  }
});

describe("the queue prompt in a full frame", () => {
  function frame(state: RenderState): TerminalScreen {
    let out = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      invalidateFrame(state);
      render(state);
    } finally {
      process.stdout.write = origWrite as typeof process.stdout.write;
    }
    const screen = new TerminalScreen(state.rows, state.cols, { autowrap: true });
    screen.feed(out);
    return screen;
  }

  for (const cols of [120, 45, 30, 20]) {
    test(`keeps both borders on every row at ${cols} columns`, () => {
      const state = createInitialState();
      state.cols = cols;
      state.rows = ROWS;
      state.sidebar.open = false;
      state.queuePrompt = queuePrompt(PREVIEWS[0][1]);
      const screen = frame(state);
      expect(screen.autoWrapCount).toBe(0);
      const rect = renderQueuePromptOverlay(state.queuePrompt, cols, 1, state.layout.sepAbove).rect;
      expect(rect.right).toBeLessThanOrEqual(cols);
      for (let row = rect.top + 1; row < rect.bottom; row++) {
        expect(screen.cell(row - 1, rect.left - 1) + screen.cell(row - 1, rect.right - 1)).toBe("││");
      }
    });
  }
});
