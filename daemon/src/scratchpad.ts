/**
 * The Scratchpad panel's source: each conversation's `scratchpad.md` in its
 * workspace, pushed to clients with the scratchpad capability while they are
 * subscribed to that conversation (docs/scratchpad.md). A TUI on /ssh talks to
 * the remote daemon, so it shows the remote's file.
 *
 * A client gets the file's contents as soon as it subscribes, then again each
 * time they change. A conversation's file is watched only while such a client
 * follows it: fs.watch on the workspace directory (which also sees editors
 * that replace the file by renaming), debounced, plus a stat every second for
 * what a watch misses (a workspace created later, a watch that died, network
 * file systems).
 */

import { closeSync, openSync, readSync, statSync, watch, type FSWatcher } from "fs";
import { join } from "path";
import { conversationWorkspaceDir } from "@exocortex/shared/paths";
import type { Event } from "./protocol";
import type { ConnectedClient } from "./server";
import { log } from "./log";

export const SCRATCHPAD_FILE = "scratchpad.md";
/** The most of the file a client is sent; longer files are cut to their last whole line within it. */
export const SCRATCHPAD_MAX_BYTES = 16 * 1024;

const DEFAULT_TIMING = { debounceMs: 100, pollMs: 1_000 };
let timing = DEFAULT_TIMING;

/** Shrink the watch's waits in tests; call with no argument to restore them. */
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

interface WatchedScratchpad {
  dir: string;
  path: string;
  clients: Set<ConnectedClient>;
  content: string | null;
  signature: string;
  watcher: FSWatcher | null;
  debounce: ReturnType<typeof setTimeout> | null;
  poll: ReturnType<typeof setInterval>;
}

export interface ScratchpadWatchDeps {
  send: (client: ConnectedClient, event: Event) => void;
  /** The conversation's workspace directory; defaults to its live workspace. */
  workspaceDir?: (convId: string) => string;
}

export function createScratchpadWatch(deps: ScratchpadWatchDeps) {
  const workspaceDir = deps.workspaceDir ?? conversationWorkspaceDir;
  const watched = new Map<string, WatchedScratchpad>();

  const publish = (convId: string, entry: WatchedScratchpad) => {
    const event: Event = { type: "scratchpad_updated", convId, content: entry.content };
    for (const client of entry.clients) {
      if (client.socket.destroyed) entry.clients.delete(client);
      else deps.send(client, event);
    }
  };

  /** Read the file again; publish when what clients see changed. */
  const refresh = (convId: string, entry: WatchedScratchpad) => {
    entry.signature = fileSignature(entry.path);
    const content = readScratchpad(entry.path);
    if (content === entry.content) return;
    entry.content = content;
    publish(convId, entry);
  };

  const attachWatcher = (convId: string, entry: WatchedScratchpad) => {
    if (entry.watcher) return;
    try {
      const watcher = watch(entry.dir, { persistent: false }, (_kind, filename) => {
        // Some platforms omit the name; then any change in the workspace may be it.
        if (filename && filename.toString() !== SCRATCHPAD_FILE) return;
        if (entry.debounce) clearTimeout(entry.debounce);
        entry.debounce = setTimeout(() => {
          entry.debounce = null;
          if (watched.get(convId) === entry) refresh(convId, entry);
        }, timing.debounceMs);
      });
      watcher.on("error", () => {
        // The workspace went away (deleted, moved to trash): the poll notices and watches again if it returns.
        watcher.close();
        if (entry.watcher === watcher) entry.watcher = null;
      });
      entry.watcher = watcher;
    } catch {
      // No workspace yet: the poll attaches once it exists.
    }
  };

  const poll = (convId: string, entry: WatchedScratchpad) => {
    attachWatcher(convId, entry);
    if (fileSignature(entry.path) !== entry.signature) refresh(convId, entry);
  };

  const stopWatching = (convId: string) => {
    const entry = watched.get(convId);
    if (!entry) return;
    watched.delete(convId);
    entry.watcher?.close();
    if (entry.debounce) clearTimeout(entry.debounce);
    clearInterval(entry.poll);
  };

  const remove = (client: ConnectedClient, convId: string) => {
    const entry = watched.get(convId);
    if (!entry) return;
    entry.clients.delete(client);
    if (entry.clients.size === 0) stopWatching(convId);
  };

  return {
    /** The client follows the conversation: send it the file now, and on every change. */
    subscribed(client: ConnectedClient, convId: string): void {
      let entry = watched.get(convId);
      if (!entry) {
        let dir: string;
        try { dir = workspaceDir(convId); } catch (error) {
          log("debug", `scratchpad: no workspace for ${convId}: ${error instanceof Error ? error.message : error}`);
          return;
        }
        const path = join(dir, SCRATCHPAD_FILE);
        const created: WatchedScratchpad = {
          dir,
          path,
          clients: new Set(),
          content: null,
          signature: "",
          watcher: null,
          debounce: null,
          poll: setInterval(() => poll(convId, created), timing.pollMs),
        };
        (created.poll as { unref?: () => void }).unref?.();
        entry = created;
        watched.set(convId, entry);
        attachWatcher(convId, entry);
        entry.signature = fileSignature(path);
        entry.content = readScratchpad(path);
      }
      entry.clients.add(client);
      deps.send(client, { type: "scratchpad_updated", convId, content: entry.content });
    },
    /** The client stopped following the conversation (or disconnected). */
    unsubscribed: remove,
    /** Conversations whose file is being watched (tests). */
    watchedConversations(): string[] {
      return [...watched.keys()];
    },
    stop(): void {
      for (const convId of [...watched.keys()]) stopWatching(convId);
    },
  };
}

export type ScratchpadWatch = ReturnType<typeof createScratchpadWatch>;
