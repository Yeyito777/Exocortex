/**
 * Small, content-addressed LRU for render artifacts that survive JSON reloads.
 * Values must contain presentation data only, never mutable messages/blocks or
 * their owner anchors. The normal per-object WeakMaps remain the first tier.
 */
export class RehydratedRenderCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;

  constructor(private readonly budget = 4 * 1024 * 1024, private readonly maxEntries = 256) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, valueBytes: number): void {
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.bytes -= old.bytes;
    }
    const bytes = key.length * 2 + valueBytes;
    // Huge blocks and live streaming prefixes must not evict the entire cache.
    if (bytes > this.budget / 4 || this.maxEntries < 1) return;
    while (this.entries.size && (this.bytes + bytes > this.budget || this.entries.size >= this.maxEntries)) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
  }
}
