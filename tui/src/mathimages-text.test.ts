/**
 * Display math images behave as text: concealed TeX under a below-text
 * placement (see mathimages.ts). Layout, copies, highlight and overlays.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  displayMathImageRows,
  hiddenTexRows,
  mathImagesInternalsForTest,
  type MathImage,
  type MathRenderRequest,
  type MathRenderResponse,
} from "./mathimages";
import { inlineImagesInternalsForTest, setInlineImageCellSize } from "./inlineimages";
import { buildMessageLines } from "./conversation";
import { collectHistoryImagePlacements, disposeHistoryImages, MATH_IMAGE_Z } from "./historyimages";
import { getHistoryVisualSelection, joinLogicalLines, stripAnsi } from "./historycursor";
import { logicalLineRange } from "./historymotions";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";
import { theme } from "./theme";
import { renderQueuePromptOverlay } from "./overlays";

const OWNER_P = "$$P_{new} = 83 + \\frac{10}{3} = 86.33$$";
const OWNER_Q = "$$Q_{new} = 249 - 2(86.33) = 76.33$$";
const cell = { width: 8, height: 16 };

/** Every equation is 60 × 3 cells, settled at once. */
function instantRasterizer(request: MathRenderRequest): Promise<MathRenderResponse> {
  return Promise.resolve({
    id: request.id,
    ok: true,
    base64: `PNG:${request.tex}`,
    pixelWidth: 60 * request.cellWidth,
    pixelHeight: 3 * request.cellHeight,
    cols: 60,
    rows: 3,
  });
}

const image = (cols: number, rows: number): MathImage => ({
  kitty: { kittyId: 1, base64: "UE5H", pixelWidth: cols * 8, pixelHeight: rows * 16 },
  cols,
  rows,
});

const joinRows = (rows: { text: string; join: string }[]) => rows.map(row => row.join + row.text).join("");

beforeEach(() => {
  inlineImagesInternalsForTest.reset();
  mathImagesInternalsForTest.reset({ setting: "image", rasterize: instantRasterizer });
  setInlineImageCellSize(cell);
});
afterEach(() => {
  inlineImagesInternalsForTest.reset();
  mathImagesInternalsForTest.reset();
});

describe("hidden TeX layout", () => {
  test("an equation that fits is one row, delimiters included", () => {
    expect(hiddenTexRows(OWNER_P, 48)).toEqual([{ text: OWNER_P, join: "" }]);
  });

  test("delimiter-only lines join their neighbours, unless a comment would swallow the closer", () => {
    expect(hiddenTexRows("$$\nx^2\n$$", 40)).toEqual([{ text: "$$x^2$$", join: "" }]);
    expect(hiddenTexRows("\\[\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n\\]", 40).map(row => row.text))
      .toEqual(["\\[\\begin{aligned}", "a &= b \\\\", "c &= d", "\\end{aligned}\\]"]);
    expect(hiddenTexRows("$$\nx % note\n$$", 40)).toEqual([
      { text: "$$x % note", join: "" },
      { text: "$$", join: "\n" },
    ]);
    // An escaped percent is not a comment.
    expect(hiddenTexRows("$$\n50\\%\n$$", 40).map(row => row.text)).toEqual(["$$50\\%$$"]);
  });

  test("long lines wrap at spaces, and the rows join back into the source", () => {
    const rows = hiddenTexRows(OWNER_P, 16);
    expect(rows.every(row => row.text.length <= 16)).toBe(true);
    expect(rows.map(row => row.join)).toEqual(["", " ", " "]);
    expect(joinRows(rows)).toBe(OWNER_P);
  });

  test("without spaces, a hard break never splits a control word", () => {
    const rows = hiddenTexRows("$$\\alpha\\beta\\gamma$$", 9);
    expect(rows).toEqual([
      { text: "$$\\alpha", join: "" },
      { text: "\\beta", join: "" },
      { text: "\\gamma$$", join: "" },
    ]);
  });

  test("the owner's equation: concealed TeX on the image's middle row, one logical line", () => {
    const rows = displayMathImageRows(image(20, 3), 76, OWNER_P, 0);
    expect(rows.lines).toEqual([
      "  ",
      `  \x1b[8m${OWNER_P}\x1b[28m`,
      "  ",
    ]);
    expect(rows.images.map(row => row?.row)).toEqual([0, 1, 2]);
    expect(rows.images[0]!.image).toMatchObject({ col: 2, cols: 20, rows: 3 });
    expect(rows.cont).toEqual([false, true, true]);
    expect(rows.copy).toEqual([
      { text: "", displayStart: 0, skip: true },
      { text: OWNER_P, displayStart: 2, source: OWNER_P },
      { text: "", displayStart: 0, skip: true },
    ]);
    expect(joinLogicalLines(rows.lines, rows.cont, 0, 2, rows.join, rows.copy)).toBe(OWNER_P);
  });

  test("TeX longer than the image's rows grows the block; the image stays centred in it", () => {
    const rows = displayMathImageRows(image(10, 1), 30, OWNER_P, 0);
    // From the image's left edge (the 2-cell indent) to the pane edge: 28 cells per row.
    expect(rows.lines.map(stripAnsi)).toEqual(hiddenTexRows(OWNER_P, 28).map(row => `  ${row.text}`));
    expect(rows.lines.length).toBe(2);
    expect(rows.images.map(row => row?.row)).toEqual([0, undefined]);
    expect(rows.cont).toEqual([false, true]);
    expect(joinLogicalLines(rows.lines, rows.cont, 0, rows.lines.length - 1, rows.join, rows.copy)).toBe(OWNER_P);
  });

  test("an image as wide as the pane drops the indent", () => {
    expect(displayMathImageRows(image(29, 1), 30, "$$x$$", 0).images[0]!.image.col).toBe(1);
    expect(displayMathImageRows(image(10, 1), 20, "$$x$$", 0).images[0]!.image.col).toBe(0);
  });
});

/** The owner's message, with history padding so it can scroll. */
function ownerState(): RenderState {
  const state = createInitialState();
  state.cols = 100;
  state.rows = 40;
  state.convId = "conv";
  state.messages = [
    { role: "assistant", blocks: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `earlier ${i}`).join("\n") }], metadata: null },
    { role: "user", text: "solve it", metadata: null },
    {
      role: "assistant",
      blocks: [{ type: "text", text: `Thus:\n\n${OWNER_P}\n\n${OWNER_Q}\n\nDone.` }],
      metadata: { startedAt: 1, endedAt: 2, model: "gpt-5.5", tokens: 10 },
    },
    ...Array.from({ length: 50 }, (_, i) => ({ role: "system" as const, text: `filler ${i}`, metadata: null })),
  ];
  return state;
}

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

async function settledFrame(state: RenderState): Promise<string> {
  capture(state);
  await Bun.sleep(0);
  await Bun.sleep(0);
  return capture(state);
}

const placements = (out: string) => [...out.matchAll(/\x1b\[(\d+);(\d+)H\x1b_G(a=p[^;]*);/g)]
  .map(match => ({ row: Number(match[1]), col: Number(match[2]), controls: match[3] }));

/** Scroll so the first equation's top sits on viewport row `row`. */
async function showEquation(state: RenderState, row: number): Promise<number> {
  await settledFrame(state);
  const first = state.historyLineAnchors.findIndex(anchor => anchor.images);
  state.scrollOffset = state.layout.totalLines - state.layout.messageAreaHeight - first + row;
  return first;
}

describe("history behaviour", () => {
  test("placements draw below text, are never tinted, and the highlight spans the equation", async () => {
    const state = ownerState();
    state.messages = state.messages.slice(1);
    buildMessageLines(state, 96);
    await Bun.sleep(0);
    const built = buildMessageLines(state, 96);
    const mathRows = built.lineAnchors.flatMap((anchor, index) => (anchor.images ? [index] : []));
    expect(mathRows).toHaveLength(6);
    const middle = mathRows[1];
    expect(stripAnsi(built.lines[middle]).trim()).toBe(OWNER_P);

    // The cursor's logical line (the history highlight) is the whole equation.
    expect(logicalLineRange(middle, built.wrapContinuation)).toEqual({ first: mathRows[0], last: mathRows[2] });

    const viewportRows = built.lines.map((_, lineIndex) => ({ lineIndex, startCol: 0, displayPrefixWidth: 0 }));
    const base = { viewportRows, lineAnchors: built.lineAnchors, messageAreaStart: 1, chatCol: 1, maxCol: 96, obstructions: [], mathOnly: true };
    const onCursor = collectHistoryImagePlacements({ ...base, cursorLineIndex: middle, cursorCol: 40 });
    expect(onCursor).toHaveLength(2);
    for (const placement of onCursor) {
      expect(placement.z).toBe(MATH_IMAGE_Z);
      expect(placement.selected).toBeUndefined();
      // Whole image: the highlighted rows do not crop it.
      expect(placement.rows).toBe(3);
      expect(placement.sourceY).toBeUndefined();
    }

    // Overlays still crop it (they are text, which a below-text image would show through).
    const covered = collectHistoryImagePlacements({ ...base, covers: [{ top: middle + 1, bottom: middle + 1, left: 1, right: 96 }] });
    const pieces = covered.filter(placement => placement.image.base64.includes("P_{new}"));
    expect(pieces.map(piece => [piece.row, piece.rows, piece.z])).toEqual([[mathRows[0] + 1, 1, MATH_IMAGE_Z], [mathRows[2] + 1, 1, MATH_IMAGE_Z]]);
    const panel = collectHistoryImagePlacements({ ...base, obstructions: [{ top: mathRows[0] + 1, bottom: mathRows[0] + 1, left: 1, right: 96 }] });
    expect(panel.find(placement => placement.image.base64.includes("P_{new}"))).toMatchObject({ row: mathRows[0] + 2, rows: 2 });
  });

  test("rendered frame: highlighted math rows keep the image whole, with the TeX concealed under it", async () => {
    const state = ownerState();
    const first = await showEquation(state, 5);
    const frame = capture(state);
    const top = placements(frame)[0]?.row ?? -1;
    expect(placements(frame).map(placement => placement.controls)).toEqual([
      expect.stringContaining(",z=-1,q=1"),
      expect.stringContaining(",z=-1,q=1"),
    ]);

    const highlight = theme.historyLineBg;
    theme.historyLineBg = "\x1b[48;5;17m";
    state.vim.mode = "normal";
    state.panelFocus = "chat";
    state.chatFocus = "history";
    state.historyCursor = { row: first + 1, col: 40 };
    const highlighted = capture(state);
    // Same placements: no re-place, no crop, no tint.
    expect(placements(highlighted)).toEqual([]);
    expect(highlighted).not.toContain("V=1");
    const rowWrites = (out: string, row: number) => out.split(/(?=\x1b\[\d+;1H)/).filter(chunk => chunk.startsWith(`\x1b[${row};1H`)).join("");
    for (const screenRow of [top, top + 1, top + 2]) expect(rowWrites(highlighted, screenRow)).toContain(theme.historyLineBg);
    expect(stripAnsi(rowWrites(highlighted, top + 1))).toContain(OWNER_P);
    theme.historyLineBg = highlight;

    // A line yank of any of its rows copies the TeX.
    state.vim.mode = "visual-line";
    state.historyVisualAnchor = { row: first, col: 0 };
    state.historyCursor = { row: first + 2, col: 0 };
    expect(getHistoryVisualSelection(state)).toBe(OWNER_P);
    disposeHistoryImages(state);
  });

  test("scrolled half off-screen, the image is cropped to its visible rows", async () => {
    const state = ownerState();
    await showEquation(state, 5);
    const whole = placements(capture(state))[0];
    const messageAreaStart = whole.row - 5;
    // One image row above the history area.
    state.scrollOffset -= 6;
    const shown = placements(capture(state));
    expect(shown[0]).toMatchObject({ row: messageAreaStart });
    expect(shown[0].controls).toMatch(/,x=0,y=16,w=480,h=32,.*z=-1/);
    disposeHistoryImages(state);
  });

  test("the queue prompt crops the equations it covers", async () => {
    const state = ownerState();
    await showEquation(state, 5);
    const whole = placements(capture(state))[0];
    const queuePrompt = { text: "next", selection: "next-turn" as const };
    const box = renderQueuePromptOverlay(queuePrompt, state.cols, 1, state.layout.sepAbove).rect;
    // The first equation's top row just above the box, the rest under it.
    state.scrollOffset += box.top - 1 - whole.row;
    capture(state);
    state.queuePrompt = queuePrompt;
    const after = placements(capture(state));
    expect(after).toContainEqual({ row: box.top - 1, col: whole.col, controls: expect.stringMatching(/,x=0,y=0,w=480,h=16,.*z=-1/) });
    // The rows beside the box keep their image; nothing is placed inside it.
    expect(after.some(placement => placement.row === box.top && placement.col < box.left)).toBe(true);
    for (const placement of after) {
      const columns = Number(/,c=(\d+)/.exec(placement.controls)![1]);
      const rows = Number(/,r=(\d+)/.exec(placement.controls)![1]);
      const overlaps = placement.row <= box.bottom && placement.row + rows - 1 >= box.top
        && placement.col <= box.right && placement.col + columns - 1 >= box.left;
      expect(overlaps).toBe(false);
    }
    disposeHistoryImages(state);
  });
});
