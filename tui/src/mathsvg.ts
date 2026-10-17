/**
 * Fit MathJax SVG output to whole terminal cells.
 *
 * MathJax measures in thousandths of an em. This module scales that to the
 * requested em size in pixels, pads the drawing to a whole number of cells
 * (centered, so it sits in the middle of its cell box), and paints it in the
 * theme's text colour. A Kitty placement then shows the PNG 1:1, without
 * the terminal stretching it.
 */

/** Below this, a too-wide equation is unreadable as an image; it stays text. */
export const MIN_FIT_SCALE = 0.6;

export interface MathSvgOptions {
  /** Pixels per em. */
  emPx: number;
  cellWidth: number;
  cellHeight: number;
  /** `#rrggbb` used for everything MathJax draws in `currentColor`. */
  color: string;
  /** Widest box allowed, in cells; wider equations are scaled down to fit. */
  maxCols?: number;
}

export interface MathSvgLayout {
  svg: string;
  cols: number;
  rows: number;
  pixelWidth: number;
  pixelHeight: number;
  /** Characters outside MathJax's fonts are drawn as SVG text and need system fonts. */
  needsSystemFonts: boolean;
}

const NUMBER = "(-?[\\d.]+(?:e[-+]?\\d+)?)";
const VIEW_BOX = new RegExp(`viewBox="${NUMBER} ${NUMBER} ${NUMBER} ${NUMBER}"`, "i");

/** Throws when the SVG is a MathJax error or has no usable geometry. */
export function layoutMathSvg(svg: string, options: MathSvgOptions): MathSvgLayout {
  if (/data-mjx-error|data-mml-node="merror"/.test(svg)) throw new Error("TeX error");
  const open = /^<svg\b[^>]*>/.exec(svg);
  const box = open ? VIEW_BOX.exec(open[0]) : null;
  if (!open || !box) throw new Error("malformed MathJax SVG");
  const [x, y, width, height] = box.slice(1).map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error("empty math");
  if (!(options.emPx > 0 && options.cellWidth > 0 && options.cellHeight > 0)) throw new Error("bad cell size");
  if (!/^#[0-9a-f]{6}$/i.test(options.color)) throw new Error("bad colour");

  let unit = options.emPx / 1000;
  if (options.maxCols !== undefined) {
    const room = Math.max(1, options.maxCols) * options.cellWidth;
    if (width * unit > room) {
      const scale = room / (width * unit);
      if (scale < MIN_FIT_SCALE) throw new Error("equation too wide");
      unit *= scale;
    }
  }
  // A hair of tolerance keeps exact fits (and float noise) from adding a cell.
  const cols = Math.max(1, Math.ceil((width * unit) / options.cellWidth - 1e-6));
  const rows = Math.max(1, Math.ceil((height * unit) / options.cellHeight - 1e-6));
  const pixelWidth = cols * options.cellWidth;
  const pixelHeight = rows * options.cellHeight;
  const viewWidth = pixelWidth / unit;
  const viewHeight = pixelHeight / unit;
  const viewX = x - (viewWidth - width) / 2;
  const viewY = y - (viewHeight - height) / 2;
  const root = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${pixelWidth}" height="${pixelHeight}" viewBox="${viewX} ${viewY} ${viewWidth} ${viewHeight}">`;
  const body = svg.slice(open[0].length).replaceAll("currentColor", options.color);
  return { svg: root + body, cols, rows, pixelWidth, pixelHeight, needsSystemFonts: body.includes("<text") };
}
