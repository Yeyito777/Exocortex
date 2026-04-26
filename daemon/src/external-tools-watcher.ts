import { existsSync, readdirSync, statSync, watch } from "fs";
import { join } from "path";
import { log } from "./log";

export type FsWatcher = ReturnType<typeof watch>;

export function getExternalToolWatchTargets(externalToolsDir: string): string[] {
  if (!existsSync(externalToolsDir)) return [externalToolsDir];

  const dirs: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(externalToolsDir);
  } catch {
    return [externalToolsDir];
  }

  for (const entry of entries) {
    const target = join(externalToolsDir, entry);
    try {
      if (!statSync(target).isDirectory()) continue;
    } catch {
      continue;
    }
    dirs.push(target);
  }

  dirs.sort((a, b) => a.localeCompare(b));
  return [externalToolsDir, ...dirs];
}

function closeWatcherQuietly(watcher: FsWatcher, label: string): void {
  try {
    watcher.close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", `external-tools: failed to close watcher for ${label}: ${msg}`);
  }
}

function openWatcher(target: string, label: string, onEvent: () => void): FsWatcher | null {
  try {
    const watcher = watch(target, { persistent: false }, () => {
      try {
        onEvent();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("warn", `external-tools: watcher callback failed for ${label}: ${msg}`);
      }
    });
    watcher.on?.("error", (err: Error) => {
      log("warn", `external-tools: watcher error for ${label}: ${err.message}`);
    });
    return watcher;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", `external-tools: failed to watch ${label}: ${msg}`);
    return null;
  }
}

export class ExternalToolWatcher {
  private rootWatcher: FsWatcher | null = null;
  private childWatchers = new Map<string, FsWatcher>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly externalToolsDir: string,
    private readonly debounceMs: number,
    private readonly onReload: () => void,
  ) {}

  start(): void {
    this.rootWatcher = openWatcher(this.externalToolsDir, "external-tools root", () => this.scheduleReload());
    this.refreshChildWatchers();
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.clearAllWatchers();
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.refreshChildWatchers();
      this.onReload();
    }, this.debounceMs);
  }

  private refreshChildWatchers(): void {
    const targets = new Set(getExternalToolWatchTargets(this.externalToolsDir).slice(1));

    for (const [target, watcher] of this.childWatchers) {
      if (targets.has(target)) continue;
      closeWatcherQuietly(watcher, `external-tools child '${target}'`);
      this.childWatchers.delete(target);
    }

    for (const target of targets) {
      if (this.childWatchers.has(target)) continue;
      const watcher = openWatcher(target, `external-tools child '${target}'`, () => this.scheduleReload());
      if (watcher) this.childWatchers.set(target, watcher);
    }
  }

  private clearAllWatchers(): void {
    if (this.rootWatcher) {
      closeWatcherQuietly(this.rootWatcher, "external-tools root");
      this.rootWatcher = null;
    }
    for (const [target, watcher] of this.childWatchers) {
      closeWatcherQuietly(watcher, `external-tools child '${target}'`);
    }
    this.childWatchers.clear();
  }
}
