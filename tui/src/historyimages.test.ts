import { afterEach, describe, expect, test } from "bun:test";
import { collectHistoryImagePlacements, disposeHistoryImages, handleHistoryImageResponse, historyImagesPlaced, placementIdFor, syncHistoryImages } from "./historyimages";
import { configureInlineImages, inlineImagesInternalsForTest, kittyPreview, setInlineImageMode, type InlineImageLayout } from "./inlineimages";
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

afterEach(() => inlineImagesInternalsForTest.reset());

/** History with `before` text rows, a 10-row image, then text. */
function history(before: number): { anchors: RenderLineAnchor[]; layout: InlineImageLayout } {
  const owner = {};
  const layout: InlineImageLayout = { source, col: 2, cols: 20, rows: 10, owner, index: 0 };
  const anchors: RenderLineAnchor[] = [];
  for (let i = 0; i < before; i++) anchors.push({ owner: {}, segment: "assistant_block", index: i, subIndex: 0 });
  for (let row = 0; row < 10; row++) anchors.push({ owner, segment: "assistant_image", index: 0, subIndex: row, image: { layout, row } });
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
    const imageRows = lineAnchors.flatMap((anchor, index) => anchor.image ? [index] : []);
    expect(imageRows.length).toBeGreaterThan(0);
    const textRow = lines.findIndex(line => stripAnsi(line).includes("Here is the chart."));
    const captionRow = lines.findIndex(line => stripAnsi(line).includes("chart.png · 200×100"));
    const metadataRow = lineAnchors.findIndex(anchor => anchor.segment === "assistant_metadata");
    expect(textRow).toBeLessThan(imageRows[0]);
    expect(captionRow).toBe(imageRows.at(-1)! + 1);
    expect(metadataRow).toBeGreaterThan(captionRow);
    // Rows are contiguous and numbered from the top of the image.
    expect(imageRows.map(index => lineAnchors[index].image!.row)).toEqual(imageRows.map((_, row) => row));
  });

  test("pasted images render under the user bubble, right-aligned", async () => {
    await readyImage();
    const state = createInitialState();
    state.convId = "conv";
    state.messages = [{ role: "user", text: "look", images: [{ mediaType: "image/png", base64: "", sizeBytes: 1000, imageId: source.imageId, width: 200, height: 100 }], metadata: null }];
    const { lineAnchors } = buildMessageLines(state, 80);
    const image = lineAnchors.find(anchor => anchor.image)?.image;
    expect(image?.layout.col).toBe(80 - 2 - image!.layout.cols);
    expect(lineAnchors.find(anchor => anchor.image)?.segment).toBe("user_image");
  });
});
