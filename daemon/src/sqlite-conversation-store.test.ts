import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversation, type StoredMessage } from "./messages";
import { SqliteConversationStore } from "./sqlite-conversation-store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function pathFor(name: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), `exocortex-sqlite-${name}-`));
  roots.push(root);
  return { root, path: join(root, "store.sqlite3") };
}

function savedFixture(store: SqliteConversationStore, id: string) {
  const conv = createConversation(id, "openai", "gpt-5.6-sol", 0, "before");
  conv.messages.push(
    { role: "user", content: "keep", metadata: null },
    { role: "assistant", content: "answer", metadata: null },
  );
  store.save(conv);
  return conv;
}

describe("SQLite transaction fault boundaries", () => {
  test("recovers WAL after an abrupt process exit inside a transaction", () => {
    const { root, path } = pathFor("abrupt-wal");
    let store = new SqliteConversationStore({ path });
    savedFixture(store, "abrupt-wal");
    store.close();

    const modulePath = join(import.meta.dir, "sqlite-conversation-store.ts");
    const child = Bun.spawnSync([
      process.execPath,
      "-e",
      `const { SqliteConversationStore } = await import(${JSON.stringify(modulePath)});\n` +
      `const store = new SqliteConversationStore({ path: ${JSON.stringify(path)}, faultInjection(point) { if (point === "save.after-messages") process.exit(73); } });\n` +
      `const conv = store.load("abrupt-wal");\n` +
      `conv.messages.push({ role: "user", content: "uncommitted", metadata: null });\n` +
      `store.save(conv);`,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, EXOCORTEX_CONFIG_DIR: root },
    });
    expect(child.exitCode).toBe(73);

    store = new SqliteConversationStore({ path });
    expect(store.load("abrupt-wal")?.messages).toHaveLength(2);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  test("rolls back conversation, message, and display writes together", () => {
    const { path } = pathFor("save-fault");
    let store = new SqliteConversationStore({ path });
    savedFixture(store, "save-fault");
    store.close();

    store = new SqliteConversationStore({ path, faultInjection(point) {
      if (point === "save.after-messages") throw new Error("injected save crash");
    } });
    const conv = store.load("save-fault")!;
    conv.title = "after";
    conv.messages.push({ role: "user", content: "must roll back", metadata: null });
    expect(() => store.save(conv)).toThrow("injected save crash");
    store.close();

    store = new SqliteConversationStore({ path });
    expect(store.load("save-fault")?.title).toBe("before");
    expect(store.load("save-fault")?.messages).toHaveLength(2);
    expect(store.loadDisplayPage("save-fault", 5)?.totalEntries).toBe(2);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  test("rolls back delete and undo-stack mutation together", () => {
    const { path } = pathFor("delete-fault");
    let store = new SqliteConversationStore({ path });
    savedFixture(store, "delete-fault");
    store.close();

    store = new SqliteConversationStore({ path, faultInjection(point) {
      if (point === "delete.before-commit") throw new Error("injected delete crash");
    } });
    expect(() => store.trashConversations(["delete-fault"])).toThrow("injected delete crash");
    expect(store.has("delete-fault")).toBe(true);
    expect(store.popUndoEntry()).toBeNull();
    store.close();
  });

  test("rolls back unwind, receipt, and queue tombstone deletion together", () => {
    const { path } = pathFor("unwind-fault");
    let store = new SqliteConversationStore({ path });
    const base = savedFixture(store, "unwind-fault");
    base.messages.push({ role: "user", content: "remove", metadata: null });
    store.save(base);
    store.saveQueuedMessages([{
      id: "unwind-queue", convId: base.id, text: "queued", timing: "message-end", source: "daemon", createdAt: 1,
    }]);
    store.close();

    store = new SqliteConversationStore({ path, faultInjection(point) {
      if (point === "unwind.before-commit") throw new Error("injected unwind crash");
    } });
    const loaded = store.load(base.id)!;
    const result = { ...loaded, messages: loaded.messages.slice(0, 2), updatedAt: loaded.updatedAt + 1 };
    expect(() => store.saveUnwind(loaded, result, 2, {
      operationId: "unwind-op", userMessageIndex: 1, historyTotalEntries: 2,
      messageCount: 2, supersededQueueIds: ["unwind-queue"],
    })).toThrow("injected unwind crash");
    expect(store.load(base.id)?.messages).toHaveLength(3);
    expect(store.loadQueuedMessages().map((entry) => entry.id)).toEqual(["unwind-queue"]);
    expect(store.hasConversationUnwindReceipt(base.id)).toBe(false);
    store.close();
  });
});

describe("SQLite maintenance", () => {
  test("backs up, checks, restores to a new file, and exports normalized JSON", () => {
    const { root, path } = pathFor("maintenance");
    const store = new SqliteConversationStore({ path });
    savedFixture(store, "maintenance");
    const backup = store.backup(join(root, "backup.sqlite3"));
    const backupDb = new Database(backup, { readonly: true });
    const check = backupDb.query<Record<string, string>, []>("PRAGMA quick_check").get();
    expect(check && Object.values(check)[0]).toBe("ok");
    backupDb.close();

    expect(() => store.backup(backup)).toThrow("already exists");
    const restored = store.restoreToNewFile(backup, join(root, "restored.sqlite3"));
    expect(() => store.restoreToNewFile(backup, restored)).toThrow("already exists");
    const restoredStore = new SqliteConversationStore({ path: restored });
    expect(restoredStore.load("maintenance")?.messages).toHaveLength(2);
    restoredStore.close();

    const exportRoot = join(root, "export");
    const manifest = store.exportAll(exportRoot);
    expect(manifest.conversations).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(exportRoot, "conversations", "maintenance.json"), "utf8"))).toMatchObject({ version: 18, id: "maintenance" });
    expect(store.diagnostics()).toMatchObject({
      schemaVersion: 6,
      liveConversations: 1,
      messages: 2,
      importStatus: "not-run",
    });
    store.close();
  });

  test("separates and reconstructs large tool/image payloads without orphans", () => {
    const { path } = pathFor("blobs");
    const store = new SqliteConversationStore({ path });
    const conv = createConversation("blobs", "openai", "gpt-5.6-sol", 0, "blobs");
    const content: StoredMessage["content"] = [
      { type: "text", text: "payloads" },
      { type: "tool_result", tool_use_id: "tool-1", content: "tool-output".repeat(10_000), is_error: true },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "image-base64".repeat(10_000) } },
    ];
    conv.messages.push({ role: "user", content, metadata: null });
    store.save(conv);

    const storedContent = store.db.query<{ content_json: string }, []>("SELECT content_json FROM messages").get()!.content_json;
    expect(storedContent).not.toContain("tool-output");
    expect(storedContent).not.toContain("image-base64");
    expect(store.load("blobs")?.messages[0]?.content).toEqual(content);
    expect(store.loadToolOutputs("blobs")).toEqual([{
      toolCallId: "tool-1",
      output: "tool-output".repeat(10_000),
    }]);
    expect(store.diagnostics()).toMatchObject({ messageBlobs: 2, toolOutputReferences: 1 });

    store.db.query("DELETE FROM conversations WHERE id='blobs'").run();
    expect(store.diagnostics()).toMatchObject({ messageBlobs: 0, toolOutputReferences: 0, messages: 0 });
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });

  test("uses indexes for scale-critical summary and page queries", () => {
    const { path } = pathFor("query-plan");
    const store = new SqliteConversationStore({ path });
    savedFixture(store, "query-plan");
    const summaryPlan = store.explain("SELECT id FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC, id");
    const pagePlan = store.explain("SELECT sequence FROM messages WHERE conversation_id='query-plan' AND is_real_user=1 ORDER BY sequence");
    const details = [...summaryPlan, ...pagePlan].map((row) => String(row.detail ?? "")).join("\n");
    expect(details).toContain("conversations_live_updated_idx");
    expect(details).toContain("messages_page_idx");
    expect(() => store.explain("DELETE FROM conversations")).toThrow("SELECT statements only");
    store.close();
  });

  test("refuses a schema newer than the binary", () => {
    const { path } = pathFor("future");
    const db = new Database(path, { create: true });
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT");
    db.query("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(999, "future", Date.now());
    db.close();
    expect(() => new SqliteConversationStore({ path })).toThrow("Unsupported future conversation database schema 999");
  });
});
