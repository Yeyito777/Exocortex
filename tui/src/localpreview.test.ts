import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { renderLocalPreview, resetLocalPreviewToolsForTest } from "./localpreview";
import { sniffImage } from "@exocortex/shared/image-sniff";

afterEach(() => resetLocalPreviewToolsForTest());

// A phone-screenshot-shaped image: 1179×2556 with detail, so the PNG is not trivial.
const screenshot = spawnSync("magick", ["-size", "1179x2556", "gradient:red-blue", "png:-"], { maxBuffer: 64 * 1024 * 1024 }).stdout as Buffer;

test("fits a phone screenshot into its thumbnail box", async () => {
  const preview = await renderLocalPreview(screenshot.toString("base64"), "image/png", { format: "png", width: 200, height: 432, purpose: "thumbnail" });
  const out = sniffImage(Buffer.from(preview.base64, "base64"));
  expect(out?.mediaType).toBe("image/png");
  expect(preview.height).toBe(432);
  expect(preview.width).toBeLessThanOrEqual(200);
  expect(out).toMatchObject({ width: preview.width, height: preview.height });
});

test("renders exact-size RGBA for half-block cells", async () => {
  const jpeg = spawnSync("magick", ["-size", "64x32", "xc:red", "jpeg:-"]).stdout as Buffer;
  const preview = await renderLocalPreview(jpeg.toString("base64"), "image/jpeg", { format: "rgba", width: 8, height: 6 });
  expect(Buffer.from(preview.base64, "base64").length).toBe(8 * 6 * 4);
});

test("falls back to sips on a Mac without ImageMagick, and remembers magick is missing", async () => {
  const calls: string[][] = [];
  const png = Buffer.from(spawnSync("magick", ["-size", "10x5", "xc:blue", "png:-"]).stdout as Buffer);
  const exec = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    if (command === "magick") throw Object.assign(new Error("spawn magick ENOENT"), { code: "ENOENT" });
    await Bun.write(args[args.length - 1], png);
    return Buffer.alloc(0);
  };
  const request = { format: "png" as const, width: 200, height: 432 };
  const preview = await renderLocalPreview(screenshot.toString("base64"), "image/png", request, { exec, platform: "darwin" });
  expect(preview).toMatchObject({ format: "png", width: 10, height: 5 });
  // 1179×2556 into 200×432: the long side becomes 432.
  expect(calls[1].slice(0, 6)).toEqual(["sips", "-s", "format", "png", "-Z", "432"]);
  await renderLocalPreview(screenshot.toString("base64"), "image/png", request, { exec, platform: "darwin" });
  expect(calls.filter(call => call[0] === "magick")).toHaveLength(1);
  await expect(renderLocalPreview(screenshot.toString("base64"), "image/png", { format: "rgba", width: 4, height: 4 }, { exec, platform: "darwin" }))
    .rejects.toThrow("PNG previews only");
});

test("without any renderer it rejects so the daemon is asked", async () => {
  const exec = async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  await expect(renderLocalPreview(screenshot.toString("base64"), "image/png", { format: "png", width: 10, height: 10 }, { exec, platform: "linux" }))
    .rejects.toThrow("no local image renderer");
});
