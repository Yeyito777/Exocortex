import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { read } from "./read";

const VALID_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

let tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tmpDirs = [];
});

async function tempFile(name: string, bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "exocortex-read-test-"));
  tmpDirs.push(dir);
  const filePath = join(dir, name);
  await writeFile(filePath, bytes);
  return filePath;
}

function corruptFirstPngIdatByte(base64: string): Buffer {
  const bytes = Buffer.from(base64, "base64");
  let offset = 8; // PNG signature
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") {
      const dataStart = offset + 8;
      bytes[dataStart + Math.min(2, Math.max(0, length - 1))] ^= 0xff;
      return bytes;
    }
    offset += 12 + length;
  }
  throw new Error("fixture PNG has no IDAT chunk");
}

describe("read tool image validation", () => {
  test("returns provider image data for a valid PNG", async () => {
    const filePath = await tempFile("valid.png", Buffer.from(VALID_PNG, "base64"));

    const result = await read.execute({ file_path: filePath });

    expect(result.isError).toBe(false);
    expect(result.image).toEqual({ mediaType: "image/png", base64: VALID_PNG });
    expect(result.output).toContain("Read image:");
  });

  test("does not attach corrupt PNG data even when the file has a PNG header", async () => {
    const filePath = await tempFile("corrupt.png", corruptFirstPngIdatByte(VALID_PNG));

    const result = await read.execute({ file_path: filePath });

    expect(result.isError).toBe(true);
    expect(result.image).toBeUndefined();
    expect(result.output).toContain("not sent to the provider");
  });
});
