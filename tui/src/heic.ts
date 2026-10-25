import { spawnSync } from "node:child_process";
import type { ImageAttachment } from "./messages";

// Prefer the original photo to a PNG preview/file icon offered alongside it.
export const HEIC_MIME_TYPES = ["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"] as const;
export const MAX_HEIC_BYTES = 50 * 1024 * 1024;
/** Raw bytes that stay within a provider's 5 MB of base64 per image. */
export const MAX_PASSTHROUGH_IMAGE_BYTES = 3 * 1024 * 1024;

export function isHeicPath(path: string): boolean {
  return /\.hei[cf]$/i.test(path);
}

/** Paths an image file copied in a file manager may have. */
export function isImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|jpe|gif|webp|hei[cf]|hif|avif|tiff?|bmp)$/i.test(path);
}

/** Decode locally; HEIC is not a provider-supported image payload. */
export function convertHeic(bytes: Buffer, run: typeof spawnSync = spawnSync): ImageAttachment {
  return convertImage(bytes, run, "heic");
}

/**
 * Decode any image ImageMagick reads (the first frame), turned upright by its
 * EXIF orientation and fitted to 2000 px, into a provider-safe JPEG.
 */
export function convertImage(bytes: Buffer, run: typeof spawnSync = spawnSync, format?: "heic"): ImageAttachment {
  const kind = format === "heic" ? "HEIC" : "Image";
  if (bytes.length === 0 || bytes.length > MAX_HEIC_BYTES) {
    throw new Error(`${kind} image is empty or exceeds the 50 MB limit`);
  }
  // Force the HEIC decoder, select the primary/first image (not thumbnails or
  // auxiliary depth images), and honor camera orientation before resizing.
  const result = run("magick", [
    format === "heic" ? "heic:-[0]" : "-[0]", "-auto-orient", "-resize", "2000x2000>",
    "-background", "white", "-alpha", "remove", "-strip", "-quality", "85", "jpeg:-",
  ], { input: bytes, timeout: 10_000, maxBuffer: 5 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(format === "heic"
      ? "Could not decode HEIC/HEIF photo. ImageMagick with libheif support is required."
      : "Could not decode the image file. ImageMagick is required for this format.");
  }
  const jpeg = Buffer.from(result.stdout);
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8
    || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9
    || jpeg.toString("base64").length > 5 * 1024 * 1024) {
    throw new Error(`${kind} conversion did not produce a provider-safe JPEG`);
  }
  return { mediaType: "image/jpeg", base64: jpeg.toString("base64"), sizeBytes: jpeg.length };
}

/** EXIF orientation of a JPEG (1 = upright), read from its APP1 segment. */
export function jpegOrientation(jpeg: Buffer): number {
  let offset = 2;
  while (offset + 4 <= jpeg.length && jpeg[offset] === 0xff) {
    const marker = jpeg[offset + 1];
    const length = jpeg.readUInt16BE(offset + 2);
    if (marker === 0xda || length < 2) break;
    const start = offset + 4;
    if (marker === 0xe1 && jpeg.toString("latin1", start, start + 6) === "Exif\0\0") {
      const tiff = start + 6;
      if (tiff + 8 > jpeg.length) return 1;
      const little = jpeg.toString("latin1", tiff, tiff + 2) === "II";
      const u16 = (at: number) => little ? jpeg.readUInt16LE(at) : jpeg.readUInt16BE(at);
      const u32 = (at: number) => little ? jpeg.readUInt32LE(at) : jpeg.readUInt32BE(at);
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > jpeg.length) return 1;
      const entries = u16(ifd);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > jpeg.length) return 1;
        if (u16(entry) === 0x0112) return u16(entry + 8) || 1;
      }
      return 1;
    }
    offset = start + length - 2;
  }
  return 1;
}
