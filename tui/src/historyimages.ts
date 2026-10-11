/**
 * Terminal placements for inline history images (Kitty graphics mode).
 *
 * History rendering reserves blank rows for each image and tags them with a
 * line anchor. After the viewport is composed, this module finds the image
 * rows actually on screen, crops each image to its visible, unobstructed run
 * of rows, and reconciles the terminal through KittyImageSync. Placements are
 * recomputed every frame from scratch, so scrolling, resizing, switching
 * conversations, and overlays can never leave a stale image behind.
 */

import type { RenderLineAnchor } from "./conversation";
import { kittyPreview, type InlineImageLayout } from "./inlineimages";
import { KittyImageSync, type KittyPlacement } from "./kittyimages";
import { parseKittyGraphicsResponse } from "./terminalgraphics";

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
  /** Screen regions drawn on top of history (task panel and the like). */
  obstructions: readonly ScreenRect[];
}

const placementIds = new WeakMap<object, Map<number, number>>();
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

/** Placements for the image rows on screen, each cropped to what is visible. */
export function collectHistoryImagePlacements(options: CollectHistoryImagesOptions): KittyPlacement[] {
  const visible = new Map<InlineImageLayout, VisibleImageRow[]>();
  options.viewportRows.forEach((viewportRow, index) => {
    if (!viewportRow) return;
    const image = options.lineAnchors[viewportRow.lineIndex]?.image;
    if (!image || image.layout.rows <= 0) return;
    const screenRow = options.messageAreaStart + index;
    const screenCol = options.chatCol + image.layout.col - viewportRow.startCol + viewportRow.displayPrefixWidth;
    const right = screenCol + image.layout.cols - 1;
    if (screenCol < options.chatCol || right > options.maxCol) return;
    if (options.obstructions.some(rect => blocked(rect, screenRow, screenCol, right))) return;
    const rows = visible.get(image.layout) ?? [];
    rows.push({ screenRow, screenCol, imageRow: image.row });
    visible.set(image.layout, rows);
  });

  const placements: KittyPlacement[] = [];
  for (const [layout, rows] of visible) {
    const preview = kittyPreview(layout.source, { cols: layout.cols, rows: layout.rows });
    if (preview.phase !== "ready") continue;
    const run = longestRun(rows);
    if (run.length === 0) continue;
    const image = preview.value;
    const first = run[0].imageRow;
    const complete = first === 0 && run.length === layout.rows;
    const sourceY = Math.round((first * image.pixelHeight) / layout.rows);
    const sourceEnd = Math.round(((first + run.length) * image.pixelHeight) / layout.rows);
    placements.push({
      image,
      placementId: placementIdFor(layout.owner, layout.index),
      row: run[0].screenRow,
      col: run[0].screenCol,
      columns: layout.cols,
      rows: run.length,
      ...(complete ? {} : { sourceY, sourceHeight: Math.max(1, sourceEnd - sourceY) }),
    });
  }
  return placements;
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
