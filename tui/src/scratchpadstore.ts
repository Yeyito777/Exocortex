/**
 * Scratchpad contents the TUI holds, keyed by their hash (scratchpadHash), as
 * the conversation summaries name them (docs/scratchpad.md). Contents with the
 * same hash are the same on every daemon, so one store serves every route.
 *
 * The TUI's store is kept on disk (config/runtime/scratchpad-cache.json): a
 * fresh TUI paints the card from it with the first summaries it has (over
 * /ssh, the cached sidebar list), and tells the daemon which hashes it holds so
 * the bootstrap leaves them out. Bounded by count and bytes, least recently
 * used first out; written a moment after a change, and on exit.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SCRATCHPAD_MAX_BYTES } from "@exocortex/shared/scratchpad";

export interface ScratchpadStoreLimits {
  maxEntries: number;
  maxBytes: number;
}

export const DEFAULT_SCRATCHPAD_STORE_LIMITS: ScratchpadStoreLimits = { maxEntries: 512, maxBytes: 2 * 1024 * 1024 };
const FORMAT = 1;
const WRITE_DELAY_MS = 1_000;

export class ScratchpadStore {
  /** Contents by hash, least recently used first. */
  private contents = new Map<string, string>();
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  /** `path` null: memory only. */
  constructor(
    private readonly path: string | null = null,
    private readonly limits: ScratchpadStoreLimits = DEFAULT_SCRATCHPAD_STORE_LIMITS,
    private readonly writeDelayMs = WRITE_DELAY_MS,
  ) {
    if (!path) return;
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as { format?: number; entries?: unknown };
      if (data.format !== FORMAT || !Array.isArray(data.entries)) return;
      for (const item of data.entries) {
        if (Array.isArray(item) && typeof item[0] === "string" && typeof item[1] === "string") this.set(item[0], item[1]);
      }
      this.evict();
    } catch { /* none yet, or damaged: start empty */ }
  }

  get(hash: string): string | undefined {
    const content = this.contents.get(hash);
    if (content === undefined) return undefined;
    // Used: last to go.
    this.contents.delete(hash);
    this.contents.set(hash, content);
    return content;
  }

  has(hash: string): boolean {
    return this.contents.has(hash);
  }

  /** Keep `content` under `hash`; false when it was already held or is too big to keep. */
  put(hash: string, content: string): boolean {
    if (this.contents.has(hash)) {
      this.get(hash);
      return false;
    }
    if (Buffer.byteLength(content) > SCRATCHPAD_MAX_BYTES * 2) return false;
    this.set(hash, content);
    this.evict();
    this.schedule();
    return true;
  }

  /** Hashes held, most recently used first (the daemon is told of these). */
  hashes(limit = this.limits.maxEntries): string[] {
    return [...this.contents.keys()].reverse().slice(0, limit);
  }

  get size(): number {
    return this.contents.size;
  }

  /** Writes still pending, now (tests, and a clean exit). */
  flushSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.path || !this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}`;
      writeFileSync(tmp, this.serialize());
      renameSync(tmp, this.path);
    } catch { /* the next start reads the older copy */ }
  }

  private set(hash: string, content: string): void {
    this.contents.set(hash, content);
    this.bytes += Buffer.byteLength(content);
  }

  private evict(): void {
    while (this.contents.size > this.limits.maxEntries || (this.contents.size > 0 && this.bytes > this.limits.maxBytes)) {
      const [hash, content] = this.contents.entries().next().value!;
      this.contents.delete(hash);
      this.bytes -= Buffer.byteLength(content);
    }
  }

  private serialize(): string {
    return JSON.stringify({ format: FORMAT, entries: [...this.contents] });
  }

  private schedule(): void {
    if (!this.path) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.dirty || !this.path) return;
      this.dirty = false;
      const path = this.path;
      const json = this.serialize();
      const tmp = `${path}.tmp-${process.pid}`;
      void mkdir(dirname(path), { recursive: true })
        .then(() => writeFile(tmp, json))
        .then(() => rename(tmp, path))
        .catch(() => { /* the next change or exit writes again */ });
    }, this.writeDelayMs);
    this.timer.unref?.();
  }
}
