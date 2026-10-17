/**
 * Off-thread TeX → PNG rasterizer for display math images.
 *
 * MathJax (pure JS) typesets TeX to SVG with its glyphs as paths, so no TeX
 * install or system font is needed; resvg (prebuilt native binary) turns the
 * SVG into a PNG. Both are loaded on the first request, here, so the ~150 ms
 * cold start and every render stay off the TUI's event loop.
 */

import type { MathRenderRequest, MathRenderResponse } from "./mathimages";
import { layoutMathSvg } from "./mathsvg";

declare const self: Worker;

interface Engine {
  toSvg(tex: string, display: boolean, emPx: number, containerWidth: number): string;
  toPng(svg: string, systemFonts: boolean): Uint8Array;
}

let engine: Promise<Engine> | null = null;

async function loadEngine(): Promise<Engine> {
  const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }, { AllPackages }, { Resvg }] = await Promise.all([
    import("mathjax-full/js/mathjax.js"),
    import("mathjax-full/js/input/tex.js"),
    import("mathjax-full/js/output/svg.js"),
    import("mathjax-full/js/adaptors/liteAdaptor.js"),
    import("mathjax-full/js/handlers/html.js"),
    import("mathjax-full/js/input/tex/AllPackages.js"),
    import("@resvg/resvg-js"),
  ]);
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const tex = new TeX({
    // Without these two, unknown macros and syntax errors throw instead of
    // rendering as red error boxes; the caller then keeps the text rendering.
    packages: AllPackages.filter(name => name !== "noerrors" && name !== "noundefined"),
    formatError: (_jax: unknown, error: { message?: string }) => {
      throw new Error(error.message ?? "TeX error");
    },
  });
  const document = mathjax.document("", { InputJax: tex, OutputJax: new SVG({ fontCache: "local" }) });
  return {
    toSvg(source, display, emPx, containerWidth) {
      const node = document.convert(source, { display, em: emPx, ex: emPx / 2, containerWidth });
      // Each conversion would otherwise stay in the document's math list.
      document.clear();
      return adaptor.innerHTML(node);
    },
    toPng(svg, systemFonts) {
      return new Resvg(svg, { font: { loadSystemFonts: systemFonts } }).render().asPng();
    },
  };
}

async function render(request: MathRenderRequest): Promise<MathRenderResponse> {
  try {
    engine ??= loadEngine();
    const { toSvg, toPng } = await engine;
    const containerWidth = (request.maxCols ?? 200) * request.cellWidth;
    const layout = layoutMathSvg(toSvg(request.tex, request.display, request.emPx, containerWidth), request);
    const png = toPng(layout.svg, layout.needsSystemFonts);
    return {
      id: request.id,
      ok: true,
      base64: Buffer.from(png).toString("base64"),
      pixelWidth: layout.pixelWidth,
      pixelHeight: layout.pixelHeight,
      cols: layout.cols,
      rows: layout.rows,
    };
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

self.onmessage = (event: MessageEvent<MathRenderRequest>) => {
  void render(event.data).then(response => self.postMessage(response));
};
