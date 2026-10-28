import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";
import { configureInlineImages, inlineImagesInternalsForTest, setInlineImageCellSize, setInlineImageMode, type InlineImageTarget } from "./inlineimages";
import { handleImageModalKey, renderImageModal } from "./imagemodal";
import { handleFocusedKey } from "./focus";
import { handleMouseEvent } from "./mouse";
import { disposeHistoryImages, invalidateHistoryImagePlacements } from "./historyimages";
import { buildMessageLines } from "./conversation";
import { stripAnsi } from "./historycursor";
import { cancelEditMessage, confirmEditMessage, handleEditMessageKey, openEditMessageModal } from "./editmessage";
import { computeEditMessageOverlayLayout } from "./editmessage-layout";
import { renderQueuePromptOverlay } from "./overlays";
import { steersInstantly } from "./queue";
import { renderSidebarActionMenu, sidebarActionMenuAnchorRow, SIDEBAR_WIDTH } from "./sidebar";
import { openSelectedSidebarActionMenu } from "./sidebar/actionmenu";
import { SmoothScroller, markScrollIntent, setSmoothScroller } from "./smoothscroll";
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

const placements = (out: string) => [...out.matchAll(/\x1b\[(\d+);(\d+)H\x1b_G(a=p[^;]*);/g)].map(match => ({ row: Number(match[1]), col: Number(match[2]), controls: match[3] }));

function imageState(): RenderState {
  const state = createInitialState();
  state.cols = 100;
  state.rows = 40;
  state.convId = "conv";
  const ref = { id: "e".repeat(64), mediaType: "image/png" as const, width: 400, height: 200, sizeBytes: 5000, name: "chart.png" };
  state.messages = [
    // Two prompt rows: the folded attach call leaves none, and the positions below count from here.
    { role: "user", text: "plot it\nas a bar chart", metadata: null },
    {
      role: "assistant",
      blocks: [
        { type: "tool_call", toolCallId: "c1", toolName: "attach", input: { paths: ["chart.png"] }, summary: "chart.png" },
        { type: "tool_result", toolCallId: "c1", toolName: "attach", output: "Attached 1 image", isError: false, images: [ref] },
        { type: "text", text: "Here is the chart." },
      ],
      metadata: { startedAt: 1, endedAt: 2, model: "gpt-5.5", tokens: 10 },
    },
    ...Array.from({ length: 60 }, (_, i) => ({ role: "system" as const, text: `filler ${i}`, metadata: null })),
  ];
  return state;
}

async function readyFrame(state: RenderState): Promise<string> {
  capture(state);
  await Bun.sleep(0);
  return capture(state);
}

beforeEach(() => inlineImagesInternalsForTest.reset());
afterEach(() => inlineImagesInternalsForTest.reset());

/** Scroll so the image's top sits on viewport row 5. */
function showImage(state: RenderState): void {
  capture(state);
  state.scrollOffset = state.layout.totalLines - state.layout.messageAreaHeight
    - state.historyLineAnchors.findIndex(anchor => anchor.images) + 5;
}

const pngFetch = async (request: { width: number; height: number; format: string }) => request.format === "png"
  ? { format: "png" as const, width: Math.min(400, request.width), height: Math.min(200, Math.round(Math.min(400, request.width) / 2)), base64: "UE5H" }
  : { format: "rgba" as const, width: request.width, height: request.height, base64: Buffer.alloc(request.width * request.height * 4, 128).toString("base64") };

describe("image viewer", () => {
  test("Enter on a thumbnail opens a centered viewer over it; closing restores the thumbnail", async () => {
    const requests: Array<{ width: number; height: number; format: string }> = [];
    configureInlineImages({ fetch: async request => { requests.push(request); return pngFetch(request); }, onChange: () => {} });
    setInlineImageMode("kitty");
    setInlineImageCellSize({ width: 8, height: 16 });
    const state = imageState();
    showImage(state);
    await readyFrame(state);

    // Focus history and put the cursor on the thumbnail.
    state.panelFocus = "chat";
    state.chatFocus = "history";
    state.historyCursor = { row: state.historyLineAnchors.findIndex(anchor => anchor.images) + 2, col: 4 };
    const tinted = capture(state);
    expect(tinted).toMatch(/a=p[^;]*,V=1,/);
    const [thumbnail] = placements(tinted);
    expect(thumbnail).toMatchObject({ row: 8, col: 3 });
    expect(thumbnail.controls).toContain("c=48,r=12,");

    const result = handleFocusedKey({ type: "enter" }, state);
    expect(result).toMatchObject({ type: "open_image", target: { images: [{ imageId: "e".repeat(64) }], index: 0 } });
    const { target } = result as { target: InlineImageTarget };
    state.imageModal = { images: target.images, index: target.index };
    const opening = capture(state);
    await Bun.sleep(0);
    const open = capture(state);
    expect(opening + open).toContain("chart.png · 400×200 · 5 KB");
    expect(opening + open).not.toContain("Esc to close");
    // The viewer asked for a bigger preview than the thumbnail, bounded by the screen.
    expect(Math.max(...requests.map(request => request.width))).toBeGreaterThan(requests[0].width);
    // The thumbnail is not deleted: it keeps what lies outside the box (rows
    // 13–28, columns 24–77) as a band above it and a strip to its left, still
    // tinted, so the cursor-line highlight behind it stays hidden as before.
    expect(opening).not.toContain("a=d,");
    const kept = placements(opening).filter(placement => !placement.controls.includes(",z=2,"));
    expect(kept).toHaveLength(2);
    // Until its own preview arrives, the viewer stretches the thumbnail the terminal already holds.
    const placeholder = placements(opening).filter(placement => placement.controls.includes(",z=2,"));
    expect(placeholder).toHaveLength(1);
    expect(placeholder[0].controls).toContain(`i=${/i=(\d+)/.exec(thumbnail.controls)![1]},`);
    expect(opening).not.toContain("a=t,");
    expect(kept.every(placement => placement.controls.includes(",V=1,"))).toBe(true);
    expect(kept[0]).toMatchObject({ row: 8, col: 3 });
    expect(kept[0].controls).toContain(`p=${/p=(\d+)/.exec(thumbnail.controls)![1]},c=48,r=5,x=0,y=0,w=384,h=80,`);
    expect(kept[1]).toMatchObject({ row: 13, col: 3 });
    expect(kept[1].controls).toContain("c=21,r=7,x=0,y=80,w=168,h=112,");
    const [viewer] = placements(open);
    expect(placements(open)).toHaveLength(1);
    expect(viewer).toMatchObject({ row: 15, col: 26 });
    expect(viewer.controls).toContain("c=50,");
    expect(viewer.controls).toContain(",z=2,");

    state.imageModal = null;
    const closed = capture(state);
    expect(closed).toMatch(new RegExp(`a=d,d=i,i=\\d+,p=${/p=(\d+)/.exec(viewer.controls)![1]},`));
    expect(closed).toMatch(new RegExp(`a=d,d=i,i=\\d+,p=${/p=(\d+)/.exec(kept[1].controls)![1]},`));
    const restored = placements(closed);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ row: 8, col: 3 });
    expect(restored[0].controls).toContain("c=48,r=12,C=1,z=1,V=1,");
    expect(placements(capture(state))).toHaveLength(0);
    expect(closed).not.toContain("chart.png · 400×200 · 5 KB");
    disposeHistoryImages(state);
  });

  test("thumbnails outside the viewer stay placed untouched while it is open", async () => {
    configureInlineImages({ fetch: async request => pngFetch(request), onChange: () => {} });
    setInlineImageMode("kitty");
    setInlineImageCellSize({ width: 8, height: 16 });
    const state = imageState();
    showImage(state);
    state.scrollOffset -= 5;
    const [thumbnail] = placements(await readyFrame(state));
    expect(thumbnail).toMatchObject({ row: 3, col: 3 });
    // A wide 400×40 image gets a short viewer box (rows 17–23) below the thumbnail (rows 3–14).
    state.imageModal = { images: [{ imageId: "f".repeat(64), width: 400, height: 40, mediaType: "image/png", sizeBytes: 900 }], index: 0 };
    const opening = capture(state);
    await Bun.sleep(0);
    const open = capture(state);
    expect(opening + open).not.toContain("a=d,");
    expect(placements(opening)).toHaveLength(0);
    expect(placements(open).every(placement => placement.controls.includes(",z=2,"))).toBe(true);
    state.imageModal = null;
    const closed = capture(state);
    expect(placements(closed)).toHaveLength(0);
    expect(closed.match(/a=d,/g)).toHaveLength(1);
    disposeHistoryImages(state);
  });

  test("while smooth scrolling (st mode 2032) an image cut off at the bottom keeps its rows below only during a glide", async () => {
    configureInlineImages({ fetch: async request => pngFetch(request), onChange: () => {} });
    setInlineImageMode("kitty");
    setInlineImageCellSize({ width: 8, height: 16 });
    const state = imageState();
    state.rows = 14;	// a short pane, so the image can sit at its bottom
    capture(state);
    const imageLine = state.historyLineAnchors.findIndex(anchor => anchor.images);
    // Only the image's top rows are on the pane's last rows.
    state.scrollOffset = Math.min(state.layout.totalLines - imageLine - 1, state.layout.totalLines - state.layout.messageAreaHeight);
    const [plain] = placements(await readyFrame(state));
    expect(plain.controls).toContain(",h=");
    let now = 1000;
    const smooth = new SmoothScroller(100, () => now);
    setSmoothScroller(state, smooth);
    invalidateFrame(state);
    invalidateHistoryImagePlacements(state);
    // At rest: cropped exactly as without smooth scrolling.
    const [rest] = placements(capture(state));
    expect(rest.controls).toBe(plain.controls);
    // Gliding: the rows below the pane come along (st clips them).
    markScrollIntent(state);
    state.scrollOffset -= 1;
    const step = capture(state);
    now += 8;
    const rowsOf = (controls: string) => Number(/,r=(\d+),/.exec(controls)![1]);
    const gliding = placements(step + capture(state));
    expect(gliding.length).toBeGreaterThan(0);
    expect(gliding[0].controls).not.toContain(",h=");
    expect(rowsOf(gliding[0].controls)).toBeGreaterThan(rowsOf(plain.controls));
    // At rest again: placed exactly as without smooth scrolling.
    now += 200;
    const after = placements(capture(state));
    const settled = (after.length > 0 ? after : gliding).at(-1)!;
    setSmoothScroller(state, null);
    invalidateFrame(state);
    invalidateHistoryImagePlacements(state);
    const [expected] = placements(capture(state));
    expect(settled.controls).toBe(expected.controls);
    disposeHistoryImages(state);
  });

  test("with st's image clip regions (mode 2033) the pane is declared and an image cut off at the bottom stays whole, at rest too", async () => {
    configureInlineImages({ fetch: async request => pngFetch(request), onChange: () => {} });
    setInlineImageMode("kitty");
    setInlineImageCellSize({ width: 8, height: 16 });
    const state = imageState();
    state.rows = 14;
    capture(state);
    const imageLine = state.historyLineAnchors.findIndex(anchor => anchor.images);
    state.scrollOffset = Math.min(state.layout.totalLines - imageLine - 1, state.layout.totalLines - state.layout.messageAreaHeight);
    const [plain] = placements(await readyFrame(state));
    expect(plain.controls).toContain(",h=");
    const now = 1000;
    const smooth = new SmoothScroller(100, () => now);
    smooth.useImageClip(true);
    setSmoothScroller(state, smooth);
    invalidateFrame(state);
    invalidateHistoryImagePlacements(state);
    const out = capture(state);
    // The conversation pane is the clip region.
    const clip = /\x1b\]2032;k;(\d+),(\d+),(\d+),(\d+)\x1b\\/.exec(out)!.slice(1).map(Number);
    expect(clip[1]).toBe(state.layout.chatCol);
    expect(clip[3]).toBe(state.layout.chatCol + state.layout.chatWidth - 1);
    expect(clip[2] - clip[0] + 1).toBe(state.layout.messageAreaHeight);
    // At rest the image is placed whole past the pane: st clips it there.
    const rowsOf = (controls: string) => Number(/,r=(\d+),/.exec(controls)![1]);
    const [rest] = placements(out);
    expect(rest.controls).not.toContain(",h=");
    expect(rowsOf(rest.controls)).toBeGreaterThan(rowsOf(plain.controls));
    expect(rest.row + rowsOf(rest.controls) - 1).toBeGreaterThan(clip[2]);
    // The image viewer opening clears the clip regions (its image sits in the pane).
    state.imageModal = { images: [{ id: "e".repeat(64), mediaType: "image/png", width: 400, height: 200, sizeBytes: 5000, name: "chart.png" }], index: 0 } as unknown as RenderState["imageModal"];
    const viewer = capture(state);
    expect(viewer).toContain("\x1b]2032;k\x1b\\");
    state.imageModal = null;
    setSmoothScroller(state, null);
    disposeHistoryImages(state);
  });

  test("the task panel crops a thumbnail around itself instead of dropping the rows it overlaps", async () => {
    configureInlineImages({ fetch: async request => pngFetch(request), onChange: () => {} });
    setInlineImageMode("kitty");
    setInlineImageCellSize({ width: 8, height: 16 });
    const state = imageState();
    state.cols = 80;
    state.sidebar.conversations = [{
      id: "conv", provider: state.provider, model: state.model, effort: state.effort, fastMode: state.fastMode,
      createdAt: 1, updatedAt: 2, messageCount: 1, title: "Conv", marked: false, pinned: false, streaming: false, unread: false, sortOrder: 0,
      tasks: [{ id: "child", kind: "subagent", title: "A subagent with a fairly long title", startedAt: Date.now() - 2_000 }],
    }];
    showImage(state);
    state.scrollOffset -= 5;
    const shown = placements(await readyFrame(state));
    const panel = state.layout.taskPanelRect!;
    expect(panel).not.toBeNull();
    const pieces = shown.map(placement => ({
      ...placement,
      columns: Number(/c=(\d+)/.exec(placement.controls)![1]),
      rows: Number(/r=(\d+)/.exec(placement.controls)![1]),
    }));
    // The thumbnail starts on the panel's rows and reaches under it.
    expect(pieces[0].row).toBeLessThanOrEqual(panel.bottom);
    expect(pieces[0].col + pieces[0].columns - 1).toBeLessThan(panel.left);
    for (const piece of pieces) {
      const overlaps = piece.row <= panel.bottom && piece.row + piece.rows - 1 >= panel.top
        && piece.col <= panel.right && piece.col + piece.columns - 1 >= panel.left;
      expect(overlaps).toBe(false);
    }
    // Its rows beside the panel are kept, not dropped with the part under it.
    expect(pieces.reduce((rows, piece) => Math.max(rows, piece.row + piece.rows), 0) - Math.min(...pieces.map(piece => piece.row))).toBe(12);
    disposeHistoryImages(state);
  });

  /** A user message with one pasted image, the Tasks panel open, and the image's top on the panel's rows. */
  function userImageBesidePanel(mode: "kitty" | "halfblock"): RenderState {
    configureInlineImages({ fetch: async request => pngFetch(request), onChange: () => {} });
    setInlineImageMode(mode);
    setInlineImageCellSize({ width: 8, height: 16 });
    const state = imageState();
    state.cols = 120;
    state.messages = [
      { role: "user", text: "two screenshots", images: [{ mediaType: "image/png", base64: "", sizeBytes: 5000, imageId: "e".repeat(64), width: 400, height: 200 }], metadata: null },
      ...state.messages.slice(2),
    ];
    state.sidebar.conversations = [{
      id: "conv", provider: state.provider, model: state.model, effort: state.effort, fastMode: state.fastMode,
      createdAt: 1, updatedAt: 2, messageCount: 1, title: "Conv", marked: false, pinned: false, streaming: false, unread: false, sortOrder: 0,
      tasks: [{ id: "child", kind: "subagent", title: "A subagent with a fairly long title", startedAt: Date.now() - 2_000 }],
    }];
    capture(state);
    const firstImageRow = state.historyLineAnchors.findIndex(anchor => anchor.images);
    state.scrollOffset = state.layout.totalLines - state.layout.messageAreaHeight - firstImageRow + 1;
    return state;
  }

  test("a user image shifted left beside the task panel is drawn whole, its rows below the panel too", async () => {
    const state = userImageBesidePanel("kitty");
    const shown = placements(await readyFrame(state)).map(placement => ({
      ...placement,
      columns: Number(/c=(\d+)/.exec(placement.controls)![1]),
      rows: Number(/r=(\d+)/.exec(placement.controls)![1]),
    }));
    const panel = state.layout.taskPanelRect!;
    const layout = state.historyLineAnchors.find(anchor => anchor.images)!.images![0].layout;
    expect(shown.length).toBe(1);
    const [image] = shown;
    // It starts on the panel's rows, reaches below them, and clears the panel.
    expect(image.row).toBeLessThanOrEqual(panel.bottom);
    expect(image.row + image.rows - 1).toBeGreaterThan(panel.bottom + 1);
    expect(image.col + image.columns - 1).toBeLessThan(panel.left);
    // Every row of it, not only the ones beside the panel.
    expect(image.rows).toBe(layout.rows);
    expect(image.controls).not.toContain(",h=");
    disposeHistoryImages(state);
  });

  test("the half-block fallback keeps a user image's rows aligned beside and below the task panel", async () => {
    const state = userImageBesidePanel("halfblock");
    await readyFrame(state);
    const rows = state.historyLineAnchors.flatMap((anchor, index) => anchor.images ? [index] : []);
    const viewport = state.layout.historyViewportRows.filter(row => row && rows.includes(row.lineIndex));
    const panel = state.layout.taskPanelRect!;
    expect(viewport.length).toBe(rows.length);
    // History starts on screen row 3.
    expect(3 + state.layout.historyViewportRows.indexOf(viewport.at(-1)!)).toBeGreaterThan(panel.bottom + 1);
    expect(viewport[0]!.startCol).toBeGreaterThan(0);
    expect(new Set(viewport.map(row => row!.startCol)).size).toBe(1);
  });

  test("the fallback viewer draws half-block pixels inside the box", async () => {
    configureInlineImages({ fetch: pngFetch, onChange: () => {} });
    setInlineImageMode("halfblock");
    const state = imageState();
    state.imageModal = { images: [{ imageId: "e".repeat(64), width: 400, height: 200, mediaType: "image/png", sizeBytes: 5000 }], index: 0 };
    const loading = capture(state);
    await Bun.sleep(0);
    const out = loading + capture(state);
    expect(out).toContain("▀".repeat(40));
    expect(out).toContain("PNG · 400×200 · 5 KB");
    expect(out).not.toContain("Esc to close");
    expect(out).not.toContain("\x1b_G");
  });

  test("a click on a thumbnail (press and release on the same cell) opens it; Enter on its bottom row too", async () => {
    configureInlineImages({ fetch: pngFetch, onChange: () => {} });
    setInlineImageMode("kitty");
    const state = imageState();
    showImage(state);
    const [thumb] = placements(await readyFrame(state));
    const press = handleMouseEvent({ type: "mouse", button: 0, action: "press", shift: false, meta: false, ctrl: false, col: thumb.col + 3, row: thumb.row + 2 }, state);
    expect(press).toEqual({ type: "handled" });
    const release = handleMouseEvent({ type: "mouse", button: 0, action: "release", shift: false, meta: false, ctrl: false, col: thumb.col + 3, row: thumb.row + 2 }, state);
    expect(release).toMatchObject({ type: "open_image", target: { images: [{ name: "chart.png" }], index: 0 } });
    expect(state.vim.mode).toBe("normal");

    // A drag is a selection, not an open.
    handleMouseEvent({ type: "mouse", button: 0, action: "press", shift: false, meta: false, ctrl: false, col: thumb.col + 3, row: thumb.row + 2 }, state);
    handleMouseEvent({ type: "mouse", button: 0, action: "motion", shift: false, meta: false, ctrl: false, col: thumb.col + 3, row: thumb.row + 5 }, state);
    expect(handleMouseEvent({ type: "mouse", button: 0, action: "release", shift: false, meta: false, ctrl: false, col: thumb.col + 3, row: thumb.row + 5 }, state).type).not.toBe("open_image");

    state.vim.mode = "normal";
    state.panelFocus = "chat";
    state.chatFocus = "history";
    expect(state.historyLines.some(line => line.includes("400×200"))).toBe(false);
    const bottom = state.historyLineAnchors.findLastIndex(anchor => anchor.images);
    state.historyCursor = { row: bottom, col: 2 };
    expect(handleFocusedKey({ type: "enter" }, state)).toMatchObject({ type: "open_image" });
    disposeHistoryImages(state);
  });

  test("Enter, Esc, and q close the viewer; other keys are swallowed", () => {
    expect(handleImageModalKey({ type: "enter" })).toBe("close");
    expect(handleImageModalKey({ type: "escape" })).toBe("close");
    expect(handleImageModalKey({ type: "char", char: "q" })).toBe("close");
    expect(handleImageModalKey({ type: "char", char: "j" })).toBe("handled");
  });

  test("a tiny terminal gets a notice instead of a broken box", () => {
    const rendered = renderImageModal({ images: [{ imageId: "e".repeat(64), width: 400, height: 200, mediaType: "image/png", sizeBytes: 5000 }], index: 0 }, 5, 8, { width: 8, height: 16 }, "kitty");
    expect(rendered.placement).toBeNull();
    expect(rendered.payload).toContain("Image");
  });
});

describe("render with Kitty images", () => {
  test("transmits and places a visible image, crops it when scrolled, deletes it when gone", async () => {
    configureInlineImages({
      fetch: async request => ({ format: "png", width: request.width, height: Math.round(request.width / 2), base64: "UE5H" }),
      onChange: () => {},
    });
    setInlineImageMode("kitty");
    const state = imageState();
    // Put the image's top on viewport row 5 (screen row 8).
    capture(state);
    const offsetFor = (viewportRow: number) => {
      const imageLine = state.historyLineAnchors.findIndex(anchor => anchor.images);
      return state.layout.totalLines - state.layout.messageAreaHeight - (imageLine - viewportRow);
    };
    state.scrollOffset = offsetFor(5);
    const first = await readyFrame(state);
    expect(first).toContain("a=t,t=d,f=100");
    const [whole] = placements(first);
    expect(whole).toMatchObject({ row: 8 });
    expect(whole.controls).not.toContain("y=");
    // The region scrolls, and the image is placed again where it now belongs.
    state.scrollOffset = offsetFor(3);
    const scrolled = capture(state);
    expect(scrolled).toMatch(/\x1b\[3;\d+r\x1b\[2S\x1b\[r/);
    const [moved] = placements(scrolled);
    expect(moved.row).toBe(6);
    expect(scrolled).not.toContain("a=t,t=d");

    // Half out of the top: the source is cropped to the visible rows.
    state.scrollOffset = offsetFor(-4);
    const [cropped] = placements(capture(state));
    expect(cropped).toMatchObject({ row: 3 });
    expect(cropped.controls).toMatch(/,x=0,y=\d+,w=\d+,h=\d+,/);

    // Fully gone: deleted.
    state.scrollOffset = offsetFor(-40);
    const gone = capture(state);
    expect(gone).toContain("a=d,d=i");
    expect(placements(gone)).toEqual([]);

    // Switching conversations removes it.
    state.scrollOffset = offsetFor(5);
    expect(placements(capture(state)).length).toBe(1);
    state.convId = "other";
    state.messages = [{ role: "user", text: "different conversation", metadata: null }];
    const away = capture(state);
    expect(away).toContain("a=d,d=i");
    expect(placements(away)).toEqual([]);
    disposeHistoryImages(state);
  });

  const parsed = (out: string) => placements(out).map(placement => ({
    ...placement,
    id: Number(/p=(\d+)/.exec(placement.controls)![1]),
    columns: Number(/c=(\d+)/.exec(placement.controls)![1]),
    rows: Number(/r=(\d+)/.exec(placement.controls)![1]),
  }));
  const deleted = (out: string) => [...out.matchAll(/a=d,d=i,i=\d+,p=(\d+),/g)].map(match => Number(match[1]));

  async function setup(imageTopRow: (state: RenderState) => number) {
    configureInlineImages({ fetch: async request => pngFetch(request), onChange: () => {} });
    setInlineImageMode("kitty");
    setInlineImageCellSize({ width: 8, height: 16 });
    const state = imageState();
    // A tall first message, so the image below it can be scrolled down to the menu.
    state.messages[0] = { role: "user", text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"), metadata: null };
    state.messages.push(
      { role: "user", text: "second question", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "second answer" }], metadata: { startedAt: 3, endedAt: 4, model: "gpt-5.5", tokens: 1 } },
    );
    capture(state);
    const imageLine = state.historyLineAnchors.findIndex(anchor => anchor.images);
    const viewportRow = imageTopRow(state) - 3; // messageAreaStart is row 3
    state.scrollOffset = state.layout.totalLines - state.layout.messageAreaHeight - (imageLine - viewportRow);
    // The preview may already be cached from an earlier setup: then the first frame places it.
    const first = capture(state);
    await Bun.sleep(0);
    const [whole] = parsed(first + capture(state));
    expect(whole).toMatchObject({ row: imageTopRow(state), columns: 48 });
    return { state, whole };
  }

  describe("the edit menu (Ctrl-W)", () => {
    function editMenuBox(state: RenderState) {
      const layout = computeEditMessageOverlayLayout(
        state.editMessagePrompt!,
        state.cols - state.layout.chatCol + 1,
        state.layout.chatCol,
        state.layout.sepAbove,
        state.layout.messageAreaHeight,
      )!;
      return { top: layout.boxTop, bottom: layout.boxBottom, left: layout.boxLeft, right: layout.boxLeft + layout.boxWidth - 1 };
    }

    test("leaves thumbnails it does not cover in place, untouched", async () => {
      const { state, whole } = await setup(() => 8);
      expect(whole.rows).toBe(12);
      openEditMessageModal(state);
      const open = capture(state);
      expect(open).toContain("Edit message:");
      const box = editMenuBox(state);
      expect(box.top).toBeGreaterThan(whole.row + whole.rows - 1);
      // Nothing to re-send: the placement stays exactly where it was.
      expect(open).not.toContain("\x1b_G");
      handleEditMessageKey({ type: "char", char: "k" } as never, state);
      expect(capture(state)).not.toContain("\x1b_G");
      cancelEditMessage(state);
      const closed = capture(state);
      expect(closed).not.toContain("Edit message:");
      expect(closed).not.toContain("\x1b_G");
      disposeHistoryImages(state);
    });

    test("crops a thumbnail around its box, then restores it whole on cancel or confirm", async () => {
      // Put the thumbnail's top three rows above the box so the box covers its lower right part.
      const probe = await setup(() => 8);
      openEditMessageModal(probe.state);
      capture(probe.state);
      const boxTop = editMenuBox(probe.state).top;
      disposeHistoryImages(probe.state);

      for (const close of ["cancel", "confirm"] as const) {
        // (The viewport also cuts off its bottom rows, so `whole` is the pre-menu placement.)
        const { state, whole } = await setup(() => boxTop - 3);
        openEditMessageModal(state);
        const open = capture(state);
        const box = editMenuBox(state);
        expect(box.top).toBe(boxTop);
        expect(box.left).toBeGreaterThan(whole.col);
        expect(box.left).toBeLessThanOrEqual(whole.col + whole.columns - 1);
        const pieces = parsed(open);
        // A band above the box (the original placement, cropped) and the strip left of it.
        expect(pieces).toHaveLength(2);
        expect(pieces[0]).toMatchObject({ id: whole.id, row: whole.row, col: whole.col, columns: 48, rows: 3 });
        expect(pieces[0].controls).toContain("x=0,y=0,w=384,h=48,");
        expect(pieces[1]).toMatchObject({ row: box.top, col: whole.col, columns: box.left - whole.col });
        expect(pieces[1].id).not.toBe(whole.id);
        for (const piece of pieces) {
          const overlaps = piece.row <= box.bottom && piece.row + piece.rows - 1 >= box.top
            && piece.col <= box.right && piece.col + piece.columns - 1 >= box.left;
          expect(overlaps).toBe(false);
        }
        expect(deleted(open)).toEqual([]);

        // Moving the selection repaints the menu, not the images.
        handleEditMessageKey({ type: "char", char: "k" } as never, state);
        expect(capture(state)).not.toContain("\x1b_G");
        handleEditMessageKey({ type: "char", char: "j" } as never, state);
        expect(capture(state)).not.toContain("\x1b_G");

        if (close === "cancel") cancelEditMessage(state);
        else expect(confirmEditMessage(state)).toMatchObject({ action: "edit_sent", text: "second question" });
        const closed = capture(state);
        expect(closed).not.toContain("Edit message:");
        expect(deleted(closed)).toEqual([pieces[1].id]);
        expect(parsed(closed)).toEqual([expect.objectContaining({ id: whole.id, row: whole.row, col: whole.col, controls: whole.controls })]);
        expect(capture(state)).not.toContain("\x1b_G");
        disposeHistoryImages(state);
      }
    });
  });

  describe("the queue prompt", () => {
    function queueBox(state: RenderState) {
      return renderQueuePromptOverlay(
        state.queuePrompt!,
        state.cols - state.layout.chatCol + 1,
        state.layout.chatCol,
        state.layout.sepAbove,
        steersInstantly(state.provider),
      ).rect;
    }
    const openQueue = (state: RenderState) => { state.queuePrompt = { text: "queued", images: [], selection: "next-turn" } as never; };

    test("leaves thumbnails it does not cover in place, untouched", async () => {
      const { state, whole } = await setup(() => 8);
      openQueue(state);
      const open = capture(state);
      expect(open).toContain("Queue message:");
      expect(queueBox(state).top).toBeGreaterThan(whole.row + whole.rows - 1);
      expect(open).not.toContain("\x1b_G");
      state.queuePrompt = null;
      expect(capture(state)).not.toContain("\x1b_G");
      disposeHistoryImages(state);
    });

    test("crops a thumbnail around its box, then restores it whole when it closes", async () => {
      const probe = await setup(() => 8);
      openQueue(probe.state);
      capture(probe.state);
      const boxTop = queueBox(probe.state).top;
      disposeHistoryImages(probe.state);

      const { state, whole } = await setup(() => boxTop - 3);
      openQueue(state);
      const open = capture(state);
      const box = queueBox(state);
      expect(box.top).toBe(boxTop);
      expect(box.left).toBeGreaterThan(whole.col);
      const pieces = parsed(open);
      expect(pieces).toHaveLength(2);
      expect(pieces[0]).toMatchObject({ id: whole.id, row: whole.row, col: whole.col, columns: 48, rows: 3 });
      expect(pieces[1]).toMatchObject({ row: box.top, col: whole.col, columns: box.left - whole.col });
      for (const piece of pieces) {
        const overlaps = piece.row <= box.bottom && piece.row + piece.rows - 1 >= box.top
          && piece.col <= box.right && piece.col + piece.columns - 1 >= box.left;
        expect(overlaps).toBe(false);
      }
      expect(deleted(open)).toEqual([]);

      // Moving the selection repaints the prompt, not the images.
      (state.queuePrompt as { selection: string }).selection = "message-end";
      expect(capture(state)).not.toContain("\x1b_G");

      state.queuePrompt = null;
      const closed = capture(state);
      expect(closed).not.toContain("Queue message:");
      expect(deleted(closed)).toEqual([pieces[1].id]);
      expect(parsed(closed)).toEqual([expect.objectContaining({ id: whole.id, row: whole.row, col: whole.col, controls: whole.controls })]);
      expect(capture(state)).not.toContain("\x1b_G");
      disposeHistoryImages(state);
    });
  });

  describe("the sidebar conversation menu", () => {
    function menuBox(state: RenderState) {
      const menu = state.sidebar.actionMenu!;
      return renderSidebarActionMenu(
        menu,
        sidebarActionMenuAnchorRow(state.sidebar, menu.item),
        SIDEBAR_WIDTH + 1,
        state.rows,
        state.cols,
      ).rect!;
    }
    function openMenu(state: RenderState) {
      state.sidebar.open = true;
      state.sidebar.conversations = [{ id: "conv", title: "A conversation", marked: false, pinned: false }] as never;
      state.sidebar.selectedItem = { type: "conversation", id: "conv" } as never;
      openSelectedSidebarActionMenu(state.sidebar);
    }

    test("crops a thumbnail around its box, then restores it whole when it closes", async () => {
      const { state, whole } = await setup(() => 5);
      state.sidebar.open = true; // the sidebar shifts the chat column, which moves the image
      const shifted = parsed(capture(state));
      expect(shifted).toHaveLength(1);
      expect(shifted[0].col).toBeGreaterThan(whole.col);
      openMenu(state);
      const open = capture(state);
      expect(stripAnsi(open)).toContain("Copy id");
      const box = menuBox(state);
      const image = shifted[0];
      expect(box.left).toBeLessThanOrEqual(image.col + image.columns - 1);
      expect(box.right).toBeGreaterThanOrEqual(image.col);
      expect(box.bottom).toBeGreaterThanOrEqual(image.row);
      expect(box.top).toBeLessThanOrEqual(image.row + image.rows - 1);
      const pieces = parsed(open);
      expect(pieces.length).toBeGreaterThanOrEqual(2);
      for (const piece of pieces) {
        const overlaps = piece.row <= box.bottom && piece.row + piece.rows - 1 >= box.top
          && piece.col <= box.right && piece.col + piece.columns - 1 >= box.left;
        expect(overlaps).toBe(false);
      }
      expect(deleted(open)).toEqual([]);
      expect(capture(state)).not.toContain("\x1b_G");

      state.sidebar.actionMenu = null;
      const closed = capture(state);
      expect(stripAnsi(closed)).not.toContain("Copy id");
      expect(deleted(closed)).toEqual(pieces.slice(1).map(piece => piece.id).sort((a, b) => a - b));
      expect(parsed(closed)).toEqual([expect.objectContaining({ id: image.id, row: image.row, col: image.col, controls: image.controls })]);
      disposeHistoryImages(state);
    });
  });

  test("the half-block fallback draws pixels as text and sends no graphics", async () => {
    configureInlineImages({
      fetch: async request => ({ format: "rgba", width: request.width, height: request.height, base64: Buffer.alloc(request.width * request.height * 4, 128).toString("base64") }),
      onChange: () => {},
    });
    setInlineImageMode("halfblock");
    const state = imageState();
    showImage(state);
    const out = await readyFrame(state);
    expect(out).toContain("▀▀▀▀");
    expect(out).not.toContain("\x1b_G");
  });
});

describe("a just-sent pasted image", () => {
  // 400×200 PNG header: enough for sizing; the terminal gets these bytes as is.
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000190000000c80806000000", "hex").toString("base64");

  /** The TUI's local echo of a message with a paste: bytes, but no daemon id or size yet. */
  function sentState(): RenderState {
    const state = createInitialState();
    state.cols = 100;
    state.rows = 40;
    state.convId = "conv";
    state.messages = [{ role: "user", text: "look at this", images: [{ mediaType: "image/png", base64: png, sizeBytes: 101_000 }], metadata: null }];
    return state;
  }

  test("Kitty terminals draw it from the local bytes on the first frame, without asking the daemon", () => {
    let fetches = 0;
    configureInlineImages({ fetch: async () => { fetches++; throw new Error("get_image: image not found"); }, onChange: () => {} });
    setInlineImageMode("kitty");
    const state = sentState();
    const out = capture(state);
    expect(out).toContain(`a=t,t=d,f=100`);
    expect(out).toContain(png);
    expect(placements(out).length).toBe(1);
    expect(out).not.toContain("image unavailable");
    expect(fetches).toBe(0);
    disposeHistoryImages(state);
  });

  test("a fetch that races the daemon storing the message shows loading, then the image", async () => {
    // The half-block fallback needs a daemon preview; the first one arrives
    // before the daemon has stored the message.
    let fetches = 0;
    let changes = 0;
    configureInlineImages({
      fetch: async request => {
        if (++fetches === 1) throw new Error("get_image: image not found");
        return { format: "rgba", width: request.width, height: request.height, base64: Buffer.alloc(request.width * request.height * 4, 128).toString("base64") };
      },
      onChange: () => { changes++; },
    });
    setInlineImageMode("halfblock");
    const state = sentState();
    const history = () => stripAnsi(buildMessageLines(state, 96).lines.join("\n"));
    expect(history()).toContain("loading image…");
    await Bun.sleep(0);
    expect(fetches).toBe(1);
    expect(history()).toContain("loading image…");
    expect(history()).not.toContain("image unavailable");

    // The retry needs no user action: it fires on its own and asks for a frame.
    const changesBefore = changes;
    await Bun.sleep(400);
    expect(fetches).toBe(2);
    expect(changes).toBeGreaterThan(changesBefore);
    expect(history()).toContain("▀▀▀▀");
    expect(history()).not.toContain("loading image…");
  });
});
