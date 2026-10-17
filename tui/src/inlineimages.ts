/**
 * Inline images in conversation history.
 *
 * Both model-attached images (ImageRef on attach tool results) and
 * user-pasted images (ImageAttachment) render through this module:
 *
 * - layout: an image occupies a fixed cell box derived from its pixel size,
 *   the terminal's cell size, and the available width. The box is the same in
 *   every render mode, so switching modes or loading pixels never shifts text.
 * - store: previews are fetched lazily from the daemon (`get_image`) at the
 *   size they will be drawn, which bounds traffic over SSH, and kept in a
 *   small LRU. A pasted PNG whose bytes the TUI already holds (its own local
 *   echo, or history that still carries the payload) goes to Kitty terminals
 *   as is, with no round trip.
 * - rows: Kitty mode reserves blank rows that the renderer covers with a
 *   terminal placement; the half-block fallback draws the pixels as text.
 * - strips: a message with several images lays them out side by side; those
 *   that don't fit hide behind a `› +N` that opens the viewer on them.
 */

import type { ImageAttachment, ImageMediaType, ImageRef } from "./messages";
import type { KittyImageData } from "./kittyimages";
import type { TerminalImageMode } from "./terminalgraphics";
import { theme, terminalColorLevel } from "./theme";
import { hexToRgb, rgbToAnsi, type TerminalColorLevel } from "./terminalcolors";
import { log } from "./log";
import { termWidth, truncateToWidth } from "./textwidth";
import { imageIdForBytes, sniffImage } from "@exocortex/shared/image-sniff";

// ── Sources ─────────────────────────────────────────────────────────

export interface InlineImageSource {
  /** sha256 of the image bytes; the daemon's preview key. */
  imageId: string;
  /** Conversation that holds a pasted image's bytes. */
  convId?: string;
  width: number;
  height: number;
  mediaType: ImageMediaType;
  sizeBytes: number;
  name?: string;
  /** Base64 bytes already in hand (a pasted image's payload), drawable without the daemon. */
  localBase64?: string;
}

/**
 * An attached image lives only in the daemon's store, so it carries no
 * conversation: its "not found" is final, not a paste the daemon has yet to
 * store (which is retried).
 */
export function sourceFromRef(ref: ImageRef): InlineImageSource {
  return {
    imageId: ref.id,
    width: ref.width,
    height: ref.height,
    mediaType: ref.mediaType,
    sizeBytes: ref.sizeBytes,
    ...(ref.name ? { name: ref.name } : {}),
  };
}

const attachmentIds = new WeakMap<ImageAttachment, string | null>();

function attachmentImageId(image: ImageAttachment): string | null {
  if (image.imageId) return image.imageId;
  let id = attachmentIds.get(image);
  if (id === undefined) {
    // Older history projections carry bytes but no id; recent entries do.
    id = image.base64 ? imageIdForBytes(Buffer.from(image.base64, "base64")) : null;
    attachmentIds.set(image, id);
  }
  return id;
}

const attachmentSizes = new WeakMap<ImageAttachment, { width: number; height: number } | null>();

function attachmentSize(image: ImageAttachment): { width: number; height: number } | null {
  if (image.width && image.height) return { width: image.width, height: image.height };
  let size = attachmentSizes.get(image);
  if (size === undefined) {
    // A local echo has bytes but no daemon-projected size; headers suffice.
    const sniffed = image.base64 ? sniffImage(Buffer.from(image.base64.slice(0, 512 * 1024), "base64")) : null;
    size = sniffed ? { width: sniffed.width, height: sniffed.height } : null;
    attachmentSizes.set(image, size);
  }
  return size;
}

/** A pasted image, or null when it can't be fetched (no id and no bytes) or has no known size. */
export function sourceFromAttachment(image: ImageAttachment, convId: string | null): InlineImageSource | null {
  const imageId = attachmentImageId(image);
  const size = attachmentSize(image);
  if (!imageId || !size) return null;
  return {
    imageId,
    ...(convId ? { convId } : {}),
    width: size.width,
    height: size.height,
    mediaType: image.mediaType,
    sizeBytes: image.sizeBytes,
    ...(image.base64 ? { localBase64: image.base64 } : {}),
  };
}

// ── Layout ──────────────────────────────────────────────────────────

export interface CellSize {
  width: number;
  height: number;
}

export interface InlineImageBox {
  cols: number;
  rows: number;
}

/** Fit an image into at most maxCols × maxRows cells, never enlarging it past its pixels. */
export function fitImageBox(
  image: { width: number; height: number },
  maxCols: number,
  maxRows: number,
  cell: CellSize,
): InlineImageBox {
  const cols = Math.max(1, Math.floor(maxCols));
  const rows = Math.max(1, Math.floor(maxRows));
  const scale = Math.min(1, (cols * cell.width) / image.width, (rows * cell.height) / image.height);
  return {
    cols: Math.max(1, Math.min(cols, Math.round((image.width * scale) / cell.width))),
    rows: Math.max(1, Math.min(rows, Math.round((image.height * scale) / cell.height))),
  };
}

/** Inline images are thumbnails; Enter or a click opens the full-size viewer. */
export const INLINE_IMAGE_MAX_COLUMNS = 56;
export const INLINE_IMAGE_MAX_ROWS = 12;

/** Box limits for history thumbnails, from the chat width and terminal height. */
export function historyImageLimits(availableWidth: number, terminalRows: number): InlineImageBox {
  return {
    cols: Math.max(4, Math.min(availableWidth - 4, INLINE_IMAGE_MAX_COLUMNS)),
    rows: Math.max(3, Math.min(INLINE_IMAGE_MAX_ROWS, Math.floor((terminalRows - 8) / 2))),
  };
}

// ── Display environment ─────────────────────────────────────────────

interface InlineImageEnvironment {
  mode: TerminalImageMode;
  cell: CellSize;
}

const environment: InlineImageEnvironment = {
  mode: "pending",
  cell: { width: 8, height: 16 },
};
let generation = 0;
let onChange: () => void = () => {};
let onFirstEnabled: () => void = () => {};
/** The connected daemon's `experimental.images` flag, from its bootstrap. */
let daemonEnabled = false;
let everEnabled = false;

export function inlineImageMode(): TerminalImageMode {
  return environment.mode;
}

export function inlineImageCellSize(): CellSize {
  return environment.cell;
}

/** Changes whenever image rows may render differently (mode, cell size, pixels arriving). */
export function inlineImageGeneration(): number {
  return generation;
}

function changed(): void {
  generation++;
  onChange();
}

/** Follow the connected daemon's `experimental.images` flag. */
export function setInlineImagesEnabled(enabled: boolean): void {
  if (daemonEnabled === enabled) return;
  daemonEnabled = enabled;
  if (enabled && !everEnabled) {
    everEnabled = true;
    onFirstEnabled();
  }
  changed();
}

/**
 * Whether history shows images at all. Off unless the daemon enables the
 * experiment; EXOCORTEX_TUI_IMAGES=off turns it off locally. When off, history
 * renders as it did before inline images (pasted images keep their badge).
 */
export function inlineImagesActive(): boolean {
  return daemonEnabled && environment.mode !== "off";
}

export function setInlineImageMode(mode: TerminalImageMode): void {
  if (environment.mode === mode) return;
  environment.mode = mode;
  changed();
}

export function setInlineImageCellSize(cell: CellSize): void {
  if (environment.cell.width === cell.width && environment.cell.height === cell.height) return;
  environment.cell = { ...cell };
  changed();
}

// ── Preview store ───────────────────────────────────────────────────

export interface ImagePreviewRequest {
  imageId: string;
  convId?: string;
  format: "png" | "rgba";
  width: number;
  height: number;
  /** A history thumbnail: the daemon may trade exact colours for bytes (the viewer gets the full image). */
  purpose?: "thumbnail";
}

export interface ImagePreviewResponse {
  format: "png" | "rgba";
  width: number;
  height: number;
  base64: string;
}

export type ImagePreviewFetcher = (request: ImagePreviewRequest) => Promise<ImagePreviewResponse>;

type PreviewEntry =
  | { phase: "loading"; retries?: number }
  /** `retryAt` is Infinity for failures only a new connection can change (missing image, bad data). */
  | { phase: "error"; error: string; retryAt: number }
  | { phase: "ready"; preview: ImagePreviewResponse; kitty?: KittyImageData; rgba?: Buffer };

const MAX_CACHED_CHARS = 128 * 1024 * 1024;
const MAX_IN_FLIGHT = 3;
const NETWORK_RETRY_MS = 5_000;
/**
 * Backoff for failures that are expected to clear on their own. A just-sent
 * pasted image is "not found" until the daemon has stored its message, which
 * can take a few seconds on a large conversation; until the retries run out it
 * shows as loading rather than unavailable.
 */
const TRANSIENT_RETRY_MS = [250, 500, 1_000, 2_000, 4_000];
/**
 * Larger local payloads are fetched as a bounded preview instead. The limit is
 * tighter when the terminal itself is at the far end of an SSH session, where
 * every transmitted byte crosses the network.
 */
const MAX_LOCAL_KITTY_CHARS = process.env.SSH_TTY || process.env.SSH_CONNECTION ? 1024 * 1024 : 16 * 1024 * 1024;
/**
 * Local bytes stand in for a preview only when the terminal would not have to
 * shrink them much: a full-resolution screenshot behind a thumbnail costs the
 * terminal a full decode (and on st's OpenGL backend, one every time it
 * scrolls into view) and its memory for pixels nobody sees.
 */
const MAX_LOCAL_AREA_RATIO = 4;
/** Kitty terminals reject larger images (st: 8192 px), and then every placement would fail. */
const MAX_KITTY_DIMENSION = 8192;

const previews = new Map<string, PreviewEntry>();
let cachedChars = 0;
let inFlight = 0;
const queued: Array<{ key: string; run: () => void }> = [];
let fetcher: ImagePreviewFetcher | null = null;
let nextKittyId = 0x40000000;
const retryTimers = new Set<ReturnType<typeof setTimeout>>();

export function configureInlineImages(options: {
  fetch: ImagePreviewFetcher;
  onChange: () => void;
  /** Called once, when a daemon first enables images (start terminal detection then). */
  onFirstEnabled?: () => void;
}): void {
  fetcher = options.fetch;
  onChange = options.onChange;
  onFirstEnabled = options.onFirstEnabled ?? (() => {});
  if (everEnabled) onFirstEnabled();
}

function previewKey(request: ImagePreviewRequest): string {
  return `${request.imageId}:${request.format}:${request.width}x${request.height}${request.purpose ? `:${request.purpose}` : ""}`;
}

function entryChars(entry: PreviewEntry): number {
  return entry.phase === "ready" ? entry.preview.base64.length : 0;
}

function touch(key: string, entry: PreviewEntry): void {
  previews.delete(key);
  previews.set(key, entry);
}

function store(key: string, entry: PreviewEntry): void {
  const previous = previews.get(key);
  if (previous) cachedChars -= entryChars(previous);
  previews.delete(key);
  previews.set(key, entry);
  cachedChars += entryChars(entry);
  for (const [oldKey, old] of previews) {
    if (cachedChars <= MAX_CACHED_CHARS) break;
    if (old.phase === "loading" || oldKey === key) continue;
    previews.delete(oldKey);
    cachedChars -= entryChars(old);
  }
}

function runQueued(): void {
  while (inFlight < MAX_IN_FLIGHT && queued.length > 0) queued.shift()!.run();
}

function isTransientFailure(message: string, request: ImagePreviewRequest): boolean {
  // Only a pasted image (looked up in its conversation) can be not-yet-stored.
  return (Boolean(request.convId) && /image not found/.test(message)) || isNetworkFailure(message);
}

function isNetworkFailure(message: string): boolean {
  return /timed out|disconnected|not connected/i.test(message);
}

/**
 * Pixels only change how history lines read in the half-block fallback; a
 * Kitty preview is drawn by placement, so its arrival needs a new frame but
 * not a history re-render.
 */
function previewSettled(request: ImagePreviewRequest): void {
  if (request.format === "rgba") changed();
  else onChange();
}

function enqueueFetch(key: string, request: ImagePreviewRequest, fetch: ImagePreviewFetcher, retries: number, urgent = false): void {
  const run = () => {
    inFlight++;
    fetch(request).then(preview => {
      store(key, { phase: "ready", preview });
    }, error => {
      const message = error instanceof Error ? error.message : String(error);
      const delay = TRANSIENT_RETRY_MS[retries];
      if (delay !== undefined && isTransientFailure(message, request)) {
        store(key, { phase: "loading", retries: retries + 1 });
        const timer = setTimeout(() => {
          retryTimers.delete(timer);
          // Dropped (evicted or reset) entries are fetched again on demand.
          const entry = previews.get(key);
          if (entry?.phase === "loading" && entry.retries === retries + 1) enqueueFetch(key, request, fetch, retries + 1);
          runQueued();
        }, delay);
        timer.unref?.();
        retryTimers.add(timer);
        return;
      }
      log("warn", `tui: image preview ${request.imageId.slice(0, 12)} failed: ${message}`);
      store(key, { phase: "error", error: message, retryAt: isNetworkFailure(message) ? Date.now() + NETWORK_RETRY_MS : Infinity });
    }).finally(() => {
      inFlight--;
      runQueued();
      previewSettled(request);
    });
  };
  if (urgent) queued.unshift({ key, run });
  else queued.push({ key, run });
}

/** Move a queued fetch to the front: it is on screen now. */
function prioritize(key: string): void {
  const index = queued.findIndex(item => item.key === key);
  if (index > 0) queued.unshift(...queued.splice(index, 1));
}

function request(request: ImagePreviewRequest, urgent = false, peek = false): PreviewEntry | null {
  const key = previewKey(request);
  const existing = previews.get(key);
  if (existing && (existing.phase !== "error" || Date.now() < existing.retryAt)) {
    touch(key, existing);
    if (urgent && existing.phase === "loading") prioritize(key);
    return existing;
  }
  if (!fetcher || peek) return null;
  store(key, { phase: "loading", retries: 0 });
  enqueueFetch(key, request, fetcher, 0, urgent);
  runQueued();
  return previews.get(key) ?? null;
}

/**
 * Ask again for previews that failed: a (re)connected daemon may have what
 * the previous one did not (another endpoint, a restored store).
 */
export function retryFailedImagePreviews(): void {
  let dropped = false;
  for (const [key, entry] of previews) {
    if (entry.phase !== "error") continue;
    previews.delete(key);
    dropped = true;
  }
  if (dropped) changed();
}

/** A pasted PNG's own bytes, ready for Kitty when the terminal can draw them at about `pixels` without waste. */
function localKittyEntry(source: InlineImageSource, pixels: { width: number; height: number }): PreviewEntry | null {
  const base64 = source.localBase64;
  if (!base64 || source.mediaType !== "image/png" || base64.length > MAX_LOCAL_KITTY_CHARS) return null;
  if (source.width > MAX_KITTY_DIMENSION || source.height > MAX_KITTY_DIMENSION) return null;
  if (source.width * source.height > MAX_LOCAL_AREA_RATIO * pixels.width * pixels.height) return null;
  const key = `${source.imageId}:local`;
  const existing = previews.get(key);
  if (existing) {
    touch(key, existing);
    return existing;
  }
  store(key, { phase: "ready", preview: { format: "png", width: source.width, height: source.height, base64 } });
  return previews.get(key) ?? null;
}

export type PreviewState<T> = { phase: "loading" } | { phase: "error"; error: string } | { phase: "ready"; value: T };

export interface PreviewOptions {
  /** On screen now: fetch ahead of prefetches. */
  urgent?: boolean;
  /** Only what is already here: never start a fetch. */
  peek?: boolean;
  purpose?: "thumbnail";
}

/** PNG preview for terminal graphics, sized to the cell box it fills. */
export function kittyPreview(source: InlineImageSource, box: InlineImageBox, options: PreviewOptions = {}): PreviewState<KittyImageData> {
  const cell = environment.cell;
  const width = Math.min(4096, box.cols * cell.width);
  const height = Math.min(4096, box.rows * cell.height);
  const entry = localKittyEntry(source, { width, height }) ?? request({
    imageId: source.imageId,
    ...(source.convId ? { convId: source.convId } : {}),
    format: "png",
    width,
    height,
    ...(options.purpose ? { purpose: options.purpose } : {}),
  }, options.urgent, options.peek);
  if (!entry || entry.phase === "loading") return { phase: "loading" };
  if (entry.phase === "error") return { phase: "error", error: entry.error };
  if (entry.preview.format !== "png") return { phase: "error", error: "unexpected preview format" };
  entry.kitty ??= {
    kittyId: nextKittyId >= 0x7ffffff0 ? (nextKittyId = 0x40000000) : nextKittyId++,
    base64: entry.preview.base64,
    pixelWidth: entry.preview.width,
    pixelHeight: entry.preview.height,
  };
  return { phase: "ready", value: entry.kitty };
}

/**
 * The cell box a history thumbnail is fetched for: the largest it is ever
 * drawn at for this cell size. Narrow panes, short terminals and strips draw
 * it smaller (the terminal scales it down), so resizing never fetches again.
 */
export function thumbnailFetchBox(source: Pick<InlineImageSource, "width" | "height">): InlineImageBox {
  return fitImageBox(source, INLINE_IMAGE_MAX_COLUMNS, INLINE_IMAGE_MAX_ROWS, environment.cell);
}

/** The PNG a history thumbnail draws, fetched at the size of its largest box. */
export function kittyThumbnail(source: InlineImageSource, options: Omit<PreviewOptions, "purpose"> = {}): PreviewState<KittyImageData> {
  return kittyPreview(source, thumbnailFetchBox(source), { ...options, purpose: "thumbnail" });
}

/** RGBA pixels for the half-block fallback: one column per cell, two rows per cell. */
export function rgbaPreview(source: InlineImageSource, box: InlineImageBox): PreviewState<{ width: number; height: number; data: Buffer }> {
  const width = box.cols;
  const height = box.rows * 2;
  const entry = request({
    imageId: source.imageId,
    ...(source.convId ? { convId: source.convId } : {}),
    format: "rgba",
    width,
    height,
  });
  if (!entry || entry.phase === "loading") return { phase: "loading" };
  if (entry.phase === "error") return { phase: "error", error: entry.error };
  entry.rgba ??= Buffer.from(entry.preview.base64, "base64");
  if (entry.preview.format !== "rgba" || entry.rgba.length !== width * height * 4) {
    return { phase: "error", error: "unexpected preview format" };
  }
  return { phase: "ready", value: { width, height, data: entry.rgba } };
}

// ── Row rendering ───────────────────────────────────────────────────

/** One rendered image in history; anchors of its rows point at it. */
export interface InlineImageLayout {
  source: InlineImageSource;
  /** 0-based column of the image's left edge within the history line. */
  col: number;
  cols: number;
  rows: number;
  /** Stable identity of this occurrence, for its terminal placement id. */
  owner: object;
  index: number;
}

export interface RenderedInlineImage {
  layout: InlineImageLayout;
  /** One row per image row; the first carries a status while there are no pixels. */
  lines: string[];
  copy: string[];
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Name (or type), size, and bytes: the viewer's title and what a yank of the image copies. */
export function imageCaption(source: InlineImageSource): string {
  const kind = source.mediaType.slice("image/".length).toUpperCase();
  return [source.name ?? kind, `${source.width}×${source.height}`, formatSize(source.sizeBytes)].join(" · ");
}

function blend(channel: number, alpha: number, background: number): number {
  return Math.round((channel * alpha + background * (255 - alpha)) / 255);
}

/** Draw RGBA pixels as `▀` cells: foreground is the upper pixel, background the lower. */
export function renderHalfBlockRows(
  pixels: { width: number; height: number; data: Buffer },
  background: [number, number, number] = hexToRgb(theme.previewColors[2]),
  level: TerminalColorLevel = terminalColorLevel,
): string[] {
  const rows: string[] = [];
  const { width, data } = pixels;
  for (let y = 0; y + 1 < pixels.height; y += 2) {
    let line = "";
    let lastFg = "";
    let lastBg = "";
    for (let x = 0; x < width; x++) {
      const top = (y * width + x) * 4;
      const bottom = ((y + 1) * width + x) * 4;
      const fg = rgbToAnsi(38,
        blend(data[top], data[top + 3], background[0]),
        blend(data[top + 1], data[top + 3], background[1]),
        blend(data[top + 2], data[top + 3], background[2]),
        level);
      const bg = rgbToAnsi(48,
        blend(data[bottom], data[bottom + 3], background[0]),
        blend(data[bottom + 1], data[bottom + 3], background[1]),
        blend(data[bottom + 2], data[bottom + 3], background[2]),
        level);
      if (fg !== lastFg) line += fg;
      if (bg !== lastBg) line += bg;
      lastFg = fg;
      lastBg = bg;
      line += "▀";
    }
    rows.push(`${line}\x1b[0m`);
  }
  return rows;
}

/**
 * The loading or error notice drawn in place of missing pixels, cut to `width`
 * terminal columns: history rows are drawn as is, so a longer notice would
 * run past the pane and wrap into the sidebar.
 */
export function imageStatus(preview: PreviewState<unknown> | null, width: number): string {
  const text = preview?.phase === "error"
    ? `⚠ image unavailable: ${preview.error.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")}`
    : "loading image…";
  return truncateToWidth(text, Math.max(1, width));
}

/**
 * History rows for one image: `box.rows` rows, no caption (the viewer shows
 * its name and size). In Kitty mode the rows are always blank: the placement
 * covers them, and the frame draws a loading or error notice over them until
 * it can (historyimages.ts), so pixels arriving never re-render history and
 * only images near the screen are fetched. Otherwise the first row explains
 * what is missing in at most `statusWidth` columns.
 */
export function renderInlineImage(
  source: InlineImageSource,
  box: InlineImageBox,
  col: number,
  owner: object,
  index: number,
  statusWidth = box.cols,
): RenderedInlineImage {
  const layout: InlineImageLayout = { source, col, cols: box.cols, rows: box.rows, owner, index };
  const indent = " ".repeat(col);
  const copy = Array.from({ length: box.rows }, (_, row) => row === 0 ? `[image: ${imageCaption(source)}]` : "");
  const blank = () => Array.from({ length: box.rows }, () => "");

  let preview: PreviewState<unknown> | null = null;
  if (environment.mode === "kitty") {
    return { layout, lines: blank(), copy };
  } else if (environment.mode === "halfblock") {
    const pixels = rgbaPreview(source, box);
    if (pixels.phase === "ready") return { layout, lines: renderHalfBlockRows(pixels.value).map(row => indent + row), copy };
    preview = pixels;
  }
  const lines = blank();
  lines[0] = `${indent}${theme.dim}${imageStatus(preview, statusWidth)}${theme.reset}`;
  return { layout, lines, copy };
}

// ── Strips ──────────────────────────────────────────────────────────

/** The images of one message, in order, and the one to show; the viewer pages through them. */
export interface InlineImageTarget {
  images: readonly InlineImageSource[];
  index: number;
}

/** Columns of a history row that open an image: a thumbnail or a strip's `› +N`. */
export interface InlineImageHit {
  start: number;
  end: number;
  target: InlineImageTarget;
  /** The thumbnail this hit is, tinted while the history cursor is on it. */
  layout?: InlineImageLayout;
}

/**
 * The image a column of a row opens. The history cursor takes the nearest hit
 * (it can rest between thumbnails); a click must land on one.
 */
export function imageHitAt(hits: readonly InlineImageHit[] | undefined, col: number, exact = false): InlineImageHit | null {
  let best: InlineImageHit | null = null;
  let bestDistance = Infinity;
  for (const hit of hits ?? []) {
    const distance = col < hit.start ? hit.start - col : col >= hit.end ? col - hit.end + 1 : 0;
    if (distance < bestDistance) {
      best = hit;
      bestDistance = distance;
    }
  }
  return exact && bestDistance > 0 ? null : best;
}

const STRIP_GAP = 2;
/** Blank image cells: invisible, but not whitespace to the history cursor, so it can cross the strip. */
const IMAGE_CELL = "\u00a0";

function overflowLabel(hidden: number): string {
  return `› +${hidden}`;
}

export interface InlineImageStripLayout {
  /** Thumbnails that fit, from the left. The rest are behind the overflow label. */
  boxes: InlineImageBox[];
  /** Left edge and width of each visible thumbnail, from the strip's left. */
  slots: Array<{ start: number; width: number }>;
  rows: number;
  overflow: { start: number; label: string } | null;
  width: number;
}

/**
 * Lay out several images side by side within `maxWidth` columns. Each is
 * fitted to the thumbnail limits on its own, so images of one shape share a
 * height; the strip is as tall as its tallest. When they don't all fit, as
 * many as do are shown, followed by an overflow label (at least one image is
 * always shown, shrunk if it must be).
 */
export function layoutInlineImageStrip(
  images: readonly { width: number; height: number }[],
  limits: InlineImageBox,
  maxWidth: number,
  cell: CellSize,
): InlineImageStripLayout {
  const fitted = images.map(image => fitImageBox(image, limits.cols, limits.rows, cell));
  const slotWidth = (box: InlineImageBox) => box.cols;
  const widthOf = (count: number) => fitted.slice(0, count).reduce((sum, box, index) => sum + slotWidth(box) + (index > 0 ? STRIP_GAP : 0), 0);

  let count = images.length;
  let boxes = fitted;
  let widths = fitted.map(slotWidth);
  if (widthOf(count) > maxWidth) {
    const room = (shown: number) => maxWidth - STRIP_GAP - termWidth(overflowLabel(images.length - shown));
    count = images.length - 1;
    while (count > 0 && widthOf(count) > room(count)) count--;
    if (count === 0) {
      count = 1;
      const width = Math.max(1, room(1));
      boxes = [fitImageBox(images[0], width, limits.rows, cell)];
      widths = [Math.min(width, slotWidth(boxes[0]))];
    }
    boxes = boxes.slice(0, count);
    widths = widths.slice(0, count);
  }

  const slots: InlineImageStripLayout["slots"] = [];
  let width = 0;
  for (const slot of widths) {
    if (slots.length > 0) width += STRIP_GAP;
    slots.push({ start: width, width: slot });
    width += slot;
  }
  let overflow: InlineImageStripLayout["overflow"] = null;
  if (count < images.length) {
    overflow = { start: width + STRIP_GAP, label: overflowLabel(images.length - count) };
    width = overflow.start + termWidth(overflow.label);
  }
  return { boxes, slots, rows: Math.max(...boxes.map(box => box.rows)), overflow, width };
}

/**
 * A thumbnail's image rows, each exactly `box.cols` wide (a status notice in
 * the first while it has no pixels; Kitty's is drawn by the frame instead).
 */
function stripImageRows(source: InlineImageSource, box: InlineImageBox): string[] {
  const blanks = Array.from({ length: box.rows }, () => IMAGE_CELL.repeat(box.cols));
  let preview: PreviewState<unknown> | null = null;
  if (environment.mode === "kitty") {
    return blanks;
  } else if (environment.mode === "halfblock") {
    const pixels = rgbaPreview(source, box);
    if (pixels.phase === "ready") return renderHalfBlockRows(pixels.value);
    preview = pixels;
  }
  const status = imageStatus(preview, box.cols);
  blanks[0] = `${theme.dim}${status}${theme.reset}${IMAGE_CELL.repeat(Math.max(0, box.cols - termWidth(status)))}`;
  return blanks;
}

export interface RenderedInlineImageStrip {
  layouts: InlineImageLayout[];
  /** One row per strip row, no captions (the viewer shows each image's name and size). */
  lines: string[];
  copy: string[];
  /** The thumbnails covering each image row, and which of their rows it is. */
  rowImages: Array<Array<{ layout: InlineImageLayout; row: number }>>;
  /** Columns of every strip row that open an image. */
  hits: InlineImageHit[];
}

/**
 * History rows for a strip starting at column `col`. Thumbnails sit on a
 * common baseline; the overflow label is centered beside them and opens the
 * first hidden image.
 */
export function renderInlineImageStrip(
  items: readonly { source: InlineImageSource; owner: object; index: number }[],
  strip: InlineImageStripLayout,
  col: number,
): RenderedInlineImageStrip {
  const images = items.map(item => item.source);
  const layouts = strip.boxes.map((box, index): InlineImageLayout => ({
    source: items[index].source,
    col: col + strip.slots[index].start,
    cols: box.cols,
    rows: box.rows,
    owner: items[index].owner,
    index: items[index].index,
  }));
  const hits: InlineImageHit[] = layouts.map((layout, index) => ({
    start: layout.col,
    end: layout.col + strip.slots[index].width,
    target: { images, index },
    layout,
  }));
  if (strip.overflow) {
    const start = col + strip.overflow.start;
    hits.push({ start, end: start + termWidth(strip.overflow.label), target: { images, index: layouts.length } });
  }

  const indent = " ".repeat(col);
  const overflowRow = Math.floor((strip.rows - 1) / 2);
  const pixels = layouts.map(layout => stripImageRows(layout.source, { cols: layout.cols, rows: layout.rows }));
  const lines: string[] = [];
  const rowImages: RenderedInlineImageStrip["rowImages"] = [];
  for (let row = 0; row < strip.rows; row++) {
    const covering: Array<{ layout: InlineImageLayout; row: number }> = [];
    let line = indent;
    layouts.forEach((layout, index) => {
      if (index > 0) line += " ".repeat(STRIP_GAP);
      const imageRow = row - (strip.rows - layout.rows);
      const width = strip.slots[index].width;
      if (imageRow < 0) {
        line += " ".repeat(width);
        return;
      }
      covering.push({ layout, row: imageRow });
      line += (pixels[index][imageRow] ?? "") + " ".repeat(width - layout.cols);
    });
    if (strip.overflow && row === overflowRow) line += `${" ".repeat(STRIP_GAP)}${theme.accent}${strip.overflow.label}${theme.reset}`;
    lines.push(line.replace(/ +$/, ""));
    rowImages.push(covering);
  }
  const copy = lines.map((_, row) => row === 0 ? images.map(source => `[image: ${imageCaption(source)}]`).join(" ") : "");
  return { layouts, lines, copy, rowImages, hits };
}

export const inlineImagesInternalsForTest = {
  /** Back to process start: no daemon has enabled images yet. */
  resetToStartup(): void {
    this.reset();
    daemonEnabled = false;
    everEnabled = false;
  },
  reset(): void {
    for (const timer of retryTimers) clearTimeout(timer);
    retryTimers.clear();
    previews.clear();
    cachedChars = 0;
    inFlight = 0;
    queued.length = 0;
    fetcher = null;
    onChange = () => {};
    environment.mode = "pending";
    environment.cell = { width: 8, height: 16 };
    generation = 0;
    onFirstEnabled = () => {};
    daemonEnabled = true;
    everEnabled = true;
  },
};
