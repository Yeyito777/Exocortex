import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(bytes: Buffer, start: number, end: number): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = start; i < end; i++) {
    c = table[(c ^ bytes[i]) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function isStrictBase64(value: string): boolean {
  return value.length > 0
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
    && !/=/.test(value.slice(0, -2));
}

function ascii(bytes: Buffer, start: number, end: number): string {
  return bytes.subarray(start, end).toString("ascii");
}

function isValidPng(bytes: Buffer): boolean {
  if (bytes.length < PNG_SIGNATURE.length + 12) return false;
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;

  let offset = PNG_SIGNATURE.length;
  let sawIHDR = false;
  let sawIDAT = false;
  let sawIEND = false;
  const idatChunks: Buffer[] = [];

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return false;
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (length > bytes.length - offset - 12 || crcEnd > bytes.length) return false;

    const type = ascii(bytes, typeStart, dataStart);
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    if (crc32(bytes, typeStart, dataEnd) !== expectedCrc) return false;

    if (!sawIHDR) {
      if (type !== "IHDR" || length !== 13 || offset !== PNG_SIGNATURE.length) return false;
      const width = bytes.readUInt32BE(dataStart);
      const height = bytes.readUInt32BE(dataStart + 4);
      if (width === 0 || height === 0) return false;
      sawIHDR = true;
    } else if (type === "IHDR") {
      return false;
    }

    if (type === "IDAT") {
      if (sawIEND) return false;
      sawIDAT = true;
      idatChunks.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (length !== 0 || !sawIDAT) return false;
      sawIEND = true;
      offset = crcEnd;
      break;
    }

    offset = crcEnd;
  }

  if (!sawIHDR || !sawIDAT || !sawIEND || offset !== bytes.length) return false;

  try {
    // Concatenated IDAT chunks form one zlib stream. We do not need to unfilter
    // scanlines here; zlib integrity is enough to catch corrupt payloads that
    // have a valid PNG signature/header but cannot actually be decoded.
    inflateSync(Buffer.concat(idatChunks));
    return true;
  } catch {
    return false;
  }
}

function isValidJpeg(bytes: Buffer): boolean {
  return bytes.length >= 4
    && bytes.subarray(0, 2).equals(JPEG_SOI)
    && bytes.subarray(bytes.length - 2).equals(JPEG_EOI);
}

function isValidGif(bytes: Buffer): boolean {
  if (bytes.length < 14) return false;
  const header = ascii(bytes, 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return false;
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  return width > 0 && height > 0 && bytes[bytes.length - 1] === 0x3b;
}

function isValidWebp(bytes: Buffer): boolean {
  if (bytes.length < 16) return false;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") return false;
  const declaredSize = bytes.readUInt32LE(4);
  if (declaredSize + 8 !== bytes.length) return false;
  const chunkType = ascii(bytes, 12, 16);
  return chunkType === "VP8 " || chunkType === "VP8L" || chunkType === "VP8X";
}

export function isValidImagePayload(mediaType: string, base64: string): boolean {
  if (!isStrictBase64(base64)) return false;

  const bytes = Buffer.from(base64, "base64");
  switch (mediaType) {
    case "image/png":
      return isValidPng(bytes);
    case "image/jpeg":
      return isValidJpeg(bytes);
    case "image/gif":
      return isValidGif(bytes);
    case "image/webp":
      return isValidWebp(bytes);
    default:
      return false;
  }
}
