/** Read-only, cooperative archive I/O and integrity work. No persisted trust shortcuts. */
import { createHash, randomUUID } from "node:crypto";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { isReplayHistoryMessage } from "./messages";
import type { ConversationLoadRequest, ConversationLoadResponse, ConversationLoadResult } from "./conversation-load-protocol";

const stores = new Map<string, SqliteConversationStore>();
const restoreStores = new Map<string, SqliteConversationStore>();
type Prefix = { hash: ReturnType<typeof createHash>; historyCount: number; hashes: Array<[number, string]> };
const prefixes = new Map<string, Prefix>();
type Read = NonNullable<ReturnType<SqliteConversationStore["loadRuntimeWindow"]>>;
const cache = new Map<string, { read: Read; token: string; bytes: number }>();
let cacheBytes = 0;
const CACHE_BYTES = 64 * 1024 * 1024;
const CACHE_ENTRIES = 8;
const jobs: Array<Extract<ConversationLoadRequest, { type: "load" | "prefetch" }>> = [];
let working = false;

function storeFor(path: string, restoring = false) {
  const map = restoring ? restoreStores : stores;
  let store = map.get(path);
  if (!store) { store = new SqliteConversationStore({ path, readonly: true }); map.set(path, store); }
  return store;
}
function removeCached(key: string) {
  const entry = cache.get(key);
  if (entry) cacheBytes -= entry.bytes;
  cache.delete(key);
}
function cached(key: string, token: string | null): Read | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.token !== token) { removeCached(key); return null; }
  cache.delete(key); cache.set(key, entry);
  return entry.read;
}
function retain(key: string, token: string, read: Read) {
  if (!read.result.validatedActiveContext || !read.result.window?.prefixSequence) return false;
  // Bodies are only the actual tail. Never cache full/uncompacted archives.
  const bytes = Buffer.byteLength(JSON.stringify(read.result)) * 2
    + read.result.window.prefixSequence * 320 + 4096;
  if (bytes > CACHE_BYTES / 2) return false;
  removeCached(key);
  while (cache.size && (cacheBytes + bytes > CACHE_BYTES || cache.size >= CACHE_ENTRIES)) removeCached(cache.keys().next().value!);
  cache.set(key, { read, token, bytes }); cacheBytes += bytes;
  return true;
}
function send(response: ConversationLoadResponse) { globalThis.postMessage(response); }

async function pump() {
  if (working) return;
  working = true;
  try {
    while (jobs.length) {
      const interactive = jobs.findIndex(job => job.type === "load");
      const request = jobs.splice(interactive < 0 ? 0 : interactive, 1)[0];
      try {
        const store = storeFor(request.path);
        if (request.type === "prefetch" && !store.hasRuntimeArchive(request.id)) {
          send({ requestId: request.requestId, warmed: false }); continue;
        }
        const key = JSON.stringify([request.path, request.id]);
        const token = store.runtimeCacheToken(request.id);
        const full = request.type === "load" && request.full;
        let loaded = full ? null : cached(key, token);
        const cacheHit = !!loaded;
        let cancelled = false;
        if (!loaded) {
          const reader = store.readRuntimeWindow(request.id, randomUUID(), full);
          try {
            let step = reader.next();
            while (!step.done) {
              // Process urgent hashes/Stop-independent requests between batches.
              await new Promise<void>(resolve => setImmediate(resolve));
              if (request.type === "prefetch" && jobs.some(job => job.type === "load"
                  && (job.id !== request.id || job.path !== request.path || job.full))) {
                reader.return(null); cancelled = true; break;
              }
              step = reader.next();
            }
            if (step.done) loaded = step.value;
          } finally { reader.return(null); }
          // Never cache a snapshot changed during the read. Unrelated commits
          // do not invalidate it; trigger coverage is checked with schema changes.
          if (loaded && !full && token && store.runtimeCacheToken(request.id) === token) retain(key, token, loaded);
        }
        if (request.type === "prefetch") {
          send({ requestId: request.requestId, warmed: !cancelled && !!cached(key, store.runtimeCacheToken(request.id)) });
          continue;
        }
        let result: ConversationLoadResult | null = null;
        if (loaded) {
          const handle = randomUUID();
          result = { ...loaded.result,
            window: loaded.result.window ? { ...loaded.result.window, handle } : undefined,
            loadDiagnostics: { cacheHit, archiveRowsRead: cacheHit ? 0 : loaded.result.conversation.messages.length },
          };
          if (result.window) prefixes.set(handle, {
            hash: loaded.baseHash.copy(), historyCount: result.window.prefixHistoryCount, hashes: loaded.prefixHashes,
          });
        }
        send({ requestId: request.requestId, result });
      } catch (error) {
        send({ requestId: request.requestId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally { working = false; }
}

globalThis.onmessage = (event: MessageEvent<ConversationLoadRequest>) => {
  const request = event.data;
  if (request.type === "release") { prefixes.delete(request.handle); return; }
  if (request.type === "load" || request.type === "prefetch") { jobs.push(request); void pump(); return; }
  try {
    let prefix = prefixes.get(request.window.handle);
    if (!prefix) {
      // Separate connection: an interrupted/cooperative cold read may still own
      // a transaction on the normal connection. Never restore inside that txn.
      const restored = storeFor(request.path, true).loadPrefixHash(request.window.conversationId, request.window.prefixSequence);
      if (restored.historyCount !== request.window.prefixHistoryCount
          || restored.hash.copy().digest("hex").slice(0, 24) !== request.window.prefixHash) {
        throw new Error("Archived prefix changed while restoring its hash state");
      }
      prefix = { ...restored, hashes: [] };
      prefixes.set(request.window.handle, prefix);
    }
    const hash = prefix.hash.copy();
    const hashes = new Map(prefix.hashes);
    let count = prefix.historyCount;
    hashes.set(count, hash.copy().digest("hex").slice(0, 24));
    for (const message of request.tail) {
      if (isReplayHistoryMessage(message)) {
        hash.update(JSON.stringify({ role: message.role, content: message.content, providerData: message.providerData ?? null }));
        hash.update("\n"); count++;
      }
      hashes.set(count, hash.copy().digest("hex").slice(0, 24));
    }
    send({ requestId: request.requestId, hashes: [...hashes] });
  } catch (error) {
    send({ requestId: request.requestId, error: error instanceof Error ? error.message : String(error) });
  }
};
