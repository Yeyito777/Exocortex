import { afterEach, describe, expect, test } from "bun:test";
import type { SpawnSyncReturns } from "child_process";
import { readClipboardImage, setClipboardSystemForTest } from "./clipboard";

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
    const osascript = calls.find(call => call.command === "osascript");
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
