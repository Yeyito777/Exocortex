import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { createConversation, currentReplayHistoryPrefix } from "./messages";

test("startup worker enrolls legacy envelopes once, without reading old blob bodies or blocking timers", async () => {
  const root = mkdtempSync(join(tmpdir(), "exo-schema-worker-"));
  const path = join(root, "store.sqlite3");
  let store: SqliteConversationStore | undefined;
  let worker: Worker | undefined;
  try {
    store = new SqliteConversationStore({ path });
    const conv = createConversation("migration", "openai", "gpt-6.1-sol", 0);
    conv.messages.push({ role: "user", content: "original", metadata: null });
    for (let i = 0; i < 2000; i++) conv.messages.push(
      { role: "assistant", content: [{ type: "tool_use", id: `t-${i}`, name: "exec_command", input: {} }], metadata: null },
      { role: "user", content: [{ type: "tool_result", tool_use_id: `t-${i}`, content: "x".repeat(1024) }], metadata: null },
    );
    const prefix = currentReplayHistoryPrefix(conv.messages);
    conv.activeContext = {
      version: 1, kind: "openai_native", provider: conv.provider, model: conv.model,
      messages: [{ role: "assistant", content: [], providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } } }],
      transcriptHistoryCount: prefix.historyCount, transcriptPrefixHash: prefix.hash,
      compactionHistoryCount: prefix.historyCount, compactionPrefixHash: prefix.hash,
      windowId: "migration:1", windowNumber: 1, compactedAt: 1, compactionCount: 1,
    };
    store.save(conv);
    // Simulate the exact pre-v12 schema. Enrollment must not accidentally
    // parse the malformed *superseded* blob, or mint a new content checksum.
    store.db.exec(`
      DROP TABLE checkpoint_integrity;
      DROP TABLE message_integrity;
      DROP TABLE display_integrity;
      DELETE FROM schema_migrations WHERE version>=12;
      UPDATE message_blobs SET payload_json='{' WHERE message_sequence=2;
    `);
    const checkpoint = store.db.query<{ payload_json: string }, []>("SELECT payload_json FROM active_contexts").get()!.payload_json;
    store.close(); store = undefined;
    worker = new Worker(new URL("./conversation-schema-worker.ts", import.meta.url).href, { type: "module" });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 2);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("schema worker timeout")), 20_000);
        worker!.onmessage = event => {
          clearTimeout(timeout);
          if (event.data.ok) resolve(); else reject(new Error(event.data.error));
        };
        worker!.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); };
        worker!.postMessage({ path, importLegacy: false });
      });
    } finally { clearInterval(timer); worker.terminate(); worker = undefined; }
    expect(ticks).toBeGreaterThan(5);
    store = new SqliteConversationStore({ path });
    expect(store.diagnostics().schemaVersion).toBe(13);
    expect(store.db.query<{ payload_json: string }, []>("SELECT payload_json FROM active_contexts").get()!.payload_json).toBe(checkpoint);
    expect(store.loadRuntimeWindow(conv.id, "migration")?.result.loadDiagnostics?.archiveRowsRead).toBe(0);
    expect(() => store!.loadToolOutputs(conv.id, ["t-0"])).toThrow(/blob checksum/);
    store.db.query("DELETE FROM checkpoint_integrity WHERE conversation_id=?").run(conv.id);
    store.close(); store = new SqliteConversationStore({ path });
    expect(() => store!.loadRuntimeWindow(conv.id, "reopen")).toThrow(/Checkpoint integrity/);
    expect(store.db.query("SELECT 1 FROM checkpoint_integrity").get()).toBeNull();
  } finally {
    worker?.terminate(); store?.close();
    if (process.platform === "win32") Bun.gc(true);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
}, 30_000);
