/**
 * Full-size viewer for a history image, opened with Enter or a click on its
 * thumbnail. A centered bordered box sized to the image (never enlarged past
 * its pixels) and the terminal; the preview is fetched at the box's pixel size
 * through the same get_image path as thumbnails. Kitty terminals get one
 * placement, cleared by the next frame after the viewer closes; other
 * terminals get half-block cells.
 */

import type { KeyEvent } from "./input";
import { moveTo } from "./frame";
import {
  fitImageBox,
  imageCaption,
  kittyPreview,
  renderHalfBlockRows,
  rgbaPreview,
  type CellSize,
  type InlineImageBox,
  type InlineImageSource,
} from "./inlineimages";
import type { KittyPlacement } from "./kittyimages";
import type { TerminalImageMode } from "./terminalgraphics";
import { placementIdFor } from "./historyimages";
import { theme } from "./theme";
import { termWidth, truncateToWidth } from "./textwidth";

const MARGIN_COLUMNS = 2;
const MARGIN_ROWS = 1;
/** Border plus one cell of padding on each side. */
const EXTRA_COLUMNS = 4;
/** Border, title, footer, border. */
const EXTRA_ROWS = 4;
/** The half-block fallback asks for at most 512×512 RGBA pixels. */
const MAX_HALFBLOCK_CELLS = 512 * 256;
const MODAL_PLACEMENT_OWNER = {};

export interface ImageModalState {
  source: InlineImageSource;
}

export type ImageModalKeyResult = "close" | "handled";

/** The viewer owns the keyboard: Enter, Esc, or q closes it. */
export function handleImageModalKey(key: Readonly<KeyEvent>): ImageModalKeyResult {
  if (key.type === "escape" || key.type === "enter") return "close";
  if (key.type === "char" && key.char === "q") return "close";
  return "handled";
}

export interface ImageModalLayout {
  top: number;
  left: number;
  width: number;
  height: number;
  box: InlineImageBox;
}

export function imageModalLayout(
  source: Pick<InlineImageSource, "width" | "height">,
  totalRows: number,
  totalCols: number,
  cell: CellSize,
  mode: TerminalImageMode,
): ImageModalLayout | null {
  const maxColumns = totalCols - MARGIN_COLUMNS * 2 - EXTRA_COLUMNS;
  let maxRows = totalRows - MARGIN_ROWS * 2 - EXTRA_ROWS;
  if (maxColumns < 1 || maxRows < 1) return null;
  if (mode !== "kitty") maxRows = Math.min(maxRows, Math.floor(MAX_HALFBLOCK_CELLS / maxColumns));
  const box = fitImageBox(source, maxColumns, maxRows, cell);
  const width = box.cols + EXTRA_COLUMNS;
  const height = box.rows + EXTRA_ROWS;
  return {
    top: Math.floor((totalRows - height) / 2) + 1,
    left: Math.floor((totalCols - width) / 2) + 1,
    width,
    height,
    box,
  };
}

function centered(text: string, width: number): string {
  const clipped = truncateToWidth(text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " "), width);
  const visible = termWidth(clipped);
  const left = Math.max(0, Math.floor((width - visible) / 2));
  return " ".repeat(left) + clipped + " ".repeat(Math.max(0, width - left - visible));
}

export interface RenderedImageModal {
  payload: string;
  /** Terminal placement for Kitty mode once the preview has loaded. */
  placement: KittyPlacement | null;
}

export function renderImageModal(
  state: Readonly<ImageModalState>,
  totalRows: number,
  totalCols: number,
  cell: CellSize,
  mode: TerminalImageMode,
): RenderedImageModal {
  const layout = imageModalLayout(state.source, totalRows, totalCols, cell, mode);
  if (!layout) {
    const lines = ["Image viewer", "Terminal too small", "Esc to close"];
    const payload = lines.slice(0, Math.max(0, totalRows)).map((line, index) => (
      moveTo(index + 1, 1) + theme.sidebarBg + theme.warning + centered(line, Math.max(1, totalCols)) + theme.reset
    )).join("");
    return { payload, placement: null };
  }

  const { top, left, box } = layout;
  const inner = layout.width - 2;
  const border = theme.sidebarBg + theme.accent;
  const row = (screenRow: number, content: string) => moveTo(screenRow, left)
    + border + "│" + theme.sidebarBg + content + theme.reset + border + "│" + theme.reset;

  let body: string[] = Array.from({ length: box.rows }, () => "");
  let placement: KittyPlacement | null = null;
  let status = "";
  if (mode === "kitty") {
    const preview = kittyPreview(state.source, box);
    if (preview.phase === "ready") {
      placement = {
        image: preview.value,
        placementId: placementIdFor(MODAL_PLACEMENT_OWNER, 0),
        row: top + 2,
        col: left + 2,
        columns: box.cols,
        rows: box.rows,
      };
    } else {
      status = preview.phase === "error" ? `⚠ ${preview.error}` : "loading image…";
    }
  } else if (mode === "halfblock") {
    const preview = rgbaPreview(state.source, box);
    if (preview.phase === "ready") body = renderHalfBlockRows(preview.value);
    else status = preview.phase === "error" ? `⚠ ${preview.error}` : "loading image…";
  } else {
    status = "Images are turned off (EXOCORTEX_TUI_IMAGES=off)";
  }

  const out = [
    moveTo(top, left) + border + `╭${"─".repeat(inner)}╮` + theme.reset,
    row(top + 1, theme.text + centered(imageCaption(state.source), inner)),
  ];
  for (let index = 0; index < box.rows; index++) {
    const content = status && index === Math.floor(box.rows / 2)
      ? theme.muted + centered(status, inner)
      : ` ${body[index] ? body[index] + theme.sidebarBg : " ".repeat(box.cols)} `;
    out.push(row(top + 2 + index, content));
  }
  out.push(row(top + 2 + box.rows, theme.muted + centered("Enter or Esc to close", inner)));
  out.push(moveTo(top + layout.height - 1, left) + border + `╰${"─".repeat(inner)}╯` + theme.reset);
  return { payload: out.join(""), placement };
}
