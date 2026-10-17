import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createDisplayMathImageRenderer,
  displayMathImage,
  mathImageCacheKey,
  mathImageGeneration,
  mathImagesActive,
  mathImagesInternalsForTest,
  mathRenderEnvironment,
  resolveMathRenderSetting,
  type MathRenderRequest,
  type MathRenderResponse,
} from "./mathimages";
import { layoutMathSvg, MIN_FIT_SCALE } from "./mathsvg";
import { inlineImagesInternalsForTest, setInlineImageCellSize, setInlineImageMode } from "./inlineimages";
import { markdownWordWrap } from "./markdown";
import { renderBlockCached } from "./blockrenderer";
import { buildMessageLines } from "./conversation";
import { collectHistoryImagePlacements } from "./historyimages";
import { joinLogicalLines, stripAnsi } from "./historycursor";
import { createInitialState } from "./state";
import { theme } from "./theme";
import type { Block } from "./messages";

/** A fake rasterizer: every equation is `cols` × 2 cells unless it says `\bad`. */
function fakeRasterizer(options: { cols?: (request: MathRenderRequest) => number } = {}) {
  const requests: MathRenderRequest[] = [];
  const resolvers: Array<() => void> = [];
  const rasterize = (request: MathRenderRequest) => {
    requests.push(request);
    return new Promise<MathRenderResponse>(resolve => {
      resolvers.push(() => {
        if (request.tex.includes("\\bad")) {
          resolve({ id: request.id, ok: false, error: "Undefined control sequence \\bad" });
          return;
        }
        const cols = options.cols?.(request) ?? 10;
        resolve({
          id: request.id,
          ok: true,
          base64: `PNG:${request.tex}`,
          pixelWidth: cols * request.cellWidth,
          pixelHeight: 2 * request.cellHeight,
          cols,
          rows: 2,
        });
      });
    });
  };
  const flush = async () => {
    while (resolvers.length) resolvers.shift()!();
    await Bun.sleep(0);
  };
  return { rasterize, requests, flush };
}

beforeEach(() => {
  inlineImagesInternalsForTest.reset();
  mathImagesInternalsForTest.reset({ setting: "image", rasterize: fakeRasterizer().rasterize });
});
afterEach(() => {
  inlineImagesInternalsForTest.reset();
  mathImagesInternalsForTest.reset();
});

describe("settings and detection", () => {
  test("env overrides config; unknown values mean auto", () => {
    expect(resolveMathRenderSetting({ EXOCORTEX_TUI_MATH: "TEXT" }, () => ({ tui: { math: "image" } }))).toBe("text");
    expect(resolveMathRenderSetting({}, () => ({ tui: { math: "image" } }))).toBe("image");
    expect(resolveMathRenderSetting({ EXOCORTEX_TUI_MATH: "bogus" }, () => ({}))).toBe("auto");
    expect(resolveMathRenderSetting({}, () => { throw new Error("unreadable"); })).toBe("auto");
  });

  test("auto follows Kitty detection; text and image are forced", () => {
    mathImagesInternalsForTest.reset({ setting: "auto" });
    expect(mathImagesActive()).toBe(false);
    setInlineImageMode("halfblock");
    expect(mathImagesActive()).toBe(false);
    setInlineImageMode("kitty");
    expect(mathImagesActive()).toBe(true);
    mathImagesInternalsForTest.reset({ setting: "text" });
    expect(mathImagesActive()).toBe(false);
    expect(createDisplayMathImageRenderer()).toBeUndefined();
    expect(mathImageCacheKey()).toBe("text");
    setInlineImageMode("off");
    mathImagesInternalsForTest.reset({ setting: "image" });
    expect(mathImagesActive()).toBe(true);
  });
});

describe("SVG cell fitting", () => {
  const svg = (width: number, height: number, body = '<g fill="currentColor"></g>') =>
    `<svg style="vertical-align: -0.5ex;" xmlns="http://www.w3.org/2000/svg" width="1ex" height="1ex" viewBox="0 -750 ${width} ${height}">${body}</svg>`;
  const options = { emPx: 16, cellWidth: 8, cellHeight: 16, color: "#c0caf5" };

  test("pads to whole cells, centered, in the theme colour", () => {
    // 4000 × 1500 units at 16 px/em = 64 × 24 px → 8 × 2 cells.
    const layout = layoutMathSvg(svg(4000, 1500), options);
    expect(layout).toMatchObject({ cols: 8, rows: 2, pixelWidth: 64, pixelHeight: 32, needsSystemFonts: false });
    expect(layout.svg).toContain('width="64" height="32" viewBox="0 -1000 4000 2000"');
    expect(layout.svg).toContain('fill="#c0caf5"');
    expect(layout.svg).not.toContain("currentColor");
    expect(layout.svg).not.toContain("vertical-align");
  });

  test("scales a too-wide equation down to fit, or refuses when unreadable", () => {
    const fitted = layoutMathSvg(svg(10000, 1000), { ...options, maxCols: 15 });
    expect(fitted.cols).toBe(15);
    expect(fitted.rows).toBe(1);
    expect(() => layoutMathSvg(svg(10000, 1000), { ...options, maxCols: Math.floor(20 * MIN_FIT_SCALE) - 1 })).toThrow("too wide");
  });

  test("MathJax error output and garbage are errors, not images", () => {
    expect(() => layoutMathSvg(svg(1000, 1000, '<g data-mml-node="merror"></g>'), options)).toThrow();
    expect(() => layoutMathSvg("<div>nope</div>", options)).toThrow();
    expect(() => layoutMathSvg(svg(0, 1000), options)).toThrow();
    expect(layoutMathSvg(svg(1000, 1000, '<text font-family="serif">日</text>'), options).needsSystemFonts).toBe(true);
  });
});

describe("render requests and cache", () => {
  test("fragment → request carries cell size, em size and theme colour", () => {
    const fake = fakeRasterizer();
    mathImagesInternalsForTest.reset({ setting: "image", rasterize: fake.rasterize });
    setInlineImageCellSize({ width: 10, height: 20 });
    expect(displayMathImage("x^2", 80).phase).toBe("pending");
    expect(fake.requests).toHaveLength(1);
    const environment = mathRenderEnvironment();
    expect(fake.requests[0]).toMatchObject({ tex: "x^2", display: true, cellWidth: 10, cellHeight: 20, emPx: 18, color: environment.color });
    expect(fake.requests[0].maxCols).toBeUndefined();
    expect(environment.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("one request per (tex, cell, colour); settling bumps the generation", async () => {
    const fake = fakeRasterizer();
    mathImagesInternalsForTest.reset({ setting: "image", rasterize: fake.rasterize });
    displayMathImage("a+b", 80);
    displayMathImage("a+b", 60);
    expect(fake.requests).toHaveLength(1);
    const before = mathImageGeneration();
    await fake.flush();
    expect(mathImageGeneration()).toBe(before + 1);
    const ready = displayMathImage("a+b", 80);
    expect(ready.phase).toBe("ready");
    if (ready.phase === "ready") expect(ready.image).toMatchObject({ cols: 10, rows: 2 });
    setInlineImageCellSize({ width: 9, height: 18 });
    displayMathImage("a+b", 80);
    expect(fake.requests).toHaveLength(2);
  });

  test("a wider-than-pane equation gets a second, width-capped render", async () => {
    const fake = fakeRasterizer({ cols: request => request.maxCols ?? 50 });
    mathImagesInternalsForTest.reset({ setting: "image", rasterize: fake.rasterize });
    displayMathImage("\\sum", 30);
    await fake.flush();
    expect(displayMathImage("\\sum", 30).phase).toBe("pending");
    expect(fake.requests.at(-1)?.maxCols).toBe(30);
    await fake.flush();
    const state = displayMathImage("\\sum", 30);
    expect(state.phase === "ready" && state.image.cols).toBe(30);
    // Wide enough for the natural render: no capped request.
    expect(displayMathImage("\\sum", 60).phase).toBe("ready");
    expect(fake.requests).toHaveLength(2);
  });
});

describe("markdown and block rendering", () => {
  const text = "Before $x_1$ inline.\n\n$$PS=\\frac12 Q(P-10)$$\n\nAfter.";

  test("display math becomes centered image rows that copy the TeX; inline math stays text", async () => {
    const fake = fakeRasterizer();
    mathImagesInternalsForTest.reset({ setting: "image", rasterize: fake.rasterize });
    const pendingRenderer = createDisplayMathImageRenderer()!;
    const pending = markdownWordWrap(text, 40, theme.reset, { displayMath: pendingRenderer.render });
    expect(pendingRenderer.pending).toBe(true);
    expect(pending.images).toBeUndefined();
    // The Unicode text rendering shows until the image is ready.
    expect(pending.lines.map(stripAnsi).join("\n")).toContain("PS=");

    await fake.flush();
    const renderer = createDisplayMathImageRenderer()!;
    const ready = markdownWordWrap(text, 40, theme.reset, { displayMath: renderer.render });
    expect(renderer.pending).toBe(false);
    const rows = ready.images!.flatMap((row, index) => row ? [index] : []);
    expect(rows).toHaveLength(2);
    const image = ready.images![rows[0]]!.image;
    expect(image).toMatchObject({ col: 15, cols: 10, rows: 2, index: 0 });
    expect(ready.lines[rows[0]]).toBe(" ".repeat(15));
    expect(ready.lines.map(stripAnsi).join("\n")).not.toContain("PS=");
    expect(ready.lines.map(stripAnsi).join("\n")).toContain("x₁");
    const copied = joinLogicalLines(ready.lines, ready.cont, 0, ready.lines.length - 1, ready.join, ready.copy);
    expect(copied).toContain("$$PS=\\frac12 Q(P-10)$$");
    expect(copied).toContain("Before x₁ inline.");
  });

  test("multi-line \\[…\\] blocks copy their original source lines", async () => {
    const fake = fakeRasterizer();
    mathImagesInternalsForTest.reset({ setting: "image", rasterize: fake.rasterize });
    const source = "Matrix:\n  \\[\n  \\begin{pmatrix} a & b \\\\\n    c & d \\end{pmatrix}\n  \\]";
    createDisplayMathImageRenderer()!.render("\\begin{pmatrix} a & b \\\\\n    c & d \\end{pmatrix}", 40, []);
    await fake.flush();
    const renderer = createDisplayMathImageRenderer()!;
    const wrapped = markdownWordWrap(source, 40, theme.reset, { displayMath: renderer.render });
    expect(wrapped.images?.filter(Boolean)).toHaveLength(2);
    expect(joinLogicalLines(wrapped.lines, wrapped.cont, 0, wrapped.lines.length - 1, wrapped.join, wrapped.copy))
      .toBe("Matrix:\n\\[\n\\begin{pmatrix} a & b \\\\\n  c & d \\end{pmatrix}\n\\]");
  });

  test("malformed TeX falls back to text for that fragment only", async () => {
    const fake = fakeRasterizer();
    mathImagesInternalsForTest.reset({ setting: "image", rasterize: fake.rasterize });
    const source = "$$\\bad{x}$$\n\n$$y^2$$";
    markdownWordWrap(source, 40, theme.reset, { displayMath: createDisplayMathImageRenderer()!.render });
    await fake.flush();
    const renderer = createDisplayMathImageRenderer()!;
    const wrapped = markdownWordWrap(source, 40, theme.reset, { displayMath: renderer.render });
    expect(renderer.pending).toBe(false);
    expect(wrapped.images?.filter(Boolean)).toHaveLength(2);
    expect(wrapped.lines.map(stripAnsi).join("\n")).toContain("bad");
  });

  test("history blocks re-render once a pending image settles, and only then", async () => {
    const fake = fakeRasterizer();
    mathImagesInternalsForTest.reset({ setting: "image", rasterize: fake.rasterize });
    const block: Block = { type: "text", text: "$$\\int_0^1 x\\,dx$$" };
    const tools: never[] = [];
    const styles: never[] = [];
    const first = renderBlockCached(block, 60, tools, styles, false, false, true);
    expect(first.mathPending).toBe(true);
    expect(renderBlockCached(block, 60, tools, styles, false, false, true)).toBe(first);
    await fake.flush();
    const second = renderBlockCached(block, 60, tools, styles, false, false, true);
    expect(second).not.toBe(first);
    expect(second.mathPending).toBeUndefined();
    // Placements sit after the assistant indent.
    expect(second.images?.find(Boolean)?.image.col).toBe(2 + 25);
    displayMathImage("unrelated", 60);
    await fake.flush();
    expect(renderBlockCached(block, 60, tools, styles, false, false, true)).toBe(second);
    // Callers that cannot place images (the btw panel) keep text.
    expect(renderBlockCached(block, 60, tools, styles, false).images).toBeUndefined();
  });

  test("history anchors place the image, and a trailing equation is not trimmed", async () => {
    const fake = fakeRasterizer();
    mathImagesInternalsForTest.reset({ setting: "image", rasterize: fake.rasterize });
    const state = createInitialState();
    state.cols = 80;
    state.rows = 30;
    state.messages = [
      { role: "user", text: "area?", metadata: null },
      { role: "assistant", blocks: [{ type: "text", text: "It is\n\n$$\\frac12(229/3)^2$$" }], metadata: null },
    ];
    buildMessageLines(state, 70);
    await fake.flush();
    const built = buildMessageLines(state, 70);
    const rows = built.lineAnchors.flatMap((anchor, index) => anchor.images ? [index] : []);
    expect(rows).toHaveLength(2);
    const layout = built.lineAnchors[rows[0]].images![0].layout;
    expect("kitty" in layout && layout.kitty.base64).toBe("PNG:\\frac12(229/3)^2");
    const placements = collectHistoryImagePlacements({
      viewportRows: built.lines.map((_, lineIndex) => ({ lineIndex, startCol: 0, displayPrefixWidth: 0 })),
      lineAnchors: built.lineAnchors,
      messageAreaStart: 1,
      chatCol: 1,
      maxCol: 70,
      obstructions: [],
      mathOnly: true,
    });
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ row: rows[0] + 1, columns: 10, rows: 2 });
    // Half covered by an overlay: cropped, never drawn over it.
    const covered = collectHistoryImagePlacements({
      viewportRows: built.lines.map((_, lineIndex) => ({ lineIndex, startCol: 0, displayPrefixWidth: 0 })),
      lineAnchors: built.lineAnchors,
      messageAreaStart: 1,
      chatCol: 1,
      maxCol: 70,
      obstructions: [],
      covers: [{ top: rows[0] + 1, bottom: rows[0] + 1, left: 1, right: 70 }],
      mathOnly: true,
    });
    expect(covered).toHaveLength(1);
    expect(covered[0]).toMatchObject({ row: rows[0] + 2, rows: 1, sourceY: 16, sourceHeight: 16 });
  });
});

describe("worker rasterizer", () => {
  test("typesets real TeX to a cell-sized PNG and rejects malformed TeX", async () => {
    const { workerRasterizer } = mathImagesInternalsForTest;
    const base = { display: true, emPx: 14, cellWidth: 8, cellHeight: 16, color: "#ffffff" };
    const ok = await workerRasterizer({ ...base, id: 1, tex: "PS=\\frac12 Q(P-10)=\\frac12(229/3)^2" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.pixelWidth).toBe(ok.cols * 8);
      expect(ok.pixelHeight).toBe(ok.rows * 16);
      expect(ok.rows).toBeGreaterThanOrEqual(2);
      expect(Buffer.from(ok.base64, "base64").subarray(1, 4).toString()).toBe("PNG");
    }
    const bad = await workerRasterizer({ ...base, id: 2, tex: "\\frac{a" });
    expect(bad).toMatchObject({ id: 2, ok: false });
    const unknown = await workerRasterizer({ ...base, id: 3, tex: "\\notamacro x" });
    expect(unknown.ok).toBe(false);
  }, 20_000);
});
