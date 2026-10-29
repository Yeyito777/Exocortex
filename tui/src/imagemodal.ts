/**
 * Full-size viewer for a history image, opened with Enter or a click on its
 * thumbnail. A centered bordered box sized to the image (never enlarged past
 * its pixels) and the terminal; the preview is fetched at the box's pixel size
 * through the same get_image path as thumbnails. Kitty terminals get one
 * placement above the thumbnails, which stay placed around the box; it is
 * cleared by the next frame after the viewer closes. While the full-size
 * preview loads, the box shows the image's thumbnail scaled up. Other
 * terminals get half-block cells. When the message has several images, j/k
 * (or l/h, →/←) page through them.
 *
 * A video opens playing (videoplayer.ts) where the terminal can: its poster
 * stays placed under the video (z=2 and 3), so nothing flashes until the
 * first frame, and a transport row under it shows time, progress and keys.
 * Elsewhere the poster shows with a line saying how to open the file.
 */

import type { KeyEvent } from "./input";
import { moveTo } from "./frame";
import {
  fitImageBox,
  imageCaption,
  inlineVideoPlayable,
  kittyPreview,
  kittyThumbnail,
  renderHalfBlockRows,
  rgbaPreview,
  type CellSize,
  type InlineImageBox,
  type InlineImageSource,
} from "./inlineimages";
import type { KittyPlacement } from "./kittyimages";
import type { TerminalImageMode } from "./terminalgraphics";
import { placementIdFor, type ScreenRect } from "./historyimages";
import { theme } from "./theme";
import { termWidth, truncateToWidth } from "./textwidth";
import { videoCaptionText, videoFor, videoImageFor } from "./videoplayer";

const MARGIN_COLUMNS = 2;
const MARGIN_ROWS = 1;
/** Border plus one cell of padding on each side. */
const EXTRA_COLUMNS = 4;
/** Border, title, border. */
const EXTRA_ROWS = 3;
/** The half-block fallback asks for at most 512×512 RGBA pixels. */
const MAX_HALFBLOCK_CELLS = 512 * 256;
const MODAL_PLACEMENT_OWNER = {};
const MODAL_VIDEO_OWNER = {};

export interface ImageModalState {
  /** The images of the message the viewer was opened from, in order. */
  images: readonly InlineImageSource[];
  index: number;
}

export type ImageModalKeyResult = "close" | "handled";

/** The viewer owns the keyboard: Enter, Esc, or q closes it; j/k page, stopping at either end. */
export function handleImageModalKey(key: Readonly<KeyEvent>, state?: ImageModalState): ImageModalKeyResult {
  if (key.type === "escape" || key.type === "enter") return "close";
  const char = key.type === "char" ? key.char : undefined;
  if (char === "q") return "close";
  const step = char === "j" || char === "l" || key.type === "right" ? 1
    : char === "k" || char === "h" || key.type === "left" ? -1
      : 0;
  if (state && step) state.index = Math.max(0, Math.min(state.images.length - 1, state.index + step));
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
  source: Pick<InlineImageSource, "width" | "height"> & Partial<Pick<InlineImageSource, "video">>,
  totalRows: number,
  totalCols: number,
  cell: CellSize,
  mode: TerminalImageMode,
): ImageModalLayout | null {
  // A video has a transport row under it.
  const extraRows = EXTRA_ROWS + ("video" in source && source.video ? 1 : 0);
  const maxColumns = totalCols - MARGIN_COLUMNS * 2 - EXTRA_COLUMNS;
  let maxRows = totalRows - MARGIN_ROWS * 2 - extraRows;
  if (maxColumns < 1 || maxRows < 1) return null;
  if (mode !== "kitty") maxRows = Math.min(maxRows, Math.floor(MAX_HALFBLOCK_CELLS / maxColumns));
  const box = fitImageBox(source, maxColumns, maxRows, cell);
  const width = box.cols + EXTRA_COLUMNS;
  const height = box.rows + extraRows;
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
  /** Terminal placements for Kitty mode once the preview has loaded (a playing video's above its poster). */
  placements: KittyPlacement[];
  /** Screen cells the viewer draws over; history images keep the rest. */
  rect: ScreenRect;
  /** The image box in pixels: where a video plays. */
  pixels: { width: number; height: number } | null;
}

export function renderImageModal(
  state: Readonly<ImageModalState>,
  totalRows: number,
  totalCols: number,
  cell: CellSize,
  mode: TerminalImageMode,
): RenderedImageModal {
  const source = state.images[state.index];
  const layout = source ? imageModalLayout(source, totalRows, totalCols, cell, mode) : null;
  if (!layout) {
    const lines = ["Image viewer", "Terminal too small", "Esc to close"];
    const payload = lines.slice(0, Math.max(0, totalRows)).map((line, index) => (
      moveTo(index + 1, 1) + theme.sidebarBg + theme.warning + centered(line, Math.max(1, totalCols)) + theme.reset
    )).join("");
    return { payload, placements: [], rect: { top: 1, bottom: Math.min(lines.length, totalRows), left: 1, right: totalCols }, pixels: null };
  }

  const { top, left, box } = layout;
  const inner = layout.width - 2;
  const border = theme.sidebarBg + theme.accent;
  const row = (screenRow: number, content: string) => moveTo(screenRow, left)
    + border + "│" + theme.sidebarBg + content + theme.reset + border + "│" + theme.reset;

  let body: string[] = Array.from({ length: box.rows }, () => "");
  const placements: KittyPlacement[] = [];
  let status = "";
  if (mode === "kitty") {
    let preview = kittyPreview(source, box, { urgent: true });
    // Until the full-size preview arrives (a round trip over SSH), stretch the
    // thumbnail the terminal already holds over the box.
    if (preview.phase === "loading") {
      const thumbnail = kittyThumbnail(source, { peek: true });
      if (thumbnail.phase === "ready") preview = thumbnail;
    }
    if (preview.phase === "ready") {
      placements.push({
        image: preview.value,
        placementId: placementIdFor(MODAL_PLACEMENT_OWNER, 0),
        row: top + 2,
        col: left + 2,
        columns: box.cols,
        rows: box.rows,
        z: 2,
      });
    }
    const video = source.video ? videoImageFor(source.video.id, "viewer") : null;
    if (video) {
      placements.push({
        image: video,
        placementId: placementIdFor(MODAL_VIDEO_OWNER, 0),
        row: top + 2,
        col: left + 2,
        columns: box.cols,
        rows: box.rows,
        z: 3,
      });
    } else if (preview.phase === "ready") {
      // The poster is enough until the video's first frame.
    } else {
      status = preview.phase === "error" ? `⚠ ${preview.error}` : "loading image…";
    }
  } else if (mode === "halfblock") {
    const preview = rgbaPreview(source, box);
    if (preview.phase === "ready") body = renderHalfBlockRows(preview.value);
    else status = preview.phase === "error" ? `⚠ ${preview.error}` : "loading image…";
  } else {
    status = "Images are turned off (EXOCORTEX_TUI_IMAGES=off)";
  }

  // Once this image has loaded, fetch the next one so paging is instant (also over SSH).
  const next = state.images[state.index + 1];
  const nextLayout = !status && next ? imageModalLayout(next, totalRows, totalCols, cell, mode) : null;
  if (nextLayout && mode === "kitty") kittyPreview(next, nextLayout.box);
  else if (nextLayout && mode === "halfblock") rgbaPreview(next, nextLayout.box);

  const title = state.images.length > 1
    ? `${imageCaption(source)} · ${state.index + 1}/${state.images.length}`
    : imageCaption(source);
  const out = [
    moveTo(top, left) + border + `╭${"─".repeat(inner)}╮` + theme.reset,
    row(top + 1, theme.text + centered(title, inner)),
  ];
  for (let index = 0; index < box.rows; index++) {
    const content = status && index === Math.floor(box.rows / 2)
      ? theme.muted + centered(status, inner)
      : ` ${body[index] ? body[index] + theme.sidebarBg : " ".repeat(box.cols)} `;
    out.push(row(top + 2 + index, content));
  }
  if (source.video) {
    const playback = videoFor(source.video.id);
    const text = videoCaptionText(source, playback, mode === "kitty" && inlineVideoPlayable(), inner - 2, termWidth, "viewer");
    const color = playback?.state === "error" ? theme.warning : playback ? theme.text : theme.muted;
    out.push(row(top + 2 + box.rows, ` ${color}${truncateToWidth(text, inner - 2)}${" ".repeat(Math.max(0, inner - 2 - termWidth(text)))} `));
  }
  out.push(moveTo(top + layout.height - 1, left) + border + `╰${"─".repeat(inner)}╯` + theme.reset);
  const rect = { top, bottom: top + layout.height - 1, left, right: left + layout.width - 1 };
  return { payload: out.join(""), placements, rect, pixels: { width: box.cols * cell.width, height: box.rows * cell.height } };
}
