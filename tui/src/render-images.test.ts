import { afterEach, describe, expect, test } from "bun:test";
import { render } from "./render";
import { createInitialState, type RenderState } from "./state";
import { configureInlineImages, inlineImagesInternalsForTest, setInlineImageCellSize, setInlineImageMode, type InlineImageSource } from "./inlineimages";
import { handleImageModalKey, renderImageModal } from "./imagemodal";
import { handleFocusedKey } from "./focus";
import { handleMouseEvent } from "./mouse";
import { disposeHistoryImages } from "./historyimages";

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
    ...Array.from({ length: 60 }, (_, i) => ({ role: "system" as const, text: `filler ${i}`, metadata: null })),
  ];
  return state;
}

async function readyFrame(state: RenderState): Promise<string> {
  capture(state);
  await Bun.sleep(0);
  return capture(state);
}

afterEach(() => inlineImagesInternalsForTest.reset());

/** Scroll so the image's top sits on viewport row 5. */
function showImage(state: RenderState): void {
  capture(state);
  state.scrollOffset = state.layout.totalLines - state.layout.messageAreaHeight
    - state.historyLineAnchors.findIndex(anchor => anchor.image) + 5;
}

const pngFetch = async (request: { width: number; height: number; format: string }) => request.format === "png"
  ? { format: "png" as const, width: Math.min(400, request.width), height: Math.min(200, Math.round(Math.min(400, request.width) / 2)), base64: "UE5H" }
  : { format: "rgba" as const, width: request.width, height: request.height, base64: Buffer.alloc(request.width * request.height * 4, 128).toString("base64") };

describe("image viewer", () => {
  test("Enter on a thumbnail opens a centered viewer; closing it removes its placement", async () => {
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
    state.historyCursor = { row: state.historyLineAnchors.findIndex(anchor => anchor.image) + 2, col: 4 };
    const tinted = capture(state);
    expect(tinted).toMatch(/a=p[^;]*,V=1,/);

    const result = handleFocusedKey({ type: "enter" }, state);
    expect(result).toMatchObject({ type: "open_image", image: { imageId: "e".repeat(64) } });
    state.imageModal = { source: (result as { image: InlineImageSource }).image };
    const opening = capture(state);
    await Bun.sleep(0);
    const open = capture(state);
    expect(opening + open).toContain("chart.png · 400×200 · 5 KB");
    expect(opening + open).toContain("Enter or Esc to close");
    // The viewer asked for a bigger preview than the thumbnail, bounded by the screen.
    expect(Math.max(...requests.map(request => request.width))).toBeGreaterThan(requests[0].width);
    const shown = placements(open);
    expect(shown).toHaveLength(1);
    // The thumbnail placement made way for the viewer's.
    expect(opening).toContain("a=d,d=i");
    expect(shown[0].controls).toContain("c=50,");

    state.imageModal = null;
    const closed = capture(state);
    expect(closed).toMatch(new RegExp(`a=d,d=i,i=\\d+,p=${/p=(\d+)/.exec(shown[0].controls)![1]},`));
    expect(placements(closed)).toHaveLength(1);
    expect(closed).not.toContain("Enter or Esc to close");
    disposeHistoryImages(state);
  });

  test("the fallback viewer draws half-block pixels inside the box", async () => {
    configureInlineImages({ fetch: pngFetch, onChange: () => {} });
    setInlineImageMode("halfblock");
    const state = imageState();
    state.imageModal = { source: { imageId: "e".repeat(64), width: 400, height: 200, mediaType: "image/png", sizeBytes: 5000 } };
    const loading = capture(state);
    await Bun.sleep(0);
    const out = loading + capture(state);
    expect(out).toContain("▀".repeat(40));
    expect(out).toContain("Enter or Esc to close");
    expect(out).not.toContain("\x1b_G");
  });

  test("a click on a thumbnail (press and release on the same cell) opens it; Enter on its caption too", async () => {
    configureInlineImages({ fetch: pngFetch, onChange: () => {} });
    setInlineImageMode("kitty");
    const state = imageState();
    showImage(state);
    const [thumb] = placements(await readyFrame(state));
    const press = handleMouseEvent({ type: "mouse", button: 0, action: "press", shift: false, meta: false, ctrl: false, col: thumb.col + 3, row: thumb.row + 2 }, state);
    expect(press).toEqual({ type: "handled" });
    const release = handleMouseEvent({ type: "mouse", button: 0, action: "release", shift: false, meta: false, ctrl: false, col: thumb.col + 3, row: thumb.row + 2 }, state);
    expect(release).toMatchObject({ type: "open_image", image: { name: "chart.png" } });
    expect(state.vim.mode).toBe("normal");

    // A drag is a selection, not an open.
    handleMouseEvent({ type: "mouse", button: 0, action: "press", shift: false, meta: false, ctrl: false, col: thumb.col + 3, row: thumb.row + 2 }, state);
    handleMouseEvent({ type: "mouse", button: 0, action: "motion", shift: false, meta: false, ctrl: false, col: thumb.col + 3, row: thumb.row + 5 }, state);
    expect(handleMouseEvent({ type: "mouse", button: 0, action: "release", shift: false, meta: false, ctrl: false, col: thumb.col + 3, row: thumb.row + 5 }, state).type).not.toBe("open_image");

    state.vim.mode = "normal";
    state.panelFocus = "chat";
    state.chatFocus = "history";
    const caption = state.historyLines.findIndex(line => line.includes("chart.png · 400×200"));
    state.historyCursor = { row: caption, col: 2 };
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
    const rendered = renderImageModal({ source: { imageId: "e".repeat(64), width: 400, height: 200, mediaType: "image/png", sizeBytes: 5000 } }, 5, 8, { width: 8, height: 16 }, "kitty");
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
      const imageLine = state.historyLineAnchors.findIndex(anchor => anchor.image);
      return state.layout.totalLines - state.layout.messageAreaHeight - (imageLine - viewportRow);
    };
    state.scrollOffset = offsetFor(5);
    const first = await readyFrame(state);
    expect(first).toContain("a=t,t=d,f=100");
    const [whole] = placements(first);
    expect(whole).toMatchObject({ row: 8 });
    expect(whole.controls).not.toContain("y=");
    // No DECSTBM scroll-region shortcut while images are placed.
    state.scrollOffset = offsetFor(3);
    const scrolled = capture(state);
    expect(scrolled).not.toMatch(/\x1b\[\d+;\d+r/);
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

  test("hides images while a floating overlay is open", async () => {
    configureInlineImages({
      fetch: async request => ({ format: "png", width: request.width, height: Math.round(request.width / 2), base64: "UE5H" }),
      onChange: () => {},
    });
    setInlineImageMode("kitty");
    const state = imageState();
    capture(state);
    state.scrollOffset = state.layout.totalLines - state.layout.messageAreaHeight - state.historyLineAnchors.findIndex(anchor => anchor.image) + 5;
    expect(placements(await readyFrame(state)).length).toBe(1);
    state.queuePrompt = { text: "queued", images: [], selection: "next-turn" } as never;
    expect(capture(state)).toContain("a=d,d=i");
    state.queuePrompt = null;
    expect(placements(capture(state)).length).toBe(1);
    disposeHistoryImages(state);
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
