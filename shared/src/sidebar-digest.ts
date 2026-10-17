/**
 * Content digest for incremental sidebar bootstraps (`sidebar-digest-sync`).
 *
 * A reconnecting client describes the conversation list it already holds as
 * SIDEBAR_DIGEST_BUCKETS hashes, one per bucket of conversation ids, plus one
 * hash of its folders. The daemon answers with only the rows of buckets whose
 * hash differs. Nothing is assumed about timestamps or revisions: a bucket is
 * reused only when its exact serialized rows match, so the scheme survives
 * daemon restarts and any drift in the client's copy.
 */

import { createHash } from "node:crypto";

export const SIDEBAR_DIGEST_BUCKETS = 256;

export interface SidebarDigest {
  /** Lowercase hex hash per bucket, SIDEBAR_DIGEST_BUCKETS entries. */
  buckets: string[];
  /** Hash of the folders array's JSON. */
  folders: string;
}

/** FNV-1a over UTF-16 code units; stable across hosts and runtimes. */
export function sidebarBucket(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % SIDEBAR_DIGEST_BUCKETS;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Digest rows given as id → JSON.stringify(summary). */
export function computeSidebarDigest(rows: Iterable<[string, string]>, foldersJson: string): SidebarDigest {
  const buckets: Array<Array<[string, string]>> = Array.from({ length: SIDEBAR_DIGEST_BUCKETS }, () => []);
  for (const row of rows) buckets[sidebarBucket(row[0])]!.push(row);
  return {
    buckets: buckets.map(bucket => hashText(bucket
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([id, json]) => `${id}\n${json}`)
      .join("\n"))),
    folders: hashText(foldersJson),
  };
}

export function isSidebarDigest(value: unknown): value is SidebarDigest {
  if (!value || typeof value !== "object") return false;
  const digest = value as Partial<SidebarDigest>;
  return Array.isArray(digest.buckets)
    && digest.buckets.length === SIDEBAR_DIGEST_BUCKETS
    && digest.buckets.every(hash => typeof hash === "string")
    && typeof digest.folders === "string";
}

/**
 * The daemon's answer to a client digest: rows of differing buckets only, and
 * folders only when they differ. Returns null when every bucket differs, so
 * the caller sends the ordinary full list instead.
 */
export function sidebarListDelta<C extends { id: string }, F>(
  conversations: C[],
  folders: F[],
  digest: SidebarDigest,
): { conversations: C[]; folders?: F[]; sidebarBuckets: number[] } | null {
  const rows = conversations.map(conversation => [conversation.id, JSON.stringify(conversation)] as [string, string]);
  const current = computeSidebarDigest(rows, JSON.stringify(folders));
  const changed = new Set<number>();
  current.buckets.forEach((hash, bucket) => { if (hash !== digest.buckets[bucket]) changed.add(bucket); });
  if (changed.size === SIDEBAR_DIGEST_BUCKETS) return null;
  return {
    conversations: conversations.filter(conversation => changed.has(sidebarBucket(conversation.id))),
    ...(current.folders === digest.folders ? {} : { folders }),
    sidebarBuckets: [...changed].sort((a, b) => a - b),
  };
}
