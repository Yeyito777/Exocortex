import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImagePreviewDisk } from "./imagecache";
import { configureInlineImages, inlineImagesInternalsForTest, kittyThumbnail, type ImagePreviewRequest, type InlineImageSource } from "./inlineimages";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "imagecache-"));
  dirs.push(dir);
  return dir;
}
beforeEach(() => inlineImagesInternalsForTest.reset());
afterEach(() => {
  inlineImagesInternalsForTest.reset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const preview = (fill: string, chars = 400) => ({ format: "png" as const, width: 10, height: 5, base64: Buffer.from(fill.repeat(chars)).toString("base64") });
const dirBytes = (dir: string) => readdirSync(dir).reduce((total, name) => total + statSync(join(dir, name)).size, 0);

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !done(); i++) await Bun.sleep(2);
  expect(done()).toBe(true);
}

/** A TUI's preview store over `dir`, counting what it asks the daemon. */
function tui(dir: string) {
  inlineImagesInternalsForTest.reset();
  const requests: ImagePreviewRequest[] = [];
  const disk = new ImagePreviewDisk(dir);
  configureInlineImages({
    fetch: async request => { requests.push(request); return preview("p"); },
    disk: () => disk,
    onChange: () => {},
  });
  return { requests, disk };
}

describe("image previews on disk", () => {
  const remote: InlineImageSource = { imageId: "b".repeat(64), width: 3000, height: 2000, mediaType: "image/png", sizeBytes: 900_000 };

  test("a restarted TUI draws what it drew before without asking the daemon", async () => {
    const dir = tempDir();
    const first = tui(dir);
    expect(kittyThumbnail(remote, { urgent: true }).phase).toBe("loading");
    await until(() => kittyThumbnail(remote).phase === "ready");
    await first.disk.flush();
    expect(first.requests).toHaveLength(1);

    const restarted = tui(dir);
    expect(kittyThumbnail(remote, { urgent: true }).phase).toBe("loading");
    await until(() => kittyThumbnail(remote).phase === "ready");
    const ready = kittyThumbnail(remote);
    if (ready.phase === "ready") expect(ready.value.base64).toBe(preview("p").base64);
    expect(restarted.requests).toHaveLength(0);
  });

  test("a sent PNG drawn from its own bytes draws after a restart, from disk, though history never carries them", async () => {
    const dir = tempDir();
    const first = tui(dir);
    const sent: InlineImageSource = { imageId: "c".repeat(64), width: 400, height: 200, mediaType: "image/png", sizeBytes: 300, localBase64: "iVBORw0KGgo=" };
    expect(kittyThumbnail(sent).phase).toBe("ready");
    await first.disk.flush();

    const restarted = tui(dir);
    const { localBase64: _, ...fromHistory } = sent;
    kittyThumbnail(fromHistory, { urgent: true });
    await until(() => kittyThumbnail(fromHistory).phase === "ready");
    const ready = kittyThumbnail(fromHistory);
    if (ready.phase === "ready") expect(ready.value).toMatchObject({ base64: sent.localBase64, pixelWidth: 400, pixelHeight: 200 });
    expect(restarted.requests).toHaveLength(0);
  });

  test("a damaged or missing file is fetched as usual, and the damaged one goes", async () => {
    const dir = tempDir();
    const first = tui(dir);
    kittyThumbnail(remote, { urgent: true });
    await until(() => kittyThumbnail(remote).phase === "ready");
    await first.disk.flush();
    const [name] = readdirSync(dir);
    const data = readFileSync(join(dir, name!));
    data[data.length - 1] ^= 0xff;
    writeFileSync(join(dir, name!), data);

    const restarted = tui(dir);
    kittyThumbnail(remote, { urgent: true });
    await until(() => kittyThumbnail(remote).phase === "ready");
    expect(restarted.requests).toHaveLength(1);
    // Truncated, or another key's file under this name: also not served.
    const disk = new ImagePreviewDisk(dir);
    writeFileSync(join(dir, name!), data.subarray(0, 40));
    expect(await disk.get(decodeURIComponent(name!.slice(0, -4)))).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("stays within its size, least recently used out first, counting other TUIs' files", async () => {
    const dir = tempDir();
    const probe = new ImagePreviewDisk(tempDir());
    probe.put("k0", preview("0"));
    await probe.flush();
    const size = dirBytes(probe.dir);
    const a = new ImagePreviewDisk(dir, 3 * size, 0);
    const b = new ImagePreviewDisk(dir, 3 * size, 0);
    const step = async (disk: ImagePreviewDisk, key: string) => { disk.put(key, preview(key.slice(-1))); await disk.flush(); await Bun.sleep(5); };
    await step(a, "k1");
    await step(a, "k2");
    expect(await a.get("k1")).not.toBeNull();
    await Bun.sleep(5);
    // Another TUI adds one; this one's next write counts it too.
    await step(b, "k3");
    await step(a, "k4");
    expect(dirBytes(dir)).toBeLessThanOrEqual(3 * size);
    expect(await a.get("k2")).toBeNull();
    for (const key of ["k1", "k3", "k4"]) expect(await a.get(key)).not.toBeNull();
  });

  test("TUIs writing one key at once: every read is one whole preview", async () => {
    const dir = tempDir();
    const reader = new ImagePreviewDisk(dir);
    const fills = ["x", "y", "z", "w"];
    const versions = new Set(fills.map(fill => preview(fill, 50_000).base64));
    const reads: Array<string | null> = [];
    const writes: Promise<void>[] = [];
    for (let round = 0; round < 20; round++) {
      // Fresh stores, as separate TUIs: each writes the key whatever the others did.
      for (const fill of fills) {
        const writer = new ImagePreviewDisk(dir);
        writer.put("shared", preview(fill, 50_000));
        writes.push(writer.flush());
      }
      reads.push((await reader.get("shared"))?.base64 ?? null);
    }
    await Promise.all(writes);
    reads.push((await reader.get("shared"))?.base64 ?? null);
    for (const read of reads) if (read !== null) expect(versions.has(read)).toBe(true);
    expect(reads.at(-1)).not.toBeNull();
    expect(readdirSync(dir).filter(name => name.includes(".tmp-"))).toEqual([]);
  });
});
