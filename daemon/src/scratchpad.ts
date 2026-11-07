/**
 * The Scratchpad panel's source: each conversation's `scratchpad.md` in its
 * workspace (docs/scratchpad.md). Like Tasks, it rides on the conversation
 * summaries: they carry a short hash of the contents (`scratchpad`), and the
 * contents go to clients separately, keyed by that hash, only when a client
 * lacks them. So a client holding them (from the bootstrap, a change, or its
 * disk cache) paints the card together with the summary, before any open.
 *
 * The index is kept current, cheapest first:
 * - fs.watch on the workspaces of conversations a client follows (debounced),
 * - a stat every second of those, of running conversations and of ones that
 *   ran in the last half minute (agents write it during turns),
 * - a stat of every workspace's file every half minute (a background command,
 *   an edit by hand).
 * A stat that shows no change reads nothing.
 */

import { closeSync, openSync, readdirSync, readSync, statSync, watch, type FSWatcher } from "fs";
import { join } from "path";
import { SCRATCHPAD_MAX_BYTES, scratchpadHash } from "@exocortex/shared/scratchpad";
import { log } from "./log";

export { SCRATCHPAD_MAX_BYTES } from "@exocortex/shared/scratchpad";
export const SCRATCHPAD_FILE = "scratchpad.md";

const DEFAULT_TIMING = { debounceMs: 100, pollMs: 1_000, sweepMs: 30_000, lingerMs: 30_000 };
let timing = DEFAULT_TIMING;

/** Shrink the index's waits in tests; call with no argument to restore them. */
export function setScratchpadTimingForTest(next?: typeof DEFAULT_TIMING): void {
  timing = next ?? DEFAULT_TIMING;
}

/** The file's contents as clients see them: null when missing, unreadable or blank. */
export function readScratchpad(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    if (!statSync(path).isFile()) return null;
    const buffer = Buffer.alloc(SCRATCHPAD_MAX_BYTES + 1);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    let bytes = buffer.subarray(0, read);
    if (read > SCRATCHPAD_MAX_BYTES) {
      // Cut at the last whole line, so neither a line nor a character is split.
      const newline = bytes.lastIndexOf(0x0a, SCRATCHPAD_MAX_BYTES - 1);
      bytes = bytes.subarray(0, newline >= 0 ? newline : 0);
    }
    const text = bytes.toString("utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** What a stat says about the file: changes whenever a write can have changed it. */
function fileSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return "missing";
  }
}

interface Entry {
  signature: string;
  content: string;
  hash: string;
}

interface Watched {
  count: number;
  watcher: FSWatcher | null;
  debounce: ReturnType<typeof setTimeout> | null;
}

export interface ScratchpadIndexDeps {
  /** The directory holding every conversation's workspace, one per conversation id. */
  workspacesDir: () => string;
  /** Conversations running a turn now. */
  activeConversationIds: () => Iterable<string>;
  /** The scratchpad of `convId` changed: `entry` null when it is gone. */
  onChange: (convId: string, entry: { content: string; hash: string } | null) => void;
}

export function createScratchpadIndex(deps: ScratchpadIndexDeps) {
  const entries = new Map<string, Entry>();
  /** Signatures of files that are missing or blank, so a stat is all an unchanged one costs. */
  const empty = new Map<string, string>();
  const watched = new Map<string, Watched>();
  /** Conversations last seen running, and when: polled a while after their turn ends. */
  const lastActive = new Map<string, number>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  const pathOf = (convId: string) => join(deps.workspacesDir(), convId, SCRATCHPAD_FILE);

  /** Stat the file; read it only when that changed. True when what clients see changed. */
  const check = (convId: string): boolean => {
    const path = pathOf(convId);
    const signature = fileSignature(path);
    const entry = entries.get(convId);
    if (entry ? entry.signature === signature : empty.get(convId) === signature) return false;
    const content = signature === "missing" ? null : readScratchpad(path);
    if (content === null) {
      entries.delete(convId);
      if (signature === "missing") empty.delete(convId);
      else empty.set(convId, signature);
      if (!entry) return false;
      deps.onChange(convId, null);
      return true;
    }
    empty.delete(convId);
    if (entry?.content === content) {
      entry.signature = signature;
      return false;
    }
    const next = { signature, content, hash: scratchpadHash(content) };
    entries.set(convId, next);
    deps.onChange(convId, { content, hash: next.hash });
    return true;
  };

  const safeCheck = (convId: string) => {
    try { check(convId); } catch (error) {
      log("debug", `scratchpad: check failed for ${convId}: ${error instanceof Error ? error.message : error}`);
    }
  };

  /** Every workspace's file; conversations whose workspace is gone lose theirs. */
  const sweep = (notify = true) => {
    let ids: string[];
    try { ids = readdirSync(deps.workspacesDir()); } catch { ids = []; }
    const present = new Set(ids);
    for (const convId of [...entries.keys()]) {
      if (present.has(convId)) continue;
      entries.delete(convId);
      if (notify) deps.onChange(convId, null);
    }
    for (const convId of [...empty.keys()]) if (!present.has(convId)) empty.delete(convId);
    for (const convId of ids) {
      if (convId.startsWith(".")) continue;
      if (notify) safeCheck(convId);
      else {
        // The first sweep fills the index without telling anyone: summaries read it.
        const signature = fileSignature(pathOf(convId));
        if (signature === "missing") continue;
        const content = readScratchpad(pathOf(convId));
        if (content === null) empty.set(convId, signature);
        else entries.set(convId, { signature, content, hash: scratchpadHash(content) });
      }
    }
  };

  const poll = () => {
    const now = Date.now();
    for (const convId of deps.activeConversationIds()) lastActive.set(convId, now);
    for (const [convId, at] of lastActive) {
      if (now - at > timing.lingerMs) lastActive.delete(convId);
      else safeCheck(convId);
    }
    for (const [convId, watch] of watched) {
      if (!lastActive.has(convId)) safeCheck(convId);
      attachWatcher(convId, watch);
    }
  };

  const attachWatcher = (convId: string, entry: Watched) => {
    if (entry.watcher) return;
    try {
      const watcher = watch(join(deps.workspacesDir(), convId), { persistent: false }, (_kind, filename) => {
        // Some platforms omit the name; then any change in the workspace may be it.
        if (filename && filename.toString() !== SCRATCHPAD_FILE) return;
        if (entry.debounce) clearTimeout(entry.debounce);
        entry.debounce = setTimeout(() => {
          entry.debounce = null;
          if (watched.get(convId) === entry) safeCheck(convId);
        }, timing.debounceMs);
      });
      watcher.on("error", () => {
        // The workspace went away (deleted, moved to trash): the poll watches again if it returns.
        watcher.close();
        if (entry.watcher === watcher) entry.watcher = null;
      });
      entry.watcher = watcher;
    } catch {
      // No workspace yet: the poll attaches once it exists.
    }
  };

  return {
    /** Fill the index from every workspace and keep it current. */
    start(): void {
      sweep(false);
      pollTimer = setInterval(poll, timing.pollMs);
      sweepTimer = setInterval(() => sweep(), timing.sweepMs);
      (pollTimer as { unref?: () => void }).unref?.();
      (sweepTimer as { unref?: () => void }).unref?.();
    },
    stop(): void {
      if (pollTimer) clearInterval(pollTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      pollTimer = sweepTimer = null;
      for (const entry of watched.values()) {
        entry.watcher?.close();
        if (entry.debounce) clearTimeout(entry.debounce);
      }
      watched.clear();
    },
    /** The hash summaries carry, or undefined without a scratchpad. */
    hash(convId: string): string | undefined {
      return entries.get(convId)?.hash;
    },
    get(convId: string): { content: string; hash: string } | null {
      const entry = entries.get(convId);
      return entry ? { content: entry.content, hash: entry.hash } : null;
    },
    /** Conversations with a scratchpad (tests, the bootstrap). */
    conversationIds(): string[] {
      return [...entries.keys()];
    },
    /** Check one conversation's file now; true when it changed. */
    check,
    /** A client follows the conversation: watch its file closely until the last one leaves. */
    watch(convId: string): void {
      let entry = watched.get(convId);
      if (!entry) {
        entry = { count: 0, watcher: null, debounce: null };
        watched.set(convId, entry);
        attachWatcher(convId, entry);
      }
      entry.count++;
    },
    unwatch(convId: string): void {
      const entry = watched.get(convId);
      if (!entry || --entry.count > 0) return;
      watched.delete(convId);
      entry.watcher?.close();
      if (entry.debounce) clearTimeout(entry.debounce);
    },
    /** Conversations watched closely (tests). */
    watchedConversations(): string[] {
      return [...watched.keys()];
    },
  };
}

export type ScratchpadIndex = ReturnType<typeof createScratchpadIndex>;

let activeIndex: ScratchpadIndex | null = null;

/** The index summaries read (the daemon's one, set by its handler). */
export function setActiveScratchpadIndex(index: ScratchpadIndex | null): void {
  activeIndex = index;
}

/** The summary field for `convId`: its scratchpad's hash, when it has one. */
export function scratchpadSummaryFields(convId: string): { scratchpad?: string } {
  const hash = activeIndex?.hash(convId);
  return hash ? { scratchpad: hash } : {};
}
