/**
 * Terminal placements for inline history images (Kitty graphics mode).
 *
 * History rendering reserves blank rows for each image and tags them with a
 * line anchor. After the viewport is composed, this module finds the image
 * rows actually on screen, crops each image to its visible, unobstructed run
 * of rows (and around the image viewer or edit menu, if open), and reconciles the terminal through KittyImageSync. Placements are
 * recomputed every frame from scratch, so scrolling, resizing, switching
 * conversations, and overlays can never leave a stale image behind.
 *
 * It also decides what to fetch: thumbnails on screen first, then those
 * within a screen's height of it, so opening a long conversation never
 * downloads every image it holds. Until one has pixels its first visible row
 * carries a loading (or error) notice, drawn by the frame.
 */

import type { RenderLineAnchor } from "./conversation";
import { imageHitAt, imageStatus, kittyThumbnail, type InlineImageLayout } from "./inlineimages";
import { KittyImageSync, type KittyImageData, type KittyPlacement } from "./kittyimages";
import { parseKittyGraphicsResponse } from "./terminalgraphics";
import { termWidth } from "./textwidth";

/** A display-math image (mathimages.ts): its pixels are rendered by the TUI, not fetched. */
export interface MathImageLayout {
  kitty: KittyImageData;
  col: number;
  cols: number;
  rows: number;
  owner: object;
  index: number;
}

export type HistoryImageLayout = InlineImageLayout | MathImageLayout;

/**
 * Math draws below text: its cells hold concealed TeX, so their backgrounds
 * (line highlight, cursor, selections) show through the transparent pixels
 * instead of the terminal treating the changed cells as covers. Text overlays
 * would not hide it, so every overlay must still crop it (covers/obstructions).
 */
export const MATH_IMAGE_Z = -1;

/** Placement geometry for one math image of a history block. */
export function mathImageLayout(image: { kitty: KittyImageData; col: number; cols: number; rows: number; index: number }, owner: object): MathImageLayout {
  return { kitty: image.kitty, col: image.col, cols: image.cols, rows: image.rows, owner, index: image.index };
}

export interface ScreenRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface HistoryImageViewportRow {
  lineIndex: number;
  startCol: number;
  displayPrefixWidth: number;
}

export interface CollectHistoryImagesOptions {
  viewportRows: readonly (HistoryImageViewportRow | null | undefined)[];
  lineAnchors: readonly RenderLineAnchor[];
  /** 1-based screen row of viewport row 0. */
  messageAreaStart: number;
  /** 1-based screen column where history lines start. */
  chatCol: number;
  /** Last screen column images may cover. */
  maxCol: number;
  /** Screen regions drawn on top of history (task panel and the like); image rows under them are dropped. */
  obstructions: readonly ScreenRect[];
  /**
   * Boxes drawn on top of everything (the image viewer, the edit menu). Images
   * keep every cell outside them, as cropped placements around each box.
   */
  covers?: readonly ScreenRect[];
  /** History line under the focused history cursor; its image is tinted as selected. */
  cursorLineIndex?: number | null;
  /** The cursor's column, which picks the image in a strip. */
  cursorCol?: number;
  /** Place display-math images only (history images render as half-blocks or not at all). */
  mathOnly?: boolean;
  /** History lines above and below the screen whose thumbnails are fetched ahead of scrolling (default: one screen). */
  prefetchLines?: number;
}

/** Text drawn over the first visible row of a thumbnail that has no pixels yet. */
export interface HistoryImageNotice {
  row: number;
  col: number;
  /** Plain text, already cut to the columns it may use. */
  text: string;
}

export interface CollectedHistoryImages {
  placements: KittyPlacement[];
  notices: HistoryImageNotice[];
}

const placementIds = new WeakMap<object, Map<number, number>>();
/** Owners for the extra placements of an image split around covers, by image index. */
const pieceOwners = new WeakMap<object, Map<number, object>>();
let nextPlacementId = 1;

/** Stable placement id for one rendered occurrence of an image. */
export function placementIdFor(owner: object, index: number): number {
  let byIndex = placementIds.get(owner);
  if (!byIndex) {
    byIndex = new Map();
    placementIds.set(owner, byIndex);
  }
  let id = byIndex.get(index);
  if (id === undefined) {
    id = nextPlacementId;
    nextPlacementId = nextPlacementId >= 0x7fffffff ? 1 : nextPlacementId + 1;
    byIndex.set(index, id);
  }
  return id;
}

interface VisibleImageRow {
  screenRow: number;
  screenCol: number;
  imageRow: number;
}

function blocked(rect: ScreenRect, row: number, left: number, right: number): boolean {
  return row >= rect.top && row <= rect.bottom && left <= rect.right && right >= rect.left;
}

/** The longest run of consecutive image rows on consecutive screen rows. */
function longestRun(rows: VisibleImageRow[]): VisibleImageRow[] {
  let best: VisibleImageRow[] = [];
  let current: VisibleImageRow[] = [];
  for (const row of rows) {
    const previous = current[current.length - 1];
    if (previous
      && row.screenRow === previous.screenRow + 1
      && row.imageRow === previous.imageRow + 1
      && row.screenCol === previous.screenCol) {
      current.push(row);
    } else {
      current = [row];
    }
    if (current.length > best.length) best = current;
  }
  return best;
}

/** The parts of `rect` outside `cover`: bands above and below, then the sides. */
function uncovered(rect: ScreenRect, cover: ScreenRect): ScreenRect[] {
  if (cover.top > rect.bottom || cover.bottom < rect.top || cover.left > rect.right || cover.right < rect.left) return [rect];
  const pieces: ScreenRect[] = [];
  const top = Math.max(rect.top, cover.top);
  const bottom = Math.min(rect.bottom, cover.bottom);
  if (rect.top < cover.top) pieces.push({ ...rect, bottom: cover.top - 1 });
  if (rect.left < cover.left) pieces.push({ top, bottom, left: rect.left, right: cover.left - 1 });
  if (rect.right > cover.right) pieces.push({ top, bottom, left: cover.right + 1, right: rect.right });
  if (rect.bottom > cover.bottom) pieces.push({ ...rect, top: cover.bottom + 1 });
  return pieces;
}

function pieceOwner(owner: object, index: number): object {
  let byIndex = pieceOwners.get(owner);
  if (!byIndex) {
    byIndex = new Map();
    pieceOwners.set(owner, byIndex);
  }
  let piece = byIndex.get(index);
  if (!piece) {
    piece = {};
    byIndex.set(index, piece);
  }
  return piece;
}

/** Placements for the image rows on screen, each cropped to what is visible. */
export function collectHistoryImagePlacements(options: CollectHistoryImagesOptions): KittyPlacement[] {
  return collectHistoryImages(options).placements;
}

/** Fetch the thumbnails just off screen, so scrolling finds them ready. */
function prefetchNearby(options: CollectHistoryImagesOptions): void {
  let first = Infinity;
  let last = -Infinity;
  for (const row of options.viewportRows) {
    if (!row) continue;
    first = Math.min(first, row.lineIndex);
    last = Math.max(last, row.lineIndex);
  }
  if (first > last) return;
  const margin = options.prefetchLines ?? options.viewportRows.length;
  const seen = new Set<InlineImageLayout>();
  const visit = (lineIndex: number) => {
    for (const image of options.lineAnchors[lineIndex]?.images ?? []) {
      if ("kitty" in image.layout || seen.has(image.layout)) continue;
      seen.add(image.layout);
      kittyThumbnail(image.layout.source);
    }
  };
  // Nearest first: the fetch queue runs in order.
  for (let distance = 1; distance <= margin; distance++) {
    if (last + distance < options.lineAnchors.length) visit(last + distance);
    if (first - distance >= 0) visit(first - distance);
  }
}

function covered(rects: readonly ScreenRect[], row: number, left: number, right: number): boolean {
  return rects.some(rect => blocked(rect, row, left, right));
}

/** Placements for the image rows on screen, plus notices for those still without pixels. */
export function collectHistoryImages(options: CollectHistoryImagesOptions): CollectedHistoryImages {
  const visible = new Map<HistoryImageLayout, VisibleImageRow[]>();
  /** Columns a thumbnail's notice may use: its row to the right edge when it is alone on the row. */
  const noticeWidths = new Map<HistoryImageLayout, number>();
  options.viewportRows.forEach((viewportRow, index) => {
    if (!viewportRow) return;
    const screenRow = options.messageAreaStart + index;
    const anchorImages = options.lineAnchors[viewportRow.lineIndex]?.images ?? [];
    for (const image of anchorImages) {
      if (image.layout.rows <= 0 || (options.mathOnly && !("kitty" in image.layout))) continue;
      const screenCol = options.chatCol + image.layout.col - viewportRow.startCol + viewportRow.displayPrefixWidth;
      const right = screenCol + image.layout.cols - 1;
      if (screenCol < options.chatCol || right > options.maxCol) continue;
      if (options.obstructions.some(rect => blocked(rect, screenRow, screenCol, right))) continue;
      const rows = visible.get(image.layout) ?? [];
      rows.push({ screenRow, screenCol, imageRow: image.row });
      visible.set(image.layout, rows);
      if (!noticeWidths.has(image.layout)) {
        noticeWidths.set(image.layout, anchorImages.length === 1 ? options.maxCol - screenCol + 1 : image.layout.cols);
      }
    }
  });

  const cursorImage = options.cursorLineIndex == null
    ? null
    : imageHitAt(options.lineAnchors[options.cursorLineIndex]?.openImages, options.cursorCol ?? 0)?.layout;
  const placements: KittyPlacement[] = [];
  const notices: HistoryImageNotice[] = [];
  const covers = [...options.obstructions, ...(options.covers ?? [])];
  for (const [layout, rows] of visible) {
    let image: KittyImageData;
    if ("kitty" in layout) {
      image = layout.kitty;
    } else {
      const preview = kittyThumbnail(layout.source, { urgent: true });
      if (preview.phase !== "ready") {
        const [first] = rows;
        const text = imageStatus(preview, Math.max(layout.cols, noticeWidths.get(layout) ?? 0));
        if (!covered(covers, first.screenRow, first.screenCol, first.screenCol + termWidth(text) - 1)) {
          notices.push({ row: first.screenRow, col: first.screenCol, text });
        }
        continue;
      }
      image = preview.value;
    }
    const run = longestRun(rows);
    if (run.length === 0) continue;
    const visibleRect = {
      top: run[0].screenRow,
      bottom: run[run.length - 1].screenRow,
      left: run[0].screenCol,
      right: run[0].screenCol + layout.cols - 1,
    };
    const pieces = (options.covers ?? []).reduce<ScreenRect[]>(
      (remaining, cover) => remaining.flatMap(piece => uncovered(piece, cover)),
      [visibleRect],
    );
    pieces.forEach((piece, pieceIndex) => {
      const firstRow = run[0].imageRow + piece.top - visibleRect.top;
      const pieceRows = piece.bottom - piece.top + 1;
      const firstCol = piece.left - visibleRect.left;
      const columns = piece.right - piece.left + 1;
      const sourceY = Math.round((firstRow * image.pixelHeight) / layout.rows);
      const sourceBottom = Math.round(((firstRow + pieceRows) * image.pixelHeight) / layout.rows);
      const sourceX = Math.round((firstCol * image.pixelWidth) / layout.cols);
      const sourceRight = Math.round(((firstCol + columns) * image.pixelWidth) / layout.cols);
      const wholeHeight = firstRow === 0 && pieceRows === layout.rows;
      const wholeWidth = columns === layout.cols;
      placements.push({
        image,
        placementId: pieceIndex === 0
          ? placementIdFor(layout.owner, layout.index)
          : placementIdFor(pieceOwner(layout.owner, layout.index), pieceIndex),
        row: piece.top,
        col: piece.left,
        columns,
        rows: pieceRows,
        ...(wholeHeight ? {} : { sourceY, sourceHeight: Math.max(1, sourceBottom - sourceY) }),
        ...(wholeWidth ? {} : { sourceX, sourceWidth: Math.max(1, sourceRight - sourceX) }),
        ...("kitty" in layout ? { z: MATH_IMAGE_Z } : {}),
        ...(cursorImage === layout ? { selected: true } : {}),
      });
    });
  }
  if (!options.mathOnly) prefetchNearby(options);
  return { placements, notices };
}

// ── Per-screen terminal state ───────────────────────────────────────

const syncs = new WeakMap<object, KittyImageSync>();

function syncFor(owner: object): KittyImageSync {
  let sync = syncs.get(owner);
  if (!sync) {
    sync = new KittyImageSync();
    syncs.set(owner, sync);
  }
  return sync;
}

export function historyImagesPlaced(owner: object): boolean {
  return syncs.get(owner)?.hasPlacements() ?? false;
}

/** Protocol payload reconciling the terminal with `placements`. */
export function syncHistoryImages(owner: object, placements: readonly KittyPlacement[]): string {
  if (placements.length === 0 && !syncs.has(owner)) return "";
  return syncFor(owner).sync(placements);
}

/** After a resize the terminal reflowed its grid: re-send every placement. */
export function invalidateHistoryImagePlacements(owner: object): void {
  syncs.get(owner)?.invalidatePlacements();
}

/**
 * Handle a graphics reply. Placements report failures only (q=1); ENOENT
 * means the terminal evicted the image, so it is transmitted again.
 * Returns true when the reply was consumed.
 */
export function handleHistoryImageResponse(owner: object, sequence: string): boolean {
  const reply = parseKittyGraphicsResponse(sequence);
  if (!reply) return false;
  if (reply.message.startsWith("ENOENT")) syncs.get(owner)?.forgetImage(reply.imageId);
  return true;
}

/** Payload removing every image this screen sent (on exit). */
export function disposeHistoryImages(owner: object): string {
  const sync = syncs.get(owner);
  syncs.delete(owner);
  return sync?.dispose() ?? "";
}
