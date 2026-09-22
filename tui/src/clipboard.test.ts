import { afterEach, describe, expect, test } from "bun:test";
import type { SpawnSyncReturns } from "child_process";
import { readClipboardImage, readHeicClipboardFiles, setClipboardSystemForTest } from "./clipboard";
import { spawnSync } from "node:child_process";
import { HEIC_BYTES } from "../../test/heic-fixture";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

function spawnResult(status: number, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)): SpawnSyncReturns<Buffer> {
  return {
    pid: 0,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
  } as SpawnSyncReturns<Buffer>;
}

describe("clipboard image reading", () => {
  afterEach(() => setClipboardSystemForTest(null));

  test("SSH file offers never read a coincidentally matching server-side path", () => {
    expect(() => readHeicClipboardFiles("file:///tmp/photo.heic", false)).toThrow("over SSH");
    expect(readHeicClipboardFiles("file:///tmp/photo.png", false)).toBeNull();
  });

  for (const wayland of [false, true]) {
    for (const target of ["image/heic", "image/heif", "text/uri-list", "x-special/gnome-copied-files"]) {
      test(`${wayland ? "Wayland" : "X11"} prefers ${target} photo over PNG file icon`, () => {
        const reads: string[] = [];
        setClipboardSystemForTest({
          platform: "linux",
          env: wayland ? { WAYLAND_DISPLAY: "test" } : {},
          spawnSync: ((command: string, args: string[], options: object) => {
            if (command === "which") return spawnResult(0);
            if (command === "magick") return spawnSync(command, args, options);
            if (args.includes("TARGETS") || args.includes("--list-types")) {
              return spawnResult(0, Buffer.from(`image/png\n${target}\n`));
            }
            const requested = wayland ? args[1] : args[3];
            reads.push(requested);
            return spawnResult(0, requested === "image/png" ? PNG_BYTES
              : requested.startsWith("image/") ? HEIC_BYTES
              : Buffer.from(`${target.startsWith("x-special") ? "copy\n" : "# files\n"}file:///tmp/Photo%20One.HEIC\r\n`));
          }) as typeof spawnSync,
          statSync: (() => ({ isFile: () => true, size: HEIC_BYTES.length })) as unknown as typeof import("fs").statSync,
          readFileSync: ((path: string) => {
            expect(path).toBe("/tmp/Photo One.HEIC");
            return HEIC_BYTES;
          }) as unknown as typeof import("fs").readFileSync,
        });
        expect(readClipboardImage()?.mediaType).toBe("image/jpeg");
        expect(reads).toEqual([target]);
      });
    }
  }

  test("does not fall back to a file icon when HEIC decoding fails", () => {
    setClipboardSystemForTest({
      platform: "linux", env: {},
      spawnSync: ((command: string, args: string[]) => {
        if (command === "which") return spawnResult(0);
        if (args.includes("TARGETS")) return spawnResult(0, Buffer.from("image/png\nimage/heic"));
        if (args.includes("image/png")) throw new Error("must not read icon");
        if (command === "magick") return spawnResult(1);
        return spawnResult(0, Buffer.from("invalid HEIC"));
      }) as typeof spawnSync,
    });
    const errors: string[] = [];
    expect(readClipboardImage(message => errors.push(message))).toBeNull();
    expect(errors[0]).toContain("libheif");
  });

  for (const uri of [
    "https://example.org/photo.heic",
    "file://remote-host/photo.heic",
    "file:///tmp/one.heic\nfile:///tmp/two.heic",
  ]) {
    test(`rejects ambiguous/remote HEIC clipboard files: ${uri}`, () => {
      const errors: string[] = [];
      setClipboardSystemForTest({
        platform: "linux", env: {},
        spawnSync: ((command: string, args: string[]) => {
          if (command === "which") return spawnResult(0);
          if (args.includes("TARGETS")) return spawnResult(0, Buffer.from("text/uri-list\nimage/png"));
          expect(args).toContain("text/uri-list");
          return spawnResult(0, Buffer.from(uri));
        }) as typeof spawnSync,
        readFileSync: (() => { throw new Error("must not read a file"); }) as typeof import("fs").readFileSync,
      });
      expect(readClipboardImage(message => errors.push(message))).toBeNull();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/local file URL|one HEIC/);
    });
  }

  test("macOS reads the original Finder HEIC file instead of its PNG icon", () => {
    setClipboardSystemForTest({
      platform: "darwin", env: {},
      spawnSync: ((command: string, args: string[], options: object) => {
        if (command === "which") return spawnResult(0);
        if (command === "magick") return spawnSync(command, args, options);
        expect(args.join(" ")).toContain("as alias");
        return spawnResult(0, Buffer.from("/tmp/photo.HEIC\n"));
      }) as typeof spawnSync,
      statSync: (() => ({ isFile: () => true, size: HEIC_BYTES.length })) as unknown as typeof import("fs").statSync,
      readFileSync: (() => HEIC_BYTES) as unknown as typeof import("fs").readFileSync,
    });
    expect(readClipboardImage()?.mediaType).toBe("image/jpeg");
  });

  test("uses AppleScript on macOS to read clipboard images as PNG", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    let unlinked = "";

    setClipboardSystemForTest({
      platform: "darwin",
      env: {},
      tmpPath: () => "/tmp/exocortex-clipboard-test.png",
      spawnSync: ((command: string, args?: readonly string[]) => {
        calls.push({ command, args: [...(args ?? [])] });
        if (command === "which") return spawnResult(0, Buffer.from("/usr/bin/osascript\n"));
        if (command === "osascript") return spawnResult(0);
        return spawnResult(1, Buffer.alloc(0), Buffer.from("unexpected command"));
      }) as typeof import("child_process").spawnSync,
      readFileSync: (() => PNG_BYTES) as unknown as typeof import("fs").readFileSync,
      unlinkSync: ((path: string) => { unlinked = path; }) as typeof import("fs").unlinkSync,
    });

    const image = readClipboardImage();

    expect(image).toEqual({
      mediaType: "image/png",
      base64: PNG_BYTES.toString("base64"),
      sizeBytes: PNG_BYTES.length,
    });
    const osascript = calls.find(call => call.command === "osascript" && call.args.join("\n").includes("PNGf"));
    expect(osascript?.args.join("\n")).toContain("the clipboard as «class PNGf»");
    expect(osascript?.args.join("\n")).toContain('/tmp/exocortex-clipboard-test.png');
    expect(unlinked).toBe("/tmp/exocortex-clipboard-test.png");
  });

  test("treats missing macOS clipboard image data as no image", () => {
    let readCalled = false;
    let unlinked = "";

    setClipboardSystemForTest({
      platform: "darwin",
      env: {},
      tmpPath: () => "/tmp/exocortex-clipboard-empty.png",
      spawnSync: ((command: string) => {
        if (command === "which") return spawnResult(0, Buffer.from("/usr/bin/osascript\n"));
        if (command === "osascript") return spawnResult(1, Buffer.alloc(0), Buffer.from("execution error: -4960"));
        return spawnResult(1, Buffer.alloc(0), Buffer.from("unexpected command"));
      }) as typeof import("child_process").spawnSync,
      readFileSync: (() => {
        readCalled = true;
        return PNG_BYTES;
      }) as unknown as typeof import("fs").readFileSync,
      unlinkSync: ((path: string) => { unlinked = path; }) as typeof import("fs").unlinkSync,
    });

    expect(readClipboardImage()).toBeNull();
    expect(readCalled).toBe(false);
    expect(unlinked).toBe("/tmp/exocortex-clipboard-empty.png");
  });
});
