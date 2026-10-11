import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  configureInlineImages,
  fitImageBox,
  imageCaption,
  inlineImageGeneration,
  inlineImagesInternalsForTest,
  kittyPreview,
  renderHalfBlockRows,
  renderInlineImage,
  setInlineImageCellSize,
  setInlineImageMode,
  setInlineImagesEnabled,
  inlineImagesActive,
  sourceFromAttachment,
  sourceFromRef,
  type ImagePreviewRequest,
  type InlineImageSource,
} from "./inlineimages";
import { stripAnsi } from "./historycursor";

const source: InlineImageSource = { imageId: "a".repeat(64), width: 800, height: 400, mediaType: "image/png", sizeBytes: 90_000, name: "chart.png" };

beforeEach(() => inlineImagesInternalsForTest.reset());
afterEach(() => inlineImagesInternalsForTest.reset());

describe("layout", () => {
  test("fits within the box and keeps the aspect ratio in cells", () => {
    // 800×400 into 40×30 cells of 10×20 px: width bound → 40 cols × 10 rows.
    expect(fitImageBox(source, 40, 30, { width: 10, height: 20 })).toEqual({ cols: 40, rows: 10 });
    // Height bound.
    expect(fitImageBox({ width: 400, height: 800 }, 40, 10, { width: 10, height: 20 })).toEqual({ cols: 10, rows: 10 });
  });

  test("never enlarges small images", () => {
    expect(fitImageBox({ width: 32, height: 32 }, 80, 30, { width: 8, height: 16 })).toEqual({ cols: 4, rows: 2 });
    expect(fitImageBox({ width: 1, height: 1 }, 80, 30, { width: 8, height: 16 })).toEqual({ cols: 1, rows: 1 });
  });
});

describe("sources", () => {
  test("refs and pasted images share one shape", () => {
    expect(sourceFromRef({ id: "b".repeat(64), mediaType: "image/jpeg", width: 10, height: 20, sizeBytes: 5, name: "x.jpg" }, "conv"))
      .toEqual({ imageId: "b".repeat(64), convId: "conv", width: 10, height: 20, mediaType: "image/jpeg", sizeBytes: 5, name: "x.jpg" });
    expect(sourceFromAttachment({ mediaType: "image/png", base64: "", sizeBytes: 5, imageId: "c".repeat(64), width: 3, height: 4 }, null))
      .toEqual({ imageId: "c".repeat(64), width: 3, height: 4, mediaType: "image/png", sizeBytes: 5 });
  });

  test("a local echo gets its id and size from its own bytes", () => {
    // 2×1 PNG header (IHDR only is enough for sizing).
    const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000001080600000000000000", "hex");
    const echo = sourceFromAttachment({ mediaType: "image/png", base64: png.toString("base64"), sizeBytes: png.length }, "conv");
    expect(echo).toMatchObject({ width: 2, height: 1, convId: "conv" });
    expect(echo?.imageId).toMatch(/^[0-9a-f]{64}$/);
    expect(sourceFromAttachment({ mediaType: "image/png", base64: "", sizeBytes: 0 }, null)).toBeNull();
  });

  test("captions name, size, and bytes", () => {
    expect(imageCaption(source)).toBe("chart.png · 800×400 · 88 KB");
  });
});

describe("previews", () => {
  test("fetch once at the drawn pixel size and notify when ready", async () => {
    const requests: ImagePreviewRequest[] = [];
    let changes = 0;
    configureInlineImages({
      fetch: async request => { requests.push(request); return { format: "png", width: 400, height: 200, base64: "UE5H" }; },
      onChange: () => { changes++; },
    });
    setInlineImageCellSize({ width: 10, height: 20 });
    expect(kittyPreview(source, { cols: 40, rows: 10 })).toEqual({ phase: "loading" });
    expect(kittyPreview(source, { cols: 40, rows: 10 })).toEqual({ phase: "loading" });
    await Bun.sleep(0);
    expect(requests).toEqual([{ imageId: source.imageId, format: "png", width: 400, height: 200 }]);
    const ready = kittyPreview(source, { cols: 40, rows: 10 });
    expect(ready.phase).toBe("ready");
    if (ready.phase === "ready") expect(ready.value).toMatchObject({ base64: "UE5H", pixelWidth: 400, pixelHeight: 200 });
    expect(changes).toBeGreaterThan(0);
  });

  test("errors surface and are retried later rather than every frame", async () => {
    let calls = 0;
    configureInlineImages({ fetch: async () => { calls++; throw new Error("image not found"); }, onChange: () => {} });
    kittyPreview(source, { cols: 4, rows: 2 });
    await Bun.sleep(0);
    expect(kittyPreview(source, { cols: 4, rows: 2 })).toEqual({ phase: "error", error: "image not found" });
    expect(calls).toBe(1);
  });
});

describe("half-block fallback", () => {
  test("upper pixel is the foreground, lower the background, alpha blended over the app background", () => {
    // 1×2: opaque red over transparent.
    const rows = renderHalfBlockRows({ width: 1, height: 2, data: Buffer.from([255, 0, 0, 255, 0, 255, 0, 0]) }, [0, 0, 10], "truecolor");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("▀");
    expect(stripAnsi(rows[0])).toBe("▀");
    expect(rows[0]).toMatch(/38;2;255;0;0m/);
    expect(rows[0]).toMatch(/48;2;0;0;10m/);
  });
});

describe("renderInlineImage", () => {
  const box = { cols: 20, rows: 5 };

  test("reserves rows plus a caption in every mode, so layout never shifts", async () => {
    configureInlineImages({
      fetch: async request => request.format === "png"
        ? { format: "png", width: 160, height: 80, base64: "UE5H" }
        : { format: "rgba", width: request.width, height: request.height, base64: Buffer.alloc(request.width * request.height * 4, 200).toString("base64") },
      onChange: () => {},
    });
    const owner = {};
    for (const mode of ["pending", "kitty", "halfblock"] as const) {
      setInlineImageMode(mode);
      const before = renderInlineImage(source, box, 2, owner, 0);
      expect(before.lines).toHaveLength(6);
      await Bun.sleep(0);
      const after = renderInlineImage(source, box, 2, owner, 0);
      expect(after.lines).toHaveLength(6);
      expect(stripAnsi(after.lines[5])).toBe("  chart.png · 800×400 · 88 KB");
      expect(after.layout).toMatchObject({ col: 2, cols: 20, rows: 5 });
    }
  });

  test("kitty rows stay blank once ready; the fallback draws pixels; pending explains", async () => {
    configureInlineImages({
      fetch: async request => request.format === "png"
        ? { format: "png", width: 160, height: 80, base64: "UE5H" }
        : { format: "rgba", width: request.width, height: request.height, base64: Buffer.alloc(request.width * request.height * 4, 200).toString("base64") },
      onChange: () => {},
    });
    expect(stripAnsi(renderInlineImage(source, box, 2, {}, 0).lines[0])).toBe("  loading image…");

    setInlineImageMode("kitty");
    renderInlineImage(source, box, 2, {}, 0);
    await Bun.sleep(0);
    expect(renderInlineImage(source, box, 2, {}, 0).lines.slice(0, 5)).toEqual(["", "", "", "", ""]);

    setInlineImageMode("halfblock");
    renderInlineImage(source, box, 2, {}, 0);
    await Bun.sleep(0);
    const drawn = renderInlineImage(source, box, 2, {}, 0).lines;
    expect(stripAnsi(drawn[0])).toBe(`  ${"▀".repeat(20)}`);
  });

  test("mode and cell-size changes bump the render generation", () => {
    const start = inlineImageGeneration();
    setInlineImageMode("kitty");
    setInlineImageMode("kitty");
    setInlineImageCellSize({ width: 9, height: 18 });
    expect(inlineImageGeneration()).toBe(start + 2);
  });
});

describe("experimental flag", () => {
  test("a fresh TUI shows no images and does not probe the terminal until a daemon enables them", () => {
    inlineImagesInternalsForTest.resetToStartup();
    let starts = 0;
    configureInlineImages({ fetch: async () => { throw new Error("unused"); }, onChange: () => {}, onFirstEnabled: () => { starts++; } });
    expect(inlineImagesActive()).toBe(false);
    expect(starts).toBe(0);

    const before = inlineImageGeneration();
    setInlineImagesEnabled(true);
    expect(starts).toBe(1);
    expect(inlineImagesActive()).toBe(true);
    expect(inlineImageGeneration()).toBe(before + 1);

    // A switch to a daemon without the flag turns them off again; detection never repeats.
    setInlineImagesEnabled(false);
    expect(inlineImagesActive()).toBe(false);
    setInlineImagesEnabled(true);
    expect(starts).toBe(1);

    // EXOCORTEX_TUI_IMAGES=off wins locally.
    setInlineImageMode("off");
    expect(inlineImagesActive()).toBe(false);
  });
});

test("the daemon's tools_available bootstrap carries the flag; an SSH switch clears it", async () => {
  const { handleToolsAvailable } = await import("./events/provider");
  const { handleEvent } = await import("./events");
  const { createInitialState } = await import("./state");
  inlineImagesInternalsForTest.resetToStartup();
  const state = createInitialState();
  const bootstrap = (experimental?: { images: boolean }) => handleToolsAvailable({
    type: "tools_available", providers: [], tools: [], authByProvider: {} as never, authInfoByProvider: {} as never,
    ...(experimental ? { experimental } : {}),
  }, state);
  bootstrap();
  expect(inlineImagesActive()).toBe(false);
  bootstrap({ images: true });
  expect(inlineImagesActive()).toBe(true);
  handleEvent({ type: "ssh_status", state: "connected", switched: true, mode: "remote", alias: "kitsune", message: "" } as never, state, {} as never);
  expect(inlineImagesActive()).toBe(false);
  bootstrap({ images: false });
  expect(inlineImagesActive()).toBe(false);
});
