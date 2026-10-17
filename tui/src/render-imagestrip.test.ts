import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";
import {
  configureInlineImages,
  inlineImagesInternalsForTest,
  layoutInlineImageStrip,
  retryFailedImagePreviews,
  setInlineImageCellSize,
  setInlineImageMode,
  type InlineImageTarget,
} from "./inlineimages";
import { handleImageModalKey, renderImageModal, type ImageModalState } from "./imagemodal";
import { handleFocusedKey } from "./focus";
import { handleMouseEvent } from "./mouse";
import { disposeHistoryImages } from "./historyimages";
import { buildMessageLines } from "./conversation";
import { stripAnsi } from "./historycursor";
import type { ImageRef } from "./messages";
import { termWidth } from "./textwidth";
import { invalidateFrame } from "./frame";

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

/** A whole frame, as after a resize: every row written, not just those that changed. */
function invalidated(state: RenderState): string {
  invalidateFrame(state);
  return capture(state);
}

const placements = (out: string) => [...out.matchAll(/\x1b\[(\d+);(\d+)H\x1b_G(a=p[^;]*);/g)]
  .map(match => ({ row: Number(match[1]), col: Number(match[2]), controls: match[3] }));

const cell = { width: 8, height: 16 };
const portrait = { width: 945, height: 1253 };

function refs(count: number, size = portrait): ImageRef[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i).repeat(64).slice(0, 64),
    mediaType: "image/png" as const,
    width: size.width,
    height: size.height,
    sizeBytes: 533_000,
    name: `shot-${i + 1}.png`,
  }));
}

/** An assistant message that attached `images`, scrolled so it is on screen. */
function stripState(images: ImageRef[], cols = 120): RenderState {
  const state = createInitialState();
  state.cols = cols;
  state.rows = 40;
  state.convId = "conv";
  state.messages = [
    { role: "user", text: "show me", metadata: null },
    {
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "c1", toolName: "attach", input: { paths: images.map(image => image.name) }, summary: "" },
        { type: "tool_result", toolCallId: "c1", toolName: "attach", output: `Attached ${images.length} images`, isError: false, images },
        { type: "text", text: "Here they are." },
      ],
      metadata: { startedAt: 1, endedAt: 2, model: "gpt-5.5", tokens: 10 },
    },
    ...Array.from({ length: 60 }, (_, i) => ({ role: "system" as const, text: `filler ${i}`, metadata: null })),
  ];
  return state;
}

/** Scroll so the strip's top sits on viewport row `row`. */
function showStrip(state: RenderState, row = 5): void {
  capture(state);
  state.scrollOffset = state.layout.totalLines - state.layout.messageAreaHeight
    - state.historyLineAnchors.findIndex(anchor => anchor.images) + row;
}

async function readyFrame(state: RenderState): Promise<string> {
  capture(state);
  await Bun.sleep(0);
  await Bun.sleep(0);
  return capture(state);
}

const fetchPreview = async (request: { width: number; height: number; format: string }) => request.format === "png"
  ? { format: "png" as const, width: request.width, height: request.height, base64: "UE5H" }
  : { format: "rgba" as const, width: request.width, height: request.height, base64: Buffer.alloc(request.width * request.height * 4, 128).toString("base64") };

function kitty(): void {
  configureInlineImages({ fetch: fetchPreview, onChange: () => {} });
  setInlineImageMode("kitty");
  setInlineImageCellSize(cell);
}

const click = (state: RenderState, col: number, row: number) => {
  const base = { type: "mouse" as const, button: 0, shift: false, meta: false, ctrl: false, col, row };
  handleMouseEvent({ ...base, action: "press" }, state);
  return handleMouseEvent({ ...base, action: "release" }, state);
};

function focusHistoryAt(state: RenderState, row: number, col: number): void {
  state.vim.mode = "normal";
  state.panelFocus = "chat";
  state.chatFocus = "history";
  state.historyCursor = { row, col };
}

beforeEach(() => inlineImagesInternalsForTest.reset());
afterEach(() => inlineImagesInternalsForTest.reset());

describe("strip layout", () => {
  const limits = { cols: 56, rows: 12 };

  test("images that fit sit side by side at a common height with a gap", () => {
    const strip = layoutInlineImageStrip([portrait, portrait, portrait], limits, 100, cell);
    expect(strip.rows).toBe(12);
    expect(strip.boxes.map(box => box.rows)).toEqual([12, 12, 12]);
    const cols = strip.boxes[0].cols;
    expect(strip.slots).toEqual([{ start: 0, width: cols }, { start: cols + 2, width: cols }, { start: 2 * cols + 4, width: cols }]);
    expect(strip.overflow).toBeNull();
    expect(strip.width).toBe(3 * cols + 4);
  });

  test("what doesn't fit hides behind `› +N`, and the strip stays within the width", () => {
    const strip = layoutInlineImageStrip(Array.from({ length: 5 }, () => portrait), limits, 60, cell);
    expect(strip.boxes.length).toBe(2);
    expect(strip.overflow?.label).toBe("› +3");
    expect(strip.width).toBeLessThanOrEqual(60);
    expect(strip.overflow!.start).toBe(strip.slots[1].start + strip.slots[1].width + 2);
  });

  test("a narrow terminal still shows one image, shrunk to leave room for the label", () => {
    const strip = layoutInlineImageStrip([{ width: 1600, height: 900 }, portrait], limits, 20, cell);
    expect(strip.boxes.length).toBe(1);
    expect(strip.width).toBeLessThanOrEqual(20);
    expect(strip.boxes[0].cols).toBeLessThanOrEqual(20 - 2 - "› +1".length);
  });

  test("different shapes share the strip; a short image sits on the baseline", () => {
    kitty();
    const [wideRef] = refs(1, { width: 3000, height: 300 });
    const [, tallRef] = refs(2);
    const state = stripState([wideRef, tallRef], 160);
    const { lines, lineAnchors } = buildMessageLines(state, 156);
    const rows = lineAnchors.flatMap((anchor, index) => anchor.images ? [index] : []);
    expect(rows.length).toBe(12);
    // The wide image only covers the bottom rows, the tall one all of them.
    expect(lineAnchors[rows[0]].images!.length).toBe(1);
    expect(lineAnchors[rows.at(-1)!].images!.length).toBe(2);
    const wide = lineAnchors[rows.at(-1)!].images!.find(image => "source" in image.layout && image.layout.source.width === 3000)!;
    expect(wide.row).toBe(wide.layout.rows - 1);
    // The strip ends the message: its metadata follows the last image row.
    expect(lineAnchors[rows.at(-1)! + 1].segment).toBe("assistant_metadata");
    expect(lines.some(line => line.includes("3000×300"))).toBe(false);
  });
});

describe("strip in history", () => {
  test("a single image is one thumbnail with no legend; a yank still names it", () => {
    kitty();
    const { lines, lineAnchors, copyLines } = buildMessageLines(stripState(refs(1)), 116);
    const rows = lineAnchors.flatMap((anchor, index) => anchor.images ? [index] : []);
    expect(rows.length).toBe(12);
    expect(rows.every(row => lineAnchors[row].images!.length === 1)).toBe(true);
    expect(lines.some(line => line.includes("945×1253"))).toBe(false);
    expect(lines.some(line => line.includes("› +"))).toBe(false);
    expect(copyLines[rows[0]]?.text).toBe("[image: shot-1.png · 945×1253 · 521 KB]");
    expect(rows.slice(1).every(row => copyLines[row]?.skip)).toBe(true);
  });

  test("several images form one row of thumbnails, with no legend under them", async () => {
    kitty();
    const state = stripState(refs(3));
    showStrip(state);
    const shown = placements(await readyFrame(state));
    expect(shown.length).toBe(3);
    expect(new Set(shown.map(placement => placement.row)).size).toBe(1);
    expect(shown.map(placement => placement.col)).toEqual([...shown.map(placement => placement.col)].sort((a, b) => a - b));
    expect(state.historyLines.some(line => line.includes("945×1253"))).toBe(false);
    expect(state.historyLines.some(line => line.includes("› +"))).toBe(false);
    // The last image row is followed directly by the message's metadata.
    const last = state.historyLineAnchors.findLastIndex(anchor => anchor.images);
    expect(state.historyLineAnchors[last + 1].segment).toBe("assistant_metadata");
    disposeHistoryImages(state);
  });

  test("notices stay inside the pane at every width, sidebar open or not", async () => {
    const failing = async () => { throw new Error("get_image: image not found in the daemon's image store"); };
    for (const mode of ["kitty", "halfblock"] as const) {
      for (const sidebar of [false, true]) {
        for (const cols of [44, 52, 60, 72, 90, 120]) {
          for (const shape of ["user", "assistant", "user strip", "assistant strip"] as const) {
            inlineImagesInternalsForTest.reset();
            configureInlineImages({ fetch: failing, onChange: () => {} });
            setInlineImageMode(mode);
            const count = shape.endsWith("strip") ? 4 : 1;
            const state = stripState(refs(count, { width: 796, height: 306 }), cols);
            state.convId = null;
            state.sidebar.open = sidebar;
            if (shape.startsWith("user")) {
              state.messages = [{
                role: "user",
                text: "look",
                images: refs(count, { width: 796, height: 306 }).map(ref => ({ mediaType: "image/png" as const, base64: "", sizeBytes: 101_000, imageId: ref.id, width: 796, height: 306 })),
                metadata: null,
              }];
            }
            showStrip(state);
            capture(state);
            await Bun.sleep(0);
            const out = capture(state) + capture(state);
            // Kitty draws the notice over the image rows; the fallback writes it into them.
            expect(stripAnsi(mode === "kitty" ? out : state.historyLines.join("\n"))).toContain("⚠");
            // Every positioned write ends inside the screen, so nothing autowraps into the sidebar.
            for (const write of out.matchAll(/\x1b\[(\d+);(\d+)H((?:(?!\x1b\[\d+;\d+H)[\s\S])*)/g)) {
              const text = write[3].replace(/\x1b_G[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
              const end = Number(write[2]) + termWidth(text) - 1;
              if (end > cols) throw new Error(`${mode} sidebar=${sidebar} cols=${cols} ${shape}: row ${write[1]} col ${write[2]} runs to ${end}: ${JSON.stringify(text)}`);
            }
            // And every image row is built to fit the chat pane.
            const paneWidth = cols - (state.layout.chatCol - 1);
            state.historyLines.forEach((line, index) => {
              if (state.historyLineAnchors[index].images) expect(termWidth(stripAnsi(line))).toBeLessThanOrEqual(paneWidth);
            });
            disposeHistoryImages(state);
          }
        }
      }
    }
  });

  test("an attached image missing from the store shows unavailable at once and stays so", async () => {
    let fetches = 0;
    configureInlineImages({ fetch: async () => { fetches++; throw new Error("get_image: image not found"); }, onChange: () => {} });
    setInlineImageMode("kitty");
    const state = stripState(refs(1));
    showStrip(state);
    const screen = () => stripAnsi(invalidated(state));
    expect(screen()).toContain("loading image…");
    await Bun.sleep(0);
    // Unlike a just-sent paste, there is nothing to wait for: no retries.
    expect(screen()).toContain("⚠ image unavailable: get_image: image not found");
    await Bun.sleep(600);
    expect(fetches).toBe(1);
    expect(screen()).not.toContain("loading image…");
    // Nor is it asked for again every few seconds while it stays on screen; a new connection may have it.
    const now = Date.now;
    Date.now = () => now() + 60_000;
    try {
      screen();
      await Bun.sleep(0);
      expect(fetches).toBe(1);
    } finally {
      Date.now = now;
    }
    retryFailedImagePreviews();
    screen();
    await Bun.sleep(0);
    expect(fetches).toBe(2);
  });

  test("only thumbnails on or near the screen are fetched, and their arrival does not re-render history", async () => {
    const requested: string[] = [];
    configureInlineImages({ fetch: async request => { requested.push(request.imageId); return fetchPreview(request); }, onChange: () => {} });
    setInlineImageMode("kitty");
    setInlineImageCellSize(cell);
    const state = stripState(refs(1));
    // Twenty more messages with an image each, far above the first.
    const older = refs(20).map((ref, i) => ({ ...ref, id: (i + 10).toString(16).repeat(64).slice(0, 64) }));
    state.messages.unshift(...older.flatMap((ref, i) => [
      { role: "user" as const, text: `older ${i}`, metadata: null },
      {
        role: "assistant" as const,
        blocks: [
          { type: "tool_result" as const, toolCallId: `o${i}`, toolName: "attach", output: "Attached 1 image", isError: false, images: [ref] },
          ...Array.from({ length: 30 }, (_, line) => ({ type: "text" as const, text: `line ${line}` })),
        ],
        metadata: { startedAt: 1, endedAt: 2, model: "gpt-5.5", tokens: 10 },
      },
    ]));
    showStrip(state);
    const history = state.historyLines;
    capture(state);
    await Bun.sleep(0);
    const out = capture(state);
    expect(requested[0]).toBe(refs(1)[0].id);
    // The image on screen and at most the nearest one above; not the other nineteen.
    expect(requested.length).toBeLessThanOrEqual(2);
    expect(placements(out)).toHaveLength(1);
    expect(state.historyLines).toBe(history);
  });

  test("overflow: as many as fit, then `› +N` that a click or the cursor plus Enter opens", async () => {
    kitty();
    const state = stripState(refs(5), 70);
    showStrip(state);
    const shown = placements(await readyFrame(state));
    const visible = shown.length;
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(5);
    const arrowRow = state.historyLines.findIndex(line => stripAnsi(line).includes(`› +${5 - visible}`));
    expect(arrowRow).toBeGreaterThan(-1);
    const arrowCol = stripAnsi(state.historyLines[arrowRow]).indexOf("›");

    // A click on the label opens the viewer on the first hidden image.
    const screenRow = 3 + state.layout.historyViewportRows.findIndex(row => row?.lineIndex === arrowRow);
    const opened = click(state, state.layout.chatCol + arrowCol + 1, screenRow);
    expect(opened).toMatchObject({ type: "open_image", target: { index: visible } });
    expect((opened as { target: InlineImageTarget }).target.images.length).toBe(5);

    // So does Enter with the history cursor on it.
    focusHistoryAt(state, arrowRow, arrowCol);
    expect(handleFocusedKey({ type: "enter" }, state)).toMatchObject({ type: "open_image", target: { index: visible } });
    // `$` on that row reaches it.
    focusHistoryAt(state, arrowRow, 0);
    handleFocusedKey({ type: "char", char: "$" }, state);
    expect(handleFocusedKey({ type: "enter" }, state)).toMatchObject({ type: "open_image", target: { index: visible } });
    disposeHistoryImages(state);
  });

  test("clicks and the cursor pick the thumbnail under them; the tint follows the cursor", async () => {
    kitty();
    const state = stripState(refs(3));
    showStrip(state);
    const shown = placements(await readyFrame(state));
    const second = shown[1];
    expect(click(state, second.col + 2, second.row + 3)).toMatchObject({ type: "open_image", target: { index: 1 } });
    // Between thumbnails is not an image.
    expect(click(state, second.col - 1, second.row + 3).type).not.toBe("open_image");

    // The cursor can cross an image row (its cells aren't whitespace) and selects what it is on.
    const imageRow = state.historyLineAnchors.findIndex(anchor => anchor.images) + 3;
    focusHistoryAt(state, imageRow, 0);
    handleFocusedKey({ type: "char", char: "$" }, state);
    expect(handleFocusedKey({ type: "enter" }, state)).toMatchObject({ type: "open_image", target: { index: 2 } });
    focusHistoryAt(state, imageRow, second.col - state.layout.chatCol + 1);
    expect(handleFocusedKey({ type: "enter" }, state)).toMatchObject({ type: "open_image", target: { index: 1 } });
    const tinted = placements(capture(state));
    expect(tinted.filter(placement => placement.controls.includes("V=1")).map(placement => placement.col)).toEqual([second.col]);
    disposeHistoryImages(state);
  });

  test("scrolled partly out of view, every thumbnail in the strip is cropped alike", async () => {
    kitty();
    const state = stripState(refs(3));
    showStrip(state, -4);
    const shown = placements(await readyFrame(state));
    expect(shown.length).toBe(3);
    for (const placement of shown) expect(placement.controls).toMatch(/,x=0,y=\d+,w=\d+,h=\d+,/);
    disposeHistoryImages(state);
  });

  test("the half-block fallback draws the thumbnails side by side as text", async () => {
    configureInlineImages({ fetch: fetchPreview, onChange: () => {} });
    setInlineImageMode("halfblock");
    const state = stripState(refs(3));
    showStrip(state);
    const out = await readyFrame(state);
    expect(out).not.toContain("\x1b_G");
    const row = state.historyLines.find(line => line.includes("▀"))!;
    expect(stripAnsi(row)).toMatch(/^ +▀+ {2}▀+ {2}▀+$/);
  });

  test("pasted images form a right-aligned strip under the user's bubble", () => {
    kitty();
    const state = stripState(refs(1));
    state.messages = [{
      role: "user",
      text: "look",
      images: refs(3).map(ref => ({ mediaType: "image/png" as const, base64: "", sizeBytes: 1000, imageId: ref.id, width: ref.width, height: ref.height })),
      metadata: null,
    }];
    const { lineAnchors, lines } = buildMessageLines(state, 116);
    const row = lineAnchors.findIndex(anchor => anchor.images?.length === 3);
    expect(lineAnchors[row].segment).toBe("user_image");
    const last = lineAnchors[row].images!.at(-1)!.layout;
    expect(last.col + last.cols).toBe(116 - 2);
    expect(stripAnsi(lines[row]).length).toBe(116 - 2);
  });
});

describe("viewer paging", () => {
  const sources = refs(5).map(ref => ({ imageId: ref.id, width: ref.width, height: ref.height, mediaType: ref.mediaType, sizeBytes: ref.sizeBytes, name: ref.name }));

  test("j/k (l/h, →/←) step through the message's images and stop at either end", () => {
    const modal: ImageModalState = { images: sources, index: 1 };
    expect(handleImageModalKey({ type: "char", char: "j" }, modal)).toBe("handled");
    expect(modal.index).toBe(2);
    handleImageModalKey({ type: "char", char: "k" }, modal);
    handleImageModalKey({ type: "left" }, modal);
    expect(modal.index).toBe(0);
    handleImageModalKey({ type: "char", char: "h" }, modal);
    expect(modal.index).toBe(0);
    for (let i = 0; i < 6; i++) handleImageModalKey(i % 2 ? { type: "right" } : { type: "char", char: "l" }, modal);
    expect(modal.index).toBe(4);
    expect(handleImageModalKey({ type: "char", char: "q" }, modal)).toBe("close");
    expect(handleImageModalKey({ type: "escape" }, modal)).toBe("close");
    expect(handleImageModalKey({ type: "enter" }, modal)).toBe("close");
  });

  test("the viewer shows the current image, its position, and preloads the next one", async () => {
    const requested: string[] = [];
    configureInlineImages({ fetch: async request => { requested.push(request.imageId); return fetchPreview(request); }, onChange: () => {} });
    const modal: ImageModalState = { images: sources, index: 1 };
    const first = renderImageModal(modal, 40, 120, cell, "kitty");
    expect(stripAnsi(first.payload)).toContain("shot-2.png · 945×1253");
    expect(stripAnsi(first.payload)).toContain("2/5 · j/k for more · Enter or Esc to close");
    await Bun.sleep(0);
    const loaded = renderImageModal(modal, 40, 120, cell, "kitty");
    expect(loaded.placement).not.toBeNull();
    expect(requested).toEqual([sources[1].imageId, sources[2].imageId]);
    handleImageModalKey({ type: "char", char: "j" }, modal);
    expect(stripAnsi(renderImageModal(modal, 40, 120, cell, "kitty").payload)).toContain("3/5");
  });

  test("opening from a thumbnail starts at it; one image keeps the plain footer", async () => {
    kitty();
    const state = stripState(refs(3));
    showStrip(state);
    const shown = placements(await readyFrame(state));
    const result = click(state, shown[2].col + 1, shown[2].row + 1) as { type: string; target: InlineImageTarget };
    expect(result.target.index).toBe(2);
    state.imageModal = { images: result.target.images, index: result.target.index };
    expect(stripAnsi(capture(state))).toContain("3/3 ·");
    state.imageModal = null;
    capture(state);
    expect(stripAnsi(renderImageModal({ images: sources.slice(0, 1), index: 0 }, 40, 120, cell, "kitty").payload)).not.toContain("1/1");
    disposeHistoryImages(state);
  });
});
