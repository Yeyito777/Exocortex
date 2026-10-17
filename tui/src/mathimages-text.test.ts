/**
 * Display math images behave as text: one copy and selection unit under a
 * below-text placement (see mathimages.ts). Copies, highlight and overlays.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  displayMathImage,
  displayMathImageRows,
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
import { selectionTextOf, withSelectionText } from "./mathpng";

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

beforeEach(() => {
  inlineImagesInternalsForTest.reset();
  mathImagesInternalsForTest.reset({ setting: "image", rasterize: instantRasterizer });
  setInlineImageCellSize(cell);
});
afterEach(() => {
  inlineImagesInternalsForTest.reset();
  mathImagesInternalsForTest.reset();
});

describe("one copy unit", () => {
  test("the owner's equation: blank cells under the image, one logical line, the source copied once", () => {
    const rows = displayMathImageRows(image(20, 3), 76, OWNER_P, 0);
    expect(rows.lines).toEqual(["  ", "  ", "  "]);
    expect(rows.images.map(row => row?.row)).toEqual([0, 1, 2]);
    expect(rows.images[0]!.image).toMatchObject({ col: 2, cols: 20, rows: 3 });
    expect(rows.cont).toEqual([false, true, true]);
    const unit = rows.copy[0]!.atomic;
    expect(unit).toBeDefined();
    expect(rows.copy).toEqual([
      { text: OWNER_P, displayStart: 2, atomic: unit, source: OWNER_P },
      { text: OWNER_P, displayStart: 2, atomic: unit, source: null },
      { text: OWNER_P, displayStart: 2, atomic: unit, source: null },
    ]);
    expect(rows.copy.every(row => row!.atomic === unit)).toBe(true);
    expect(joinLogicalLines(rows.lines, rows.cont, 0, 2, rows.join, rows.copy)).toBe(OWNER_P);
  });

  test("an image as wide as the pane drops the indent", () => {
    expect(displayMathImageRows(image(29, 1), 30, "$$x$$", 0).images[0]!.image.col).toBe(1);
    expect(displayMathImageRows(image(10, 1), 20, "$$x$$", 0).images[0]!.image.col).toBe(0);
  });

  test("the PNG carries the source as its selection-text, and the source keys the render", async () => {
    const requests: MathRenderRequest[] = [];
    mathImagesInternalsForTest.reset({ setting: "image", rasterize: request => { requests.push(request); return instantRasterizer(request); } });
    displayMathImage("x", 40, undefined, "$$x$$");
    displayMathImage("x", 40, undefined, "\\[x\\]");
    displayMathImage("x", 40, undefined, "$$x$$");
    expect(requests.map(request => request.text)).toEqual(["$$x$$", "\\[x\\]"]);

    const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64"));
    const tagged = withSelectionText(png, OWNER_P);
    expect(selectionTextOf(tagged)).toBe(OWNER_P);
    expect(selectionTextOf(png)).toBeNull();
    // Still a valid PNG: the chunk sits after IHDR with a correct CRC.
    const chunkLength = new DataView(tagged.buffer).getUint32(33);
    const crc = new DataView(tagged.buffer).getUint32(33 + 8 + chunkLength);
    expect(crc).toBe(Bun.hash.crc32(tagged.subarray(37, 41 + chunkLength)) >>> 0);
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
    expect(stripAnsi(built.lines[middle]).trim()).toBe("");
    expect(built.copyLines[middle]).toMatchObject({ text: OWNER_P, atomic: built.copyLines[mathRows[0]]!.atomic });

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

  test("rendered frame: highlighted math rows keep the image whole, the highlight behind it", async () => {
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
    theme.historyLineBg = highlight;

    // A line yank of any of its rows copies the TeX.
    state.vim.mode = "visual-line";
    state.historyVisualAnchor = { row: first, col: 0 };
    state.historyCursor = { row: first + 2, col: 0 };
    expect(getHistoryVisualSelection(state)).toBe(OWNER_P);
    disposeHistoryImages(state);
  });

  test("the TUI's visual selection takes an equation as one unit: its rectangle, its source once", async () => {
    const state = ownerState();
    const first = await showEquation(state, 5);
    const top = placements(capture(state))[0].row;
    const selection = theme.selectionBg;
    theme.selectionBg = "\x1b[48;5;90m";
    state.panelFocus = "chat";
    state.chatFocus = "history";
    state.vim.mode = "visual";
    // A charwise selection inside one row of the first equation.
    state.historyVisualAnchor = { row: first + 1, col: 10 };
    state.historyCursor = { row: first + 1, col: 12 };
    const frame = capture(state);
    const rowWrites = (out: string, row: number) => out.split(/(?=\x1b\[\d+;1H)/).filter(chunk => chunk.startsWith(`\x1b[${row};1H`)).join("");
    for (const screenRow of [top, top + 1, top + 2]) {
      const write = rowWrites(frame, screenRow);
      // The image's 60 columns, from its indent (assistant 2 + display 2), on every row
      // (the cursor's row draws its cursor cell inside it).
      expect(write).toContain(theme.selectionBg);
      expect(stripAnsi(write)).toBe(" ".repeat(4 + 60));
      if (screenRow !== top + 1) expect(write).toContain(`${theme.selectionBg}${" ".repeat(60)}`);
    }
    expect(getHistoryVisualSelection(state)).toBe(OWNER_P);

    // From the prose above through both equations: each source once, in order.
    state.historyVisualAnchor = { row: first - 2, col: 2 };
    state.historyCursor = { row: first + 5, col: 3 };
    expect(getHistoryVisualSelection(state)).toBe(`Thus:\n\n${OWNER_P}\n\n${OWNER_Q}`);
    theme.selectionBg = selection;
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
