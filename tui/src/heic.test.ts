import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { HEIC_BYTES } from "../../test/heic-fixture";
import { convertHeic, isHeicPath, MAX_HEIC_BYTES } from "./heic";

test("decodes the HEIC photo, not its auxiliary image, into a bounded JPEG", () => {
  const image = convertHeic(HEIC_BYTES);
  expect(image.mediaType).toBe("image/jpeg");
  const result = spawnSync("magick", [
    "jpeg:-", "-depth", "8", "rgb:-",
  ], { input: Buffer.from(image.base64, "base64") });
  expect(result.status).toBe(0);
  expect(result.stdout.length).toBe(64 * 32 * 3);
  const left = (16 * 64 + 8) * 3;
  const right = (16 * 64 + 56) * 3;
  expect(result.stdout[left]).toBeGreaterThan(240);
  expect(result.stdout[left + 1]).toBeLessThan(15);
  expect(result.stdout[left + 2]).toBeLessThan(15);
  expect(result.stdout[right]).toBeLessThan(15);
  expect(result.stdout[right + 1]).toBeLessThan(15);
  expect(result.stdout[right + 2]).toBeGreaterThan(240);
});

test("rejects malformed, empty and oversized HEIC rather than passing it to a provider", () => {
  expect(() => convertHeic(Buffer.from("not a photo"))).toThrow("libheif");
  expect(() => convertHeic(Buffer.alloc(0))).toThrow("empty");
  expect(() => convertHeic(Buffer.alloc(MAX_HEIC_BYTES + 1))).toThrow("50 MB");
});

test("recognizes HEIC and HEIF file extensions case-insensitively", () => {
  expect(isHeicPath("/tmp/photo.HEIC")).toBe(true);
  expect(isHeicPath("/tmp/photo.heif")).toBe(true);
  expect(isHeicPath("/tmp/photo.heic.png")).toBe(false);
});

test("explains a missing HEIC decoder", () => {
  const run = (() => ({ status: null, error: new Error("ENOENT") })) as unknown as typeof spawnSync;
  expect(() => convertHeic(HEIC_BYTES, run)).toThrow("ImageMagick with libheif");
});
