import { spawnSync } from "node:child_process";
import type { ImageAttachment } from "./messages";

// Prefer the original photo to a PNG preview/file icon offered alongside it.
export const HEIC_MIME_TYPES = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"] as const;
export const MAX_HEIC_BYTES = 50 * 1024 * 1024;

export function isHeicPath(path: string): boolean {
  return /\.hei[cf]$/i.test(path);
}

/** Decode locally; HEIC is not a provider-supported image payload. */
export function convertHeic(bytes: Buffer, run: typeof spawnSync = spawnSync): ImageAttachment {
  if (bytes.length === 0 || bytes.length > MAX_HEIC_BYTES) {
    throw new Error("HEIC image is empty or exceeds the 50 MB limit");
  }
  // Force the HEIC decoder, select the primary/first image (not thumbnails or
  // auxiliary depth images), and honor camera orientation before resizing.
  const result = run("magick", [
    "heic:-[0]", "-auto-orient", "-resize", "2000x2000>",
    "-background", "white", "-alpha", "remove", "-strip", "-quality", "85", "jpeg:-",
  ], { input: bytes, timeout: 10_000, maxBuffer: 5 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error("Could not decode HEIC/HEIF photo. ImageMagick with libheif support is required.");
  }
  const jpeg = Buffer.from(result.stdout);
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8
    || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9
    || jpeg.toString("base64").length > 5 * 1024 * 1024) {
    throw new Error("HEIC conversion did not produce a provider-safe JPEG");
  }
  return { mediaType: "image/jpeg", base64: jpeg.toString("base64"), sizeBytes: jpeg.length };
}
