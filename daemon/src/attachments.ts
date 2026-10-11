/**
 * Daemon-managed image storage for images shown in conversation history.
 *
 * Model-attached images (the attach tool) are copied into a content-addressed
 * store under the instance data directory, so history never depends on the
 * live filesystem: `<dataDir>/attachments/<sha256>.<ext>`. Large inputs are
 * downscaled once on the way in, which bounds storage and preview work.
 *
 * Clients never receive the stored bytes directly. They ask for a preview
 * (`get_image`): a PNG bounded to the pixels they will draw, or raw RGBA at
 * an exact size for character-cell fallbacks. Previews are produced by
 * ImageMagick and kept in a small in-memory LRU.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { basename, join } from "node:path";
import { dataDir } from "@exocortex/shared/paths";
import type { ImageMediaType, ImageRef } from "./messages";
import { imageIdForBytes, sniffImage } from "@exocortex/shared/image-sniff";

export { imageIdForBytes, sniffImage, type SniffedImage } from "@exocortex/shared/image-sniff";

/** Largest file the attach tool reads. */
export const MAX_ATTACH_INPUT_BYTES = 32 * 1024 * 1024;
/** Stored images are downscaled to fit this box... */
export const MAX_STORED_DIMENSION = 4096;
/** ...and re-encoded when larger than this. */
export const MAX_STORED_BYTES = 8 * 1024 * 1024;
/** Upper bound for any preview a client may request. */
export const MAX_PREVIEW_DIMENSION = 4096;
/** rgba previews are for character cells: a few hundred pixels at most. */
export const MAX_RGBA_PREVIEW_PIXELS = 512 * 512;
const PREVIEW_CACHE_BYTES = 64 * 1024 * 1024;
const MAGICK_TIMEOUT_MS = 30_000;

const IMAGE_ID_PATTERN = /^[0-9a-f]{64}$/;

const EXTENSIONS: Record<ImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function attachmentsDir(): string {
  return join(dataDir(), "attachments");
}

export function isImageId(value: unknown): value is string {
  return typeof value === "string" && IMAGE_ID_PATTERN.test(value);
}

// ── ImageMagick ────────────────────────────────────────────────────

let activeMagick = 0;
const magickWaiters: Array<() => void> = [];
const MAX_CONCURRENT_MAGICK = 2;

async function withMagickSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeMagick >= MAX_CONCURRENT_MAGICK) await new Promise<void>(resolve => magickWaiters.push(resolve));
  activeMagick++;
  try {
    return await fn();
  } finally {
    activeMagick--;
    magickWaiters.shift()?.();
  }
}

/** Run `magick <args>` with `input` on stdin; resolves with stdout. */
function runMagick(args: string[], input: Uint8Array): Promise<Buffer> {
  return withMagickSlot(async () => {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["magick", ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      throw new Error(`ImageMagick is required to process images: ${error instanceof Error ? error.message : String(error)}`);
    }
    const timer = setTimeout(() => proc.kill("SIGKILL"), MAGICK_TIMEOUT_MS);
    try {
      const stdin = proc.stdin as import("bun").FileSink;
      stdin.write(input);
      await stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).arrayBuffer(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) throw new Error(stderr.trim().split("\n")[0] || `ImageMagick exited with code ${exitCode}`);
      return Buffer.from(stdout);
    } finally {
      clearTimeout(timer);
    }
  });
}

/** Input spec for magick reading the first frame of `mediaType` from stdin. */
function magickInput(mediaType: ImageMediaType): string {
  return `${EXTENSIONS[mediaType] === "jpg" ? "jpeg" : EXTENSIONS[mediaType]}:-[0]`;
}

// ── Store ──────────────────────────────────────────────────────────

export interface StoredImage {
  path: string;
  mediaType: ImageMediaType;
}

function storedPath(id: string, mediaType: ImageMediaType): string {
  return join(attachmentsDir(), `${id}.${EXTENSIONS[mediaType]}`);
}

/** Locate a stored image by id. */
export function findStoredImage(id: string): StoredImage | null {
  if (!isImageId(id)) return null;
  for (const mediaType of Object.keys(EXTENSIONS) as ImageMediaType[]) {
    const path = storedPath(id, mediaType);
    if (existsSync(path)) return { path, mediaType };
  }
  return null;
}

/** Write bytes into the content-addressed store (idempotent). */
export function putImageBytes(bytes: Buffer, mediaType: ImageMediaType): string {
  const id = imageIdForBytes(bytes);
  const path = storedPath(id, mediaType);
  if (!existsSync(path)) {
    mkdirSync(attachmentsDir(), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, bytes, { mode: 0o600 });
    renameSync(temp, path);
  }
  return id;
}

/**
 * Copy one local image file into the store and describe it. Images above the
 * stored size bounds are downscaled (PNG stays PNG, others become JPEG).
 */
export async function storeImageFile(path: string, name = basename(path)): Promise<ImageRef> {
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.size === 0) throw new Error("file is empty");
  if (stat.size > MAX_ATTACH_INPUT_BYTES) {
    throw new Error(`file is ${(stat.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ATTACH_INPUT_BYTES / 1024 / 1024} MB`);
  }
  let bytes: Buffer = readFileSync(path);
  let sniffed = sniffImage(bytes);
  if (!sniffed) throw new Error("not a PNG, JPEG, GIF, or WebP image");

  const oversized = sniffed.width > MAX_STORED_DIMENSION || sniffed.height > MAX_STORED_DIMENSION;
  if (oversized || bytes.length > MAX_STORED_BYTES) {
    const output = sniffed.mediaType === "image/png" ? "png" : "jpeg";
    const resized = await runMagick([
      magickInput(sniffed.mediaType), "-auto-orient",
      "-resize", `${MAX_STORED_DIMENSION}x${MAX_STORED_DIMENSION}>`,
      ...(output === "jpeg" ? ["-quality", "88"] : []),
      "-strip", `${output}:-`,
    ], bytes);
    const resniffed = sniffImage(resized);
    if (!resniffed) throw new Error("image could not be converted");
    if (resized.length > MAX_STORED_BYTES && output === "png") {
      const jpeg = await runMagick(["png:-", "-background", "white", "-flatten", "-quality", "88", "jpeg:-"], resized);
      const jpegSniffed = sniffImage(jpeg);
      if (!jpegSniffed) throw new Error("image could not be converted");
      bytes = jpeg;
      sniffed = jpegSniffed;
    } else {
      bytes = resized;
      sniffed = resniffed;
    }
  } else {
    // Decode once so a truncated or hostile file is rejected at attach time
    // rather than surfacing later as a broken preview.
    await runMagick([magickInput(sniffed.mediaType), "-format", "%w", "info:-"], bytes);
  }

  const id = putImageBytes(bytes, sniffed.mediaType);
  return {
    id,
    mediaType: sniffed.mediaType,
    width: sniffed.width,
    height: sniffed.height,
    sizeBytes: bytes.length,
    ...(name ? { name: name.slice(0, 200) } : {}),
  };
}

/** Copy stored images referenced by an export into `destination`. */
export function copyStoredImages(ids: Iterable<string>, destination: string): string[] {
  const copied: string[] = [];
  for (const id of new Set(ids)) {
    const stored = findStoredImage(id);
    if (!stored) continue;
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const target = join(destination, basename(stored.path));
    copyFileSync(stored.path, target);
    copied.push(basename(stored.path));
  }
  return copied;
}

// ── Previews ───────────────────────────────────────────────────────

export interface ImagePreviewRequest {
  format: "png" | "rgba";
  width: number;
  height: number;
}

export interface ImagePreview {
  format: "png" | "rgba";
  width: number;
  height: number;
  data: Buffer;
}

const previewCache = new Map<string, ImagePreview>();
let previewCacheBytes = 0;

function rememberPreview(key: string, preview: ImagePreview): void {
  previewCache.set(key, preview);
  previewCacheBytes += preview.data.length;
  for (const [oldKey, old] of previewCache) {
    if (previewCacheBytes <= PREVIEW_CACHE_BYTES) break;
    previewCache.delete(oldKey);
    previewCacheBytes -= old.data.length;
  }
}

export function validatePreviewRequest(request: ImagePreviewRequest): string | null {
  if (request.format !== "png" && request.format !== "rgba") return "format must be png or rgba";
  const { width, height } = request;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return "width and height must be positive integers";
  if (width > MAX_PREVIEW_DIMENSION || height > MAX_PREVIEW_DIMENSION) return `width and height must be at most ${MAX_PREVIEW_DIMENSION}`;
  if (request.format === "rgba" && width * height > MAX_RGBA_PREVIEW_PIXELS) return "rgba previews are limited to 512×512 pixels";
  return null;
}

/**
 * Render a preview of `source`. PNG previews fit within the requested box and
 * are never upscaled; RGBA previews are exactly the requested size.
 */
export async function renderImagePreview(
  id: string,
  source: { bytes: Buffer; mediaType: ImageMediaType },
  request: ImagePreviewRequest,
): Promise<ImagePreview> {
  const key = `${id}:${request.format}:${request.width}x${request.height}`;
  const cached = previewCache.get(key);
  if (cached) {
    previewCache.delete(key);
    previewCache.set(key, cached);
    return cached;
  }

  const sniffed = sniffImage(source.bytes);
  let preview: ImagePreview;
  if (request.format === "png") {
    const fits = sniffed && sniffed.width <= request.width && sniffed.height <= request.height;
    if (fits && source.mediaType === "image/png") {
      preview = { format: "png", width: sniffed.width, height: sniffed.height, data: source.bytes };
    } else {
      const data = await runMagick([
        magickInput(source.mediaType), "-auto-orient",
        "-resize", `${request.width}x${request.height}>`,
        "-strip", "png:-",
      ], source.bytes);
      const out = sniffImage(data);
      if (!out) throw new Error("preview conversion produced no PNG");
      preview = { format: "png", width: out.width, height: out.height, data };
    }
  } else {
    const data = await runMagick([
      magickInput(source.mediaType), "-auto-orient",
      "-resize", `${request.width}x${request.height}!`,
      // Character cells are a heavy downscale; sharpen so thin lines (charts,
      // text) survive instead of averaging into the background.
      "-unsharp", "0x1+2+0",
      "-depth", "8", "rgba:-",
    ], source.bytes);
    if (data.length !== request.width * request.height * 4) throw new Error("preview conversion produced the wrong pixel count");
    preview = { format: "rgba", width: request.width, height: request.height, data };
  }
  rememberPreview(key, preview);
  return preview;
}

export const attachmentsInternalsForTest = {
  clearPreviewCache(): void {
    previewCache.clear();
    previewCacheBytes = 0;
  },
};
