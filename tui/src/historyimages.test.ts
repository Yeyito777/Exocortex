import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { collectHistoryImagePlacements, disposeHistoryImages, handleHistoryImageResponse, historyImagesPlaced, placementIdFor, syncHistoryImages } from "./historyimages";
import { configureInlineImages, inlineImagesInternalsForTest, kittyPreview, setInlineImageMode, setInlineImagesEnabled, type InlineImageLayout } from "./inlineimages";
import type { RenderLineAnchor } from "./conversation";
import { buildMessageLines } from "./conversation";
import { createInitialState } from "./state";
import { stripAnsi } from "./historycursor";

const source = { imageId: "d".repeat(64), width: 200, height: 100, mediaType: "image/png" as const, sizeBytes: 1000, name: "chart.png" };

async function readyImage(): Promise<void> {
  configureInlineImages({ fetch: async () => ({ format: "png", width: 200, height: 100, base64: "UE5H" }), onChange: () => {} });
  setInlineImageMode("kitty");
  kittyPreview(source, { cols: 20, rows: 10 });
  await Bun.sleep(0);
}

beforeEach(() => inlineImagesInternalsForTest.reset());
afterEach(() => inlineImagesInternalsForTest.reset());

/** History with `before` text rows, a 10-row image, then text. */
function history(before: number): { anchors: RenderLineAnchor[]; layout: InlineImageLayout } {
  const owner = {};
  const layout: InlineImageLayout = { source, col: 2, cols: 20, rows: 10, owner, index: 0 };
  const anchors: RenderLineAnchor[] = [];
  for (let i = 0; i < before; i++) anchors.push({ owner: {}, segment: "assistant_block", index: i, subIndex: 0 });
  for (let row = 0; row < 10; row++) anchors.push({ owner, segment: "assistant_image", index: 0, subIndex: row, images: [{ layout, row }] });
  for (let i = 0; i < 5; i++) anchors.push({ owner: {}, segment: "assistant_block", index: i, subIndex: 0 });
  return { anchors, layout };
}

function viewport(start: number, height: number) {
  return Array.from({ length: height }, (_, index) => ({ lineIndex: start + index, startCol: 0, displayPrefixWidth: 0 }));
}

const base = { messageAreaStart: 3, chatCol: 1, maxCol: 80, obstructions: [] };

describe("collectHistoryImagePlacements", () => {
  test("a fully visible image is placed whole at its row and indent", async () => {
    await readyImage();
    const { anchors, layout } = history(2);
    const [placement] = collectHistoryImagePlacements({ ...base, viewportRows: viewport(0, 20), lineAnchors: anchors });
    expect(placement).toMatchObject({ row: 5, col: 3, columns: 20, rows: 10, placementId: placementIdFor(layout.owner, 0) });
    expect(placement.sourceY).toBeUndefined();
  });

  test("scrolled partly above the viewport, the top of the source is cropped", async () => {
    await readyImage();
    const { anchors } = history(2);
    // Viewport starts at line 6: image rows 4..9 are visible at the top.
    const [placement] = collectHistoryImagePlacements({ ...base, viewportRows: viewport(6, 10), lineAnchors: anchors });
    expect(placement).toMatchObject({ row: 3, rows: 6, sourceY: 40, sourceHeight: 60 });
  });

  test("cut off by the bottom of the viewport, the bottom is cropped", async () => {
    await readyImage();
    const { anchors } = history(2);
    const [placement] = collectHistoryImagePlacements({ ...base, viewportRows: viewport(0, 5), lineAnchors: anchors });
    expect(placement).toMatchObject({ row: 5, rows: 3, sourceY: 0, sourceHeight: 30 });
  });

  test("rows under an obstruction are skipped and the larger remaining run wins", async () => {
    await readyImage();
    const { anchors } = history(0);
    const [placement] = collectHistoryImagePlacements({
      ...base,
      viewportRows: viewport(0, 15),
      lineAnchors: anchors,
      obstructions: [{ top: 3, bottom: 5, left: 15, right: 40 }],
    });
    expect(placement).toMatchObject({ row: 6, rows: 7, sourceY: 30, sourceHeight: 70 });
    // An obstruction beside the image does not crop it.
    const [beside] = collectHistoryImagePlacements({
      ...base, viewportRows: viewport(0, 15), lineAnchors: anchors, obstructions: [{ top: 3, bottom: 5, left: 60, right: 80 }],
    });
    expect(beside).toMatchObject({ row: 3, rows: 10 });
  });

  test("a cover (the image viewer) keeps every cell outside it, split into cropped pieces", async () => {
    await readyImage();
    const { anchors, layout } = history(0);
    const collect = (cover: { top: number; bottom: number; left: number; right: number }) => collectHistoryImagePlacements({
      ...base, viewportRows: viewport(0, 15), lineAnchors: anchors, covers: [cover],
    });
    // The image covers rows 3–12, columns 3–22; 200×100 source pixels, 10×10 per cell.
    // Beside the image: untouched.
    expect(collect({ top: 1, bottom: 20, left: 30, right: 60 })).toEqual([
      expect.objectContaining({ row: 3, col: 3, columns: 20, rows: 10, placementId: placementIdFor(layout.owner, 0) }),
    ]);
    expect(collect({ top: 1, bottom: 20, left: 30, right: 60 })[0].sourceX).toBeUndefined();
    // Over its right part from row 6 down: a band above and the left strip beside it.
    const [above, left, ...rest] = collect({ top: 6, bottom: 20, left: 13, right: 60 });
    expect(rest).toHaveLength(0);
    expect(above).toMatchObject({ row: 3, col: 3, columns: 20, rows: 3, sourceY: 0, sourceHeight: 30, placementId: placementIdFor(layout.owner, 0) });
    expect(above.sourceX).toBeUndefined();
    expect(left).toMatchObject({ row: 6, col: 3, columns: 10, rows: 7, sourceX: 0, sourceWidth: 100, sourceY: 30, sourceHeight: 70 });
    expect(left.placementId).not.toBe(above.placementId);
    // Through its middle: four pieces around the hole, each with its own placement.
    const pieces = collect({ top: 5, bottom: 8, left: 8, right: 15 });
    expect(pieces.map(({ row, col, columns, rows }) => ({ row, col, columns, rows }))).toEqual([
      { row: 3, col: 3, columns: 20, rows: 2 },
      { row: 5, col: 3, columns: 5, rows: 4 },
      { row: 5, col: 16, columns: 7, rows: 4 },
      { row: 9, col: 3, columns: 20, rows: 4 },
    ]);
    expect(pieces[2]).toMatchObject({ sourceX: 130, sourceWidth: 70, sourceY: 20, sourceHeight: 40 });
    expect(pieces[3]).toMatchObject({ sourceY: 60, sourceHeight: 40 });
    expect(new Set(pieces.map(piece => piece.placementId)).size).toBe(4);
    // Entirely under it: nothing to place.
    expect(collect({ top: 1, bottom: 20, left: 1, right: 60 })).toEqual([]);
  });

  test("several covers each cut their own hole; every piece has its own placement", async () => {
    await readyImage();
    const { anchors, layout } = history(0);
    // The image covers rows 3–12, columns 3–22. One box over its top right, one over its bottom left.
    const covers = [{ top: 1, bottom: 5, left: 13, right: 60 }, { top: 10, bottom: 20, left: 1, right: 8 }];
    const pieces = collectHistoryImagePlacements({ ...base, viewportRows: viewport(0, 15), lineAnchors: anchors, covers });
    expect(pieces.map(({ row, col, columns, rows }) => ({ row, col, columns, rows }))).toEqual([
      { row: 3, col: 3, columns: 10, rows: 3 },
      { row: 6, col: 3, columns: 20, rows: 4 },
      { row: 10, col: 9, columns: 14, rows: 3 },
    ]);
    expect(pieces[0].placementId).toBe(placementIdFor(layout.owner, 0));
    expect(new Set(pieces.map(piece => piece.placementId)).size).toBe(3);
    for (const piece of pieces) {
      for (const cover of covers) {
        const overlaps = piece.row <= cover.bottom && piece.row + piece.rows - 1 >= cover.top
          && piece.col <= cover.right && piece.col + piece.columns - 1 >= cover.left;
        expect(overlaps).toBe(false);
      }
    }
  });

  test("off-screen or not-yet-loaded images are not placed", async () => {
    const { anchors } = history(30);
    configureInlineImages({ fetch: () => new Promise(() => {}), onChange: () => {} });
    setInlineImageMode("kitty");
    expect(collectHistoryImagePlacements({ ...base, viewportRows: viewport(30, 10), lineAnchors: anchors })).toEqual([]);
    inlineImagesInternalsForTest.reset();
    await readyImage();
    expect(collectHistoryImagePlacements({ ...base, viewportRows: viewport(0, 20), lineAnchors: anchors })).toEqual([]);
  });

  test("images too wide for the chat area are not placed", async () => {
    await readyImage();
    const { anchors } = history(0);
    expect(collectHistoryImagePlacements({ ...base, maxCol: 15, viewportRows: viewport(0, 10), lineAnchors: anchors })).toEqual([]);
  });
});

describe("per-screen sync", () => {
  test("switching away deletes placements; ENOENT replies trigger a retransmit; dispose cleans up", async () => {
    await readyImage();
    const screen = {};
    const { anchors } = history(0);
    const placements = collectHistoryImagePlacements({ ...base, viewportRows: viewport(0, 12), lineAnchors: anchors });
    expect(syncHistoryImages(screen, placements)).toContain("a=t,t=d,f=100");
    expect(historyImagesPlaced(screen)).toBe(true);
    expect(handleHistoryImageResponse(screen, `\x1b_Gi=${placements[0].image.kittyId},p=1;ENOENT:image not found\x1b\\`)).toBe(true);
    expect(syncHistoryImages(screen, placements)).toContain("a=t,t=d,f=100");
    expect(syncHistoryImages(screen, [])).toContain("a=d,d=i");
    expect(historyImagesPlaced(screen)).toBe(false);
    expect(disposeHistoryImages(screen)).toContain("a=d,d=I");
    expect(syncHistoryImages({}, [])).toBe("");
  });
});

describe("history layout", () => {
  test("attached images close the assistant message, after its text and before metadata", async () => {
    await readyImage();
    const state = createInitialState();
    state.convId = "conv";
    state.rows = 40;
    const ref = { id: source.imageId, mediaType: "image/png" as const, width: 200, height: 100, sizeBytes: 1000, name: "chart.png" };
    state.messages = [
      { role: "user", text: "plot it", metadata: null },
      {
        role: "assistant",
        blocks: [
          { type: "tool_call", toolCallId: "c1", toolName: "attach", input: { paths: ["chart.png"] }, summary: "chart.png" },
          { type: "tool_result", toolCallId: "c1", toolName: "attach", output: "Attached 1 image", isError: false, images: [ref] },
          { type: "text", text: "Here is the chart." },
        ],
        metadata: { startedAt: 1, endedAt: 2, model: "gpt-5.5", tokens: 10 },
      },
    ];
    const { lines, lineAnchors } = buildMessageLines(state, 80);
    const imageRows = lineAnchors.flatMap((anchor, index) => anchor.images ? [index] : []);
    expect(imageRows.length).toBeGreaterThan(0);
    const textRow = lines.findIndex(line => stripAnsi(line).includes("Here is the chart."));
    const metadataRow = lineAnchors.findIndex(anchor => anchor.segment === "assistant_metadata");
    expect(textRow).toBeLessThan(imageRows[0]);
    // No caption: the viewer shows the name and size.
    expect(lines.some(line => stripAnsi(line).includes("200×100"))).toBe(false);
    expect(metadataRow).toBe(imageRows.at(-1)! + 1);
    // Rows are contiguous and numbered from the top of the image.
    expect(imageRows.map(index => lineAnchors[index].images![0].row)).toEqual(imageRows.map((_, row) => row));
  });

  test("with images off (daemon flag unset, or EXOCORTEX_TUI_IMAGES=off) history renders as before", async () => {
    await readyImage();
    const state = createInitialState();
    state.convId = "conv";
    const ref = { id: source.imageId, mediaType: "image/png" as const, width: 200, height: 100, sizeBytes: 1000, name: "chart.png" };
    state.messages = [
      { role: "user", text: "look", images: [{ mediaType: "image/png", base64: "", sizeBytes: 1000, imageId: source.imageId, width: 200, height: 100 }], metadata: null },
      {
        role: "assistant",
        blocks: [
          { type: "tool_result", toolCallId: "c1", toolName: "attach", output: "Attached 1 image", isError: false, images: [ref] },
          { type: "text", text: "Here it is." },
        ],
        metadata: null,
      },
    ];
    const withImages = buildMessageLines(state, 80);
    expect(withImages.lineAnchors.some(anchor => anchor.images)).toBe(true);

    for (const disable of [() => setInlineImagesEnabled(false), () => setInlineImageMode("off")]) {
      inlineImagesInternalsForTest.reset();
      disable();
      const { lines, lineAnchors } = buildMessageLines(state, 80);
      expect(lineAnchors.some(anchor => anchor.images || anchor.openImages)).toBe(false);
      expect(lines.some(line => stripAnsi(line).includes("200×100"))).toBe(false);
      // The pasted image keeps its old badge.
      expect(lines.some(line => stripAnsi(line).includes("📎 PNG"))).toBe(true);
    }
  });

  test("pasted images render under the user bubble, right-aligned", async () => {
    await readyImage();
    const state = createInitialState();
    state.convId = "conv";
    state.messages = [{ role: "user", text: "look", images: [{ mediaType: "image/png", base64: "", sizeBytes: 1000, imageId: source.imageId, width: 200, height: 100 }], metadata: null }];
    const { lineAnchors } = buildMessageLines(state, 80);
    const image = lineAnchors.find(anchor => anchor.images)?.images?.[0];
    expect(image?.layout.col).toBe(80 - 2 - image!.layout.cols);
    expect(lineAnchors.find(anchor => anchor.images)?.segment).toBe("user_image");
  });
});
