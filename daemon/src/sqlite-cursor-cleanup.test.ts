import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { createConversation, createStoredUserContextCheckpoint, currentReplayHistoryPrefix } from "./messages";

for (const fault of ["envelope", "projection"] as const) {
  test(`failed clone ${fault} validation releases its cursor for a same-connection retry`, () => {
    const root = mkdtempSync(join(tmpdir(), "exo-cursor-clone-"));
    const store = new SqliteConversationStore({ path: join(root, "store.sqlite3") });
    try {
      const conv = createConversation("cursor-source", "openai", "gpt-6.1-sol", 0);
      conv.messages.push(
        { role: "user", content: "first", metadata: null },
        { role: "assistant", content: "answer", metadata: null },
        { role: "user", content: "second", metadata: null },
      );
      const prefix = currentReplayHistoryPrefix(conv.messages);
      conv.activeContext = {
        version: 1, kind: "openai_native", provider: conv.provider, model: conv.model,
        messages: [{ role: "assistant", content: [], providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } } }],
        transcriptHistoryCount: prefix.historyCount, transcriptPrefixHash: prefix.hash,
        compactionHistoryCount: prefix.historyCount, compactionPrefixHash: prefix.hash,
        windowId: `${conv.id}:1`, windowNumber: 1, compactedAt: 1, compactionCount: 1,
      };
      conv.messages[0]!.contextCheckpoint = createStoredUserContextCheckpoint(conv)!;
      conv.messages.push({ role: "user", content: "tail", metadata: null });
      store.save(conv);
      const target = { id: "cursor-target", title: "clone", sortOrder: 1, createdAt: 1, updatedAt: 1 };
      const original = fault === "envelope"
        ? store.db.query<{ value: string | null }, [string]>("SELECT metadata_json AS value FROM messages WHERE conversation_id=? AND sequence=0").get(conv.id)!.value
        : store.db.query<{ value: string }, [string]>("SELECT payload_json AS value FROM display_entries WHERE conversation_id=? AND pinned=0 AND entry_index=0").get(conv.id)!.value;
      const update = fault === "envelope"
        ? "UPDATE messages SET metadata_json=? WHERE conversation_id=? AND sequence=0"
        : "UPDATE display_entries SET payload_json=? WHERE conversation_id=? AND pinned=0 AND entry_index=0";
      store.db.query(update).run(fault === "envelope" ? '{"startedAt":999}' : "{}", conv.id);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => store.cloneConversation(conv.id, target)).toThrow(
          fault === "envelope" ? /Clone source envelope/ : /display chunk/,
        );
        expect(store.has(target.id)).toBe(false);
      }
      // Restore the fixture's exact original bytes, not a newly blessed receipt.
      store.db.query(update).run(original, conv.id);
      expect(store.cloneConversation(conv.id, target)).toMatchObject({ id: target.id });
      expect(store.loadRuntimeWindow(target.id, "cursor-retry")).not.toBeNull();
      expect(store.integrityCheck().ok).toBe(true);
    } finally {
      store.close();
      if (process.platform === "win32") Bun.gc(true);
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
  });
}
