/** Read-only archive I/O, parsing and integrity hashing live on this thread. */
import { createHash, randomUUID } from "node:crypto";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { isReplayHistoryMessage } from "./messages";
import type { ConversationLoadRequest, ConversationLoadResponse } from "./conversation-load-protocol";

const stores = new Map<string, SqliteConversationStore>();
const prefixes = new Map<string, {
  hash: ReturnType<typeof createHash>;
  historyCount: number;
  hashes: Array<[number, string]>;
}>();

globalThis.onmessage = (event: MessageEvent<ConversationLoadRequest>) => {
  const request = event.data;
  if (request.type === "release") { prefixes.delete(request.handle); return; }
  let response: ConversationLoadResponse;
  try {
    if (request.type === "load") {
      let store = stores.get(request.path);
      if (!store) {
        store = new SqliteConversationStore({ path: request.path, readonly: true });
        stores.set(request.path, store);
      }
      const loaded = store.loadRuntimeWindow(request.id, randomUUID(), request.full);
      if (loaded?.result.window) {
        prefixes.set(loaded.result.window.handle, {
          hash: loaded.baseHash, historyCount: loaded.result.window.prefixHistoryCount,
          hashes: loaded.prefixHashes,
        });
      }
      response = { requestId: request.requestId, result: loaded?.result ?? null };
    } else {
      let prefix = prefixes.get(request.window.handle);
      if (!prefix) {
        let store = stores.get(request.path);
        if (!store) {
          store = new SqliteConversationStore({ path: request.path, readonly: true });
          stores.set(request.path, store);
        }
        const restored = store.loadPrefixHash(request.window.conversationId, request.window.prefixSequence);
        if (restored.historyCount !== request.window.prefixHistoryCount
            || restored.hash.copy().digest("hex").slice(0, 24) !== request.window.prefixHash) {
          throw new Error("Archived prefix changed while restoring its hash state");
        }
        // The foreground's original proof still covers old immutable cursors.
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
          hash.update("\n");
          count++;
        }
        hashes.set(count, hash.copy().digest("hex").slice(0, 24));
      }
      response = { requestId: request.requestId, hashes: [...hashes] };
    }
  } catch (error) {
    response = { requestId: request.requestId, error: error instanceof Error ? error.message : String(error) };
  }
  globalThis.postMessage(response);
};
