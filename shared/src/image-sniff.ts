/**
 * Identify PNG/JPEG/GIF/WebP images and their pixel size from header bytes.
 * Never trusts a file name or a declared media type.
 */

import { createHash } from "node:crypto";
import type { ImageMediaType } from "./messages";

/** Content id of an image: sha256 (hex) of its bytes. Daemon and clients agree on it. */
export function imageIdForBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface SniffedImage {
  mediaType: ImageMediaType;
  width: number;
  height: number;
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    // SOF0..SOF15 except DHT (c4), JPG (c8), DAC (cc) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (chunk === "VP8 ") {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

/** Identify a PNG/JPEG/GIF/WebP by its header. Never trusts the file name. */
export function sniffImage(data: Uint8Array): SniffedImage | null {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let mediaType: ImageMediaType | null = null;
  let size: { width: number; height: number } | null = null;
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString("ascii", 12, 16) === "IHDR") {
    mediaType = "image/png";
    size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mediaType = "image/jpeg";
    size = jpegDimensions(bytes);
  } else if (bytes.length >= 10 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")) {
    mediaType = "image/gif";
    size = { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  } else if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    mediaType = "image/webp";
    size = webpDimensions(bytes);
  }
  if (!mediaType || !size || size.width <= 0 || size.height <= 0) return null;
  return { mediaType, ...size };
}
