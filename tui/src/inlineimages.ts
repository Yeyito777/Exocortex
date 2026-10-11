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
 *   small LRU.
 * - rows: Kitty mode reserves blank rows that the renderer covers with a
 *   terminal placement; the half-block fallback draws the pixels as text.
 */

import type { ImageAttachment, ImageMediaType, ImageRef } from "./messages";
import type { KittyImageData } from "./kittyimages";
import type { TerminalImageMode } from "./terminalgraphics";
import { theme, terminalColorLevel } from "./theme";
import { hexToRgb, rgbToAnsi, type TerminalColorLevel } from "./terminalcolors";
import { log } from "./log";
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
}

export function sourceFromRef(ref: ImageRef, convId: string | null): InlineImageSource {
  return {
    imageId: ref.id,
    ...(convId ? { convId } : {}),
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
}

export interface ImagePreviewResponse {
  format: "png" | "rgba";
  width: number;
  height: number;
  base64: string;
}

export type ImagePreviewFetcher = (request: ImagePreviewRequest) => Promise<ImagePreviewResponse>;

type PreviewEntry =
  | { phase: "loading" }
  | { phase: "error"; error: string; at: number }
  | { phase: "ready"; preview: ImagePreviewResponse; kitty?: KittyImageData; rgba?: Buffer };

const MAX_CACHED_CHARS = 128 * 1024 * 1024;
const MAX_IN_FLIGHT = 3;
const ERROR_RETRY_MS = 5_000;

const previews = new Map<string, PreviewEntry>();
let cachedChars = 0;
let inFlight = 0;
const queued: Array<() => void> = [];
let fetcher: ImagePreviewFetcher | null = null;
let nextKittyId = 0x40000000;

export function configureInlineImages(options: { fetch: ImagePreviewFetcher; onChange: () => void }): void {
  fetcher = options.fetch;
  onChange = options.onChange;
}

function previewKey(request: ImagePreviewRequest): string {
  return `${request.imageId}:${request.format}:${request.width}x${request.height}`;
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
  while (inFlight < MAX_IN_FLIGHT && queued.length > 0) queued.shift()!();
}

function request(request: ImagePreviewRequest): PreviewEntry | null {
  const key = previewKey(request);
  const existing = previews.get(key);
  if (existing && (existing.phase !== "error" || Date.now() - existing.at < ERROR_RETRY_MS)) {
    touch(key, existing);
    return existing;
  }
  if (!fetcher) return null;
  const fetch = fetcher;
  store(key, { phase: "loading" });
  queued.push(() => {
    inFlight++;
    fetch(request).then(preview => {
      store(key, { phase: "ready", preview });
    }, error => {
      const message = error instanceof Error ? error.message : String(error);
      log("warn", `tui: image preview ${request.imageId.slice(0, 12)} failed: ${message}`);
      store(key, { phase: "error", error: message, at: Date.now() });
    }).finally(() => {
      inFlight--;
      runQueued();
      changed();
    });
  });
  runQueued();
  return previews.get(key) ?? null;
}

export type PreviewState<T> = { phase: "loading" } | { phase: "error"; error: string } | { phase: "ready"; value: T };

/** PNG preview for terminal graphics, sized to the cell box it fills. */
export function kittyPreview(source: InlineImageSource, box: InlineImageBox): PreviewState<KittyImageData> {
  const cell = environment.cell;
  const entry = request({
    imageId: source.imageId,
    ...(source.convId ? { convId: source.convId } : {}),
    format: "png",
    width: Math.min(4096, box.cols * cell.width),
    height: Math.min(4096, box.rows * cell.height),
  });
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
  /** Image rows followed by one caption row. */
  lines: string[];
  copy: string[];
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

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
 * History rows for one image: `box.rows` image rows plus a caption. In Kitty
 * mode the image rows stay blank (the placement covers them) once pixels are
 * ready; otherwise the first row explains what is missing.
 */
export function renderInlineImage(
  source: InlineImageSource,
  box: InlineImageBox,
  col: number,
  owner: object,
  index: number,
): RenderedInlineImage {
  const layout: InlineImageLayout = { source, col, cols: box.cols, rows: box.rows, owner, index };
  const indent = " ".repeat(col);
  const caption = `${indent}${theme.dim}${imageCaption(source)}${theme.reset}`;
  const copy = [...Array.from({ length: box.rows }, () => ""), `[image: ${imageCaption(source)}]`];
  const mode = environment.mode;

  if (mode === "off") {
    return { layout: { ...layout, rows: 0 }, lines: [`${indent}${theme.dim}🖼 ${imageCaption(source)}${theme.reset}`], copy: [copy[copy.length - 1]] };
  }

  let status = "";
  if (mode === "kitty") {
    const preview = kittyPreview(source, box);
    if (preview.phase === "ready") {
      return { layout, lines: [...Array.from({ length: box.rows }, () => ""), caption], copy };
    }
    status = preview.phase === "error" ? `⚠ image unavailable: ${preview.error}` : "loading image…";
  } else if (mode === "halfblock") {
    const preview = rgbaPreview(source, box);
    if (preview.phase === "ready") {
      return { layout, lines: [...renderHalfBlockRows(preview.value).map(row => indent + row), caption], copy };
    }
    status = preview.phase === "error" ? `⚠ image unavailable: ${preview.error}` : "loading image…";
  } else {
    status = "loading image…";
  }
  const lines = Array.from({ length: box.rows }, (_, row) => row === 0 ? `${indent}${theme.dim}${status.slice(0, Math.max(1, box.cols + 20))}${theme.reset}` : "");
  return { layout, lines: [...lines, caption], copy };
}

export const inlineImagesInternalsForTest = {
  reset(): void {
    previews.clear();
    cachedChars = 0;
    inFlight = 0;
    queued.length = 0;
    fetcher = null;
    onChange = () => {};
    environment.mode = "pending";
    environment.cell = { width: 8, height: 16 };
    generation = 0;
  },
};
