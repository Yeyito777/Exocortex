import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const SAMPLE_BYTES = 8192;

/** Bounded, best-effort text detection. Never read directories or block on a FIFO. */
export function isEditableTextFile(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return false;
    const sample = Buffer.alloc(SAMPLE_BYTES);
    const length = readSync(fd, sample, 0, sample.length, 0);
    const bytes = sample.subarray(0, length);
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
    // A sample may end in the middle of a character; a complete file may not.
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: length === SAMPLE_BYTES });
    if (text.includes("\0")) return false;
    const controls = text.match(/[\u0001-\u0008\u000b\u000e-\u001f\u007f]/g)?.length ?? 0;
    return controls <= text.length * 0.01;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
