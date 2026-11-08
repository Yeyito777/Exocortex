/**
 * Image previews kept on disk over /ssh, the second tier under the in-memory
 * store in inlineimages.ts: a restarted TUI, or a cached open, draws the
 * images it has drawn before without asking the remote daemon. See
 * docs/inline-images.md.
 *
 * One directory per SSH alias, beside the view cache. Each file is one
 * preview under its in-memory key: a JSON header line (key, size, sha256 of
 * the bytes) and the decoded bytes. TUIs on one machine share the directory:
 * files are written whole and renamed into place, and a read that does not
 * match its key, size and hash is dropped and fetched as if it were missing.
 * Bounded by bytes, least recently used (file mtime) first out.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeDir } from "@exocortex/shared/paths";

export interface StoredImagePreview {
  format: "png" | "rgba";
  width: number;
  height: number;
  base64: string;
}

export const DEFAULT_IMAGE_CACHE_BYTES = 256 * 1024 * 1024;
const FORMAT = 1;
/** A temp file this old is a write that died, not one in progress (another TUI's included). */
const STALE_TEMP_MS = 60_000;
/** Other TUIs write here too: a write looks at the whole directory again at least this often. */
const RESCAN_MS = 10_000;

interface StoredFile {
  bytes: number;
  usedAt: number;
}

/** The cache directory for one SSH alias. */
export function imageCacheDir(alias: string): string {
  return join(runtimeDir(), "ssh-image-cache", encodeURIComponent(alias));
}

function fileName(key: string): string {
  return `${encodeURIComponent(key)}.img`;
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export class ImagePreviewDisk {
  /** Files by name, as last scanned plus this TUI's own reads and writes since. */
  private files: Map<string, StoredFile> | null = null;
  private scanning: Promise<Map<string, StoredFile>> | null = null;
  private bytes = 0;
  private scannedAt = 0;
  /** Writes in flight, so a burst of puts of one key writes it once. */
  private writing = new Set<string>();

  constructor(readonly dir: string, private readonly maxBytes = DEFAULT_IMAGE_CACHE_BYTES, private readonly rescanMs = RESCAN_MS) {}

  /** The preview kept under `key`, or null (missing, damaged, or another key's). */
  async get(key: string): Promise<StoredImagePreview | null> {
    const name = fileName(key);
    const path = join(this.dir, name);
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch {
      return null;
    }
    try {
      const newline = data.indexOf(0x0a);
      if (newline < 0) throw new Error("no header");
      const header = JSON.parse(data.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
      const body = data.subarray(newline + 1);
      if (header.v !== FORMAT || header.key !== key || (header.format !== "png" && header.format !== "rgba")
          || typeof header.width !== "number" || typeof header.height !== "number"
          || header.bytes !== body.length || header.sha256 !== sha256(body)) throw new Error("damaged");
      const now = new Date();
      void utimes(path, now, now).catch(() => {});
      const files = await this.scan();
      const known = files.get(name);
      if (known) known.usedAt = now.getTime();
      return { format: header.format, width: header.width, height: header.height, base64: body.toString("base64") };
    } catch {
      await rm(path, { force: true }).catch(() => {});
      this.forget(name);
      return null;
    }
  }

  /** Keep `preview` under `key`, in the background. */
  put(key: string, preview: StoredImagePreview): void {
    const name = fileName(key);
    if (this.writing.has(name)) return;
    this.writing.add(name);
    void this.write(name, key, preview).catch(() => {}).finally(() => this.writing.delete(name));
  }

  /** Writes in flight (tests). */
  async flush(): Promise<void> {
    while (this.writing.size > 0) await new Promise(resolve => setTimeout(resolve, 1));
  }

  private async write(name: string, key: string, preview: StoredImagePreview): Promise<void> {
    const files = await this.scan();
    if (files.has(name)) return;
    const body = Buffer.from(preview.base64, "base64");
    const header = JSON.stringify({ v: FORMAT, key, format: preview.format, width: preview.width, height: preview.height, bytes: body.length, sha256: sha256(body) });
    const data = Buffer.concat([Buffer.from(`${header}\n`), body]);
    if (data.length > this.maxBytes) return;
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `${name}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      await writeFile(tmp, data);
      await rename(tmp, join(this.dir, name));
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    this.forget(name);
    files.set(name, { bytes: data.length, usedAt: Date.now() });
    this.bytes += data.length;
    if (this.bytes > this.maxBytes || Date.now() - this.scannedAt >= this.rescanMs) await this.evict();
  }

  private forget(name: string): void {
    const known = this.files?.get(name);
    if (!known) return;
    this.files!.delete(name);
    this.bytes -= known.bytes;
  }

  private scan(): Promise<Map<string, StoredFile>> {
    if (this.files) return Promise.resolve(this.files);
    this.scanning ??= this.readDirectory().then(files => {
      this.files = files;
      this.bytes = [...files.values()].reduce((total, file) => total + file.bytes, 0);
      this.scannedAt = Date.now();
      this.scanning = null;
      return files;
    });
    return this.scanning;
  }

  private async readDirectory(): Promise<Map<string, StoredFile>> {
    const files = new Map<string, StoredFile>();
    let names: string[] = [];
    try { names = await readdir(this.dir); } catch { /* none yet */ }
    const now = Date.now();
    await Promise.all(names.map(async name => {
      try {
        const info = await stat(join(this.dir, name));
        if (name.endsWith(".img")) files.set(name, { bytes: info.size, usedAt: info.mtimeMs });
        else if (name.includes(".img.tmp-") && now - info.mtimeMs > STALE_TEMP_MS) await rm(join(this.dir, name), { force: true });
      } catch { /* gone meanwhile */ }
    }));
    return files;
  }

  /** Look again (other TUIs write here too); over the limit, drop the least recently used. */
  private async evict(): Promise<void> {
    this.files = null;
    const files = await this.scan();
    const oldest = [...files].sort((a, b) => a[1].usedAt - b[1].usedAt);
    for (const [name, file] of oldest) {
      if (this.bytes <= this.maxBytes) break;
      await rm(join(this.dir, name), { force: true }).catch(() => {});
      files.delete(name);
      this.bytes -= file.bytes;
    }
  }
}

const disks = new Map<string, ImagePreviewDisk>();

/** The disk tier for one SSH alias (one instance per alias per TUI). */
export function imagePreviewDiskFor(alias: string): ImagePreviewDisk {
  let disk = disks.get(alias);
  if (!disk) disks.set(alias, disk = new ImagePreviewDisk(imageCacheDir(alias)));
  return disk;
}
