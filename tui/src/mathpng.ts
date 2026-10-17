/**
 * The `selection-text` PNG chunk of display-math images.
 *
 * st reads an uncompressed iTXt chunk with this keyword as the text the
 * image stands for: a selection touching the placed image copies that text
 * once and highlights the image as one unit. Other terminals and decoders
 * ignore the chunk.
 */

export const SELECTION_TEXT_KEYWORD = "selection-text";

/** `png` with an iTXt `selection-text` chunk holding `text`, inserted after IHDR. */
export function withSelectionText(png: Uint8Array, text: string): Uint8Array {
  // Signature (8) + IHDR chunk (4 length + 4 type + 13 data + 4 CRC).
  const afterHeader = 8 + 25;
  if (png.length < afterHeader || String.fromCharCode(...png.subarray(12, 16)) !== "IHDR") return png;
  const encoder = new TextEncoder();
  // keyword NUL, compression flag 0, method 0, empty language tag NUL, empty translated keyword NUL, text.
  const data = new Uint8Array([...encoder.encode(SELECTION_TEXT_KEYWORD), 0, 0, 0, 0, 0, ...encoder.encode(text)]);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(encoder.encode("iTXt"), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, Bun.hash.crc32(chunk.subarray(4, 8 + data.length)) >>> 0);
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, afterHeader));
  out.set(chunk, afterHeader);
  out.set(png.subarray(afterHeader), afterHeader + chunk.length);
  return out;
}

/** The `selection-text` of a PNG, if it has one (for tests and diagnostics). */
export function selectionTextOf(png: Uint8Array): string | null {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const decoder = new TextDecoder();
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = view.getUint32(offset);
    const type = decoder.decode(png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "iTXt" && decoder.decode(data.subarray(0, SELECTION_TEXT_KEYWORD.length)) === SELECTION_TEXT_KEYWORD) {
      return decoder.decode(data.subarray(SELECTION_TEXT_KEYWORD.length + 5));
    }
    offset += 12 + length;
  }
  return null;
}
