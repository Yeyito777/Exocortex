/** Daemon-owned filesystem reads used by prompt-line path completion. */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { PathDirectoryEntry, PathDirectoryListing } from "./protocol";

/** Keep a single completion response bounded even for generated/vendor trees. */
export const MAX_PATH_COMPLETION_ENTRIES = 4_096;
const MAX_LOOKAHEAD_ENTRIES = 512;
const MAX_LOOKAHEAD_DIRECTORIES = 6;
const MAX_PATH_TOKEN_LENGTH = 4_096;

function isSupportedDirectoryToken(directory: string): boolean {
  return directory.length > 0
    && directory.length <= MAX_PATH_TOKEN_LENGTH
    && !directory.includes("\0")
    && directory.endsWith("/")
    && (directory.startsWith("~/")
      || directory.startsWith("./")
      || directory.startsWith("../")
      || directory.startsWith("/"));
}

function filesystemPath(directory: string): string | null {
  if (!isSupportedDirectoryToken(directory)) return null;
  if (directory.startsWith("~/")) {
    // Concatenation preserves the shell-style meaning of repeated slashes after
    // `~`; resolve(home, "/...") would incorrectly discard the home directory.
    return resolve(homedir() + directory.slice(1));
  }
  return resolve(directory);
}

function compareEntries(a: PathDirectoryEntry, b: PathDirectoryEntry): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

async function readListing(
  directory: string,
  prefix: string,
  maxEntries: number,
): Promise<PathDirectoryListing> {
  const path = filesystemPath(directory);
  if (path === null || prefix.length > MAX_PATH_TOKEN_LENGTH || prefix.includes("\0") || prefix.includes("/")) {
    return { directory, prefix, entries: [] };
  }

  try {
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.name.startsWith(prefix))
      .map<PathDirectoryEntry>(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : "file",
      }))
      .sort(compareEntries);
    const truncated = entries.length > maxEntries;
    return {
      directory,
      prefix,
      entries: truncated ? entries.slice(0, maxEntries) : entries,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch {
    // Missing, unreadable, and non-directory paths are ordinary completion
    // misses. Returning an empty cacheable listing avoids noisy prompt errors.
    return { directory, prefix, entries: [] };
  }
}

/**
 * List a requested directory and opportunistically hydrate likely child dirs.
 * Lookahead is deliberately bounded; it removes the next SSH round trip in the
 * common case without recursively walking a remote tree.
 */
export async function listPathDirectoryWithLookahead(
  directory: string,
  prefix: string,
): Promise<PathDirectoryListing[]> {
  const root = await readListing(directory, prefix, MAX_PATH_COMPLETION_ENTRIES);
  const likelyChildren = root.entries
    .filter(entry => entry.type === "dir" && (prefix.startsWith(".") || !entry.name.startsWith(".")))
    .slice(0, MAX_LOOKAHEAD_DIRECTORIES);
  if (likelyChildren.length === 0) return [root];

  const children = await Promise.all(likelyChildren.map(entry => (
    readListing(`${directory}${entry.name}/`, "", MAX_LOOKAHEAD_ENTRIES)
  )));
  return [root, ...children];
}

