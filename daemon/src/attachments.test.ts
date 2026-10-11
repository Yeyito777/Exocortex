import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ATTACH_INPUT_BYTES,
  MAX_STORED_DIMENSION,
  attachmentsDir,
  attachmentsInternalsForTest,
  copyStoredImages,
  findStoredImage,
  imageIdForBytes,
  renderImagePreview,
  sniffImage,
  storeImageFile,
  validatePreviewRequest,
} from "./attachments";

let dir: string;

function magick(args: string[]): void {
  const proc = Bun.spawnSync(["magick", ...args], { stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "exo-attachments-"));
  magick(["-size", "64x32", "gradient:red-blue", join(dir, "chart.png")]);
  magick(["-size", "40x20", "xc:green", join(dir, "photo.jpg")]);
  magick(["-size", "30x10", "xc:yellow", join(dir, "anim.gif")]);
  magick(["-size", "24x12", "xc:purple", join(dir, "art.webp")]);
  magick(["-size", "5000x100", "xc:white", join(dir, "wide.png")]);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sniffImage", () => {
  test("identifies each supported format and its size from headers", () => {
    expect(sniffImage(readFileSync(join(dir, "chart.png")))).toEqual({ mediaType: "image/png", width: 64, height: 32 });
    expect(sniffImage(readFileSync(join(dir, "photo.jpg")))).toEqual({ mediaType: "image/jpeg", width: 40, height: 20 });
    expect(sniffImage(readFileSync(join(dir, "anim.gif")))).toEqual({ mediaType: "image/gif", width: 30, height: 10 });
    expect(sniffImage(readFileSync(join(dir, "art.webp")))).toEqual({ mediaType: "image/webp", width: 24, height: 12 });
  });

  test("rejects non-images and truncated headers", () => {
    expect(sniffImage(Buffer.from("hello world, not an image"))).toBeNull();
    expect(sniffImage(readFileSync(join(dir, "chart.png")).subarray(0, 12))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe("storeImageFile", () => {
  test("copies into content-addressed storage and describes the image", async () => {
    const ref = await storeImageFile(join(dir, "chart.png"));
    const bytes = readFileSync(join(dir, "chart.png"));
    expect(ref).toEqual({
      id: imageIdForBytes(bytes),
      mediaType: "image/png",
      width: 64,
      height: 32,
      sizeBytes: bytes.length,
      name: "chart.png",
    });
    const stored = findStoredImage(ref.id)!;
    expect(stored.path).toBe(join(attachmentsDir(), `${ref.id}.png`));
    expect(readFileSync(stored.path).equals(bytes)).toBe(true);
    expect(statSync(stored.path).mode & 0o777).toBe(0o600);
  });

  test("is idempotent and survives the source file changing", async () => {
    const path = join(dir, "mutable.png");
    writeFileSync(path, readFileSync(join(dir, "chart.png")));
    const first = await storeImageFile(path);
    const second = await storeImageFile(path);
    expect(second.id).toBe(first.id);
    writeFileSync(path, "overwritten");
    expect(readFileSync(findStoredImage(first.id)!.path).length).toBe(first.sizeBytes);
  });

  test("downscales images beyond the stored dimension bound", async () => {
    const ref = await storeImageFile(join(dir, "wide.png"));
    expect(ref.mediaType).toBe("image/png");
    expect(ref.width).toBe(MAX_STORED_DIMENSION);
    expect(ref.height).toBeLessThanOrEqual(100);
    expect(sniffImage(readFileSync(findStoredImage(ref.id)!.path))?.width).toBe(MAX_STORED_DIMENSION);
  });

  test("rejects files that are not images, empty, directories, or too large", async () => {
    const text = join(dir, "notes.png");
    writeFileSync(text, "definitely text");
    await expect(storeImageFile(text)).rejects.toThrow("not a PNG, JPEG, GIF, or WebP image");

    const empty = join(dir, "empty.png");
    writeFileSync(empty, "");
    await expect(storeImageFile(empty)).rejects.toThrow("file is empty");

    const folder = join(dir, "folder.png");
    mkdirSync(folder);
    await expect(storeImageFile(folder)).rejects.toThrow("not a regular file");

    const huge = join(dir, "huge.png");
    writeFileSync(huge, readFileSync(join(dir, "chart.png")));
    truncateSync(huge, MAX_ATTACH_INPUT_BYTES + 1);
    await expect(storeImageFile(huge)).rejects.toThrow("the limit is 32 MB");

    await expect(storeImageFile(join(dir, "missing.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects a file whose header looks valid but whose data is corrupt", async () => {
    const corrupt = join(dir, "corrupt.png");
    const bytes = readFileSync(join(dir, "chart.png"));
    writeFileSync(corrupt, Buffer.concat([bytes.subarray(0, 40), Buffer.alloc(40, 0x55)]));
    await expect(storeImageFile(corrupt)).rejects.toThrow();
  });
});

describe("previews", () => {
  test("validates request bounds", () => {
    expect(validatePreviewRequest({ format: "png", width: 100, height: 100 })).toBeNull();
    expect(validatePreviewRequest({ format: "png", width: 0, height: 100 })).toContain("positive");
    expect(validatePreviewRequest({ format: "png", width: 5000, height: 100 })).toContain("at most 4096");
    expect(validatePreviewRequest({ format: "rgba", width: 1000, height: 1000 })).toContain("512×512");
    expect(validatePreviewRequest({ format: "bmp" as "png", width: 1, height: 1 })).toContain("format");
  });

  test("png previews fit the box without upscaling; rgba previews are exact", async () => {
    attachmentsInternalsForTest.clearPreviewCache();
    const ref = await storeImageFile(join(dir, "chart.png"));
    const stored = findStoredImage(ref.id)!;
    const source = { bytes: readFileSync(stored.path), mediaType: stored.mediaType };

    const small = await renderImagePreview(ref.id, source, { format: "png", width: 32, height: 32 });
    expect(small.format).toBe("png");
    expect([small.width, small.height]).toEqual([32, 16]);
    expect(sniffImage(small.data)).toEqual({ mediaType: "image/png", width: 32, height: 16 });

    const large = await renderImagePreview(ref.id, source, { format: "png", width: 1000, height: 1000 });
    expect([large.width, large.height]).toEqual([64, 32]);
    expect(large.data.equals(source.bytes)).toBe(true);

    const pixels = await renderImagePreview(ref.id, source, { format: "rgba", width: 8, height: 6 });
    expect([pixels.width, pixels.height, pixels.data.length]).toEqual([8, 6, 8 * 6 * 4]);
    // Leftmost column of the red→blue gradient is red-dominant and opaque.
    expect(pixels.data[0]).toBeGreaterThan(pixels.data[2]);
    expect(pixels.data[3]).toBe(255);
  });

  test("converts JPEG and WebP sources to PNG", async () => {
    for (const name of ["photo.jpg", "art.webp", "anim.gif"]) {
      const ref = await storeImageFile(join(dir, name));
      const stored = findStoredImage(ref.id)!;
      const preview = await renderImagePreview(ref.id, { bytes: readFileSync(stored.path), mediaType: stored.mediaType }, { format: "png", width: 100, height: 100 });
      expect(sniffImage(preview.data)?.mediaType).toBe("image/png");
    }
  });
});

test("copyStoredImages exports referenced files and skips unknown ids", async () => {
  const ref = await storeImageFile(join(dir, "photo.jpg"));
  const out = join(dir, "export");
  expect(copyStoredImages([ref.id, ref.id, "0".repeat(64), "not-an-id"], out)).toEqual([`${ref.id}.jpg`]);
  expect(existsSync(join(out, `${ref.id}.jpg`))).toBe(true);
});
