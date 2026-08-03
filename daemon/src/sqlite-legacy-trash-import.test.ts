import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const roots: string[] = [];
const instance = basename(resolve(import.meta.dir, "../.."));

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "exocortex-legacy-trash-import-"));
  roots.push(root);
  return root;
}

function dataRoot(root: string): string {
  return join(root, "data", "instances", instance);
}
const conversationsModule = join(import.meta.dir, "conversations.ts");
const persistenceModule = join(import.meta.dir, "persistence.ts");
const pathsModule = join(import.meta.dir, "../../shared/src/paths.ts");

const recursiveId = "legacy-trash-recursive";
const unwrapId = "legacy-trash-unwrap";
const redoId = "legacy-trash-redo";

function runPhase(root: string, backend: "json" | "sqlite", source: string): string {
  const result = Bun.spawnSync([process.execPath, "-e", source], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      EXOCORTEX_CONFIG_DIR: root,
      EXOCORTEX_CONVERSATION_STORE: backend,
      EXOCORTEX_TEST: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${backend} phase failed (${result.exitCode})\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

function fileHashes(path: string, prefix = ""): Record<string, string> {
  if (!existsSync(path)) return {};
  const result: Record<string, string> = {};
  for (const name of readdirSync(path).sort()) {
    if (name === "exocortex.sqlite3" || name.startsWith("exocortex.sqlite3-")) continue;
    const absolute = join(path, name);
    const relative = join(prefix, name);
    const stat = statSync(absolute);
    if (stat.isDirectory()) Object.assign(result, fileHashes(absolute, relative));
    else result[relative] = createHash("sha256").update(readFileSync(absolute)).digest("hex");
  }
  return result;
}

afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("SQLite legacy trash and history import", () => {
  test("preserves deleted conversations and ordered undo/redo behavior through cutover", () => {
    const root = testRoot();
    const setup = `
      const conversations = await import(${JSON.stringify(conversationsModule)});
      const persistence = await import(${JSON.stringify(persistenceModule)});
      conversations.loadFromDisk();
      const recursiveFolder = conversations.createFolder("Legacy recursive", null, [], false);
      const unwrapFolder = conversations.createFolder("Legacy unwrap", null, [], false);
      if (!recursiveFolder || !unwrapFolder) throw new Error("folder creation failed");
      conversations.create(${JSON.stringify(recursiveId)}, "openai", "gpt-5.6-sol", "Recursive child", "high", false, recursiveFolder.id);
      conversations.create(${JSON.stringify(unwrapId)}, "openai", "gpt-5.6-sol", "Unwrap child", "high", false, unwrapFolder.id);
      conversations.create(${JSON.stringify(redoId)}, "openai", "gpt-5.6-sol", "Redo child");
      conversations.flushAll();
      if (!conversations.deleteFolder(recursiveFolder.id, "recursive")) throw new Error("recursive delete failed");
      if (!conversations.deleteFolder(unwrapFolder.id, "unwrap")) throw new Error("unwrap failed");
      if (!conversations.remove(${JSON.stringify(redoId)})) throw new Error("conversation delete failed");
      if (conversations.undoDelete()?.type !== "conversation") throw new Error("legacy conversation undo failed");
      conversations.flushAll();
      if (conversations.getSummary(${JSON.stringify(recursiveId)}) !== null) throw new Error("recursive child should be trashed");
      if (conversations.getSummary(${JSON.stringify(unwrapId)})?.folderId !== null) throw new Error("unwrap child should be at root");
      if (!conversations.getSummary(${JSON.stringify(redoId)})) throw new Error("redo child should have been restored");
      persistence.closeConversationPersistence();
      console.log(JSON.stringify({ recursiveFolderId: recursiveFolder.id, unwrapFolderId: unwrapFolder.id }));
    `;
    const setupOutput = runPhase(root, "json", setup);
    const setupState = JSON.parse(setupOutput.trim().split("\n").at(-1)!) as {
      recursiveFolderId: string;
      unwrapFolderId: string;
    };

    const before = fileHashes(dataRoot(root));
    expect(Object.keys(before).some((name) => name === `trash/${recursiveId}.json`)).toBe(true);
    expect(Object.keys(before)).toContain("trash/trash.json");
    expect(Object.keys(before)).toContain("trash/redo.json");

    const verify = `
      const conversations = await import(${JSON.stringify(conversationsModule)});
      const persistence = await import(${JSON.stringify(persistenceModule)});
      const { Database } = await import("bun:sqlite");
      const stats = conversations.loadFromDisk();
      if (stats.total !== 2) throw new Error("expected two live conversations after import, got " + stats.total);
      if (conversations.getSummary(${JSON.stringify(recursiveId)}) !== null) throw new Error("deleted recursive child became live");
      if (conversations.getSummary(${JSON.stringify(unwrapId)})?.folderId !== null) throw new Error("unwrapped child placement changed");
      if (!conversations.getSummary(${JSON.stringify(redoId)})) throw new Error("redo child missing before redo");

      const db = new Database(persistence.sqliteConversationStorePath(), { readonly: true });
      const counts = db.query("SELECT SUM(deleted_at IS NULL) AS live, SUM(deleted_at IS NOT NULL) AS deleted FROM conversations").get();
      const stacks = db.query("SELECT stack, COUNT(*) AS count FROM sidebar_history GROUP BY stack ORDER BY stack").all();
      db.close();
      if (counts.live !== 2 || counts.deleted !== 1) throw new Error("unexpected imported live/deleted counts: " + JSON.stringify(counts));
      if (JSON.stringify(stacks) !== JSON.stringify([{ stack: "redo", count: 1 }, { stack: "undo", count: 2 }])) {
        throw new Error("unexpected imported stack counts: " + JSON.stringify(stacks));
      }

      if (!conversations.redoDelete() || conversations.getSummary(${JSON.stringify(redoId)}) !== null) throw new Error("imported conversation redo failed");
      if (conversations.undoDelete()?.type !== "conversation" || !conversations.getSummary(${JSON.stringify(redoId)})) throw new Error("conversation undo after redo failed");
      if (conversations.undoDelete()?.type !== "sidebar_state") throw new Error("imported unwrap undo failed");
      if (conversations.getSummary(${JSON.stringify(unwrapId)})?.folderId !== ${JSON.stringify(setupState.unwrapFolderId)}) throw new Error("unwrap membership was not restored");
      if (!conversations.listFolders().some((folder) => folder.id === ${JSON.stringify(setupState.unwrapFolderId)})) throw new Error("unwrap folder was not restored");
      if (conversations.undoDelete()?.type !== "sidebar_state") throw new Error("imported recursive undo failed");
      if (conversations.getSummary(${JSON.stringify(recursiveId)})?.folderId !== ${JSON.stringify(setupState.recursiveFolderId)}) throw new Error("recursive child was not restored");
      if (!conversations.listFolders().some((folder) => folder.id === ${JSON.stringify(setupState.recursiveFolderId)})) throw new Error("recursive folder was not restored");

      if (!conversations.redoDelete() || conversations.getSummary(${JSON.stringify(recursiveId)}) !== null) throw new Error("recursive redo failed");
      if (!conversations.redoDelete() || conversations.getSummary(${JSON.stringify(unwrapId)})?.folderId !== null) throw new Error("unwrap redo failed");
      if (!conversations.redoDelete() || conversations.getSummary(${JSON.stringify(redoId)}) !== null) throw new Error("conversation redo ordering failed");
      conversations.flushAll();
      persistence.closeConversationPersistence();
    `;
    runPhase(root, "sqlite", verify);

    expect(fileHashes(dataRoot(root))).toEqual(before);
  });

  test("imports trash and its undo stack even when there are no live conversations", () => {
    const root = testRoot();
    const onlyDeletedId = "legacy-trash-only-deleted";
    runPhase(root, "json", `
      const conversations = await import(${JSON.stringify(conversationsModule)});
      const persistence = await import(${JSON.stringify(persistenceModule)});
      conversations.loadFromDisk();
      conversations.createWithInitialUserMessage(
        ${JSON.stringify(onlyDeletedId)},
        "openai",
        "gpt-5.6-sol",
        "Only deleted",
        undefined,
        false,
        { text: "Deleted transcript payload", startedAt: 1 },
      );
      if (!conversations.remove(${JSON.stringify(onlyDeletedId)})) throw new Error("delete failed");
      persistence.closeConversationPersistence();
    `);
    const before = fileHashes(dataRoot(root));

    runPhase(root, "sqlite", `
      const conversations = await import(${JSON.stringify(conversationsModule)});
      const persistence = await import(${JSON.stringify(persistenceModule)});
      const { Database } = await import("bun:sqlite");
      const stats = conversations.loadFromDisk();
      if (stats.total !== 0) throw new Error("trash-only import unexpectedly created a live summary");
      const db = new Database(persistence.sqliteConversationStorePath(), { readonly: true });
      const row = db.query("SELECT deleted_at FROM conversations WHERE id=?").get(${JSON.stringify(onlyDeletedId)});
      const messageCount = db.query("SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?").get(${JSON.stringify(onlyDeletedId)}).count;
      const undoCount = db.query("SELECT COUNT(*) AS count FROM sidebar_history WHERE stack='undo'").get().count;
      db.close();
      if (!row || row.deleted_at === null || messageCount !== 1 || undoCount !== 1) throw new Error("trash-only state was not imported");
      if (conversations.undoDelete()?.type !== "conversation") throw new Error("trash-only undo failed");
      if (!conversations.getSummary(${JSON.stringify(onlyDeletedId)})) throw new Error("trash-only conversation was not restored");
      const restored = conversations.get(${JSON.stringify(onlyDeletedId)});
      if (restored?.messages.length !== 1 || restored.messages[0]?.content !== "Deleted transcript payload") throw new Error("trash-only transcript was not restored");
      persistence.closeConversationPersistence();
    `);

    expect(fileHashes(dataRoot(root))).toEqual(before);
  });

  test("refuses an ambiguous legacy ID present in both live and trash", () => {
    const root = testRoot();
    const duplicateId = "legacy-trash-duplicate";
    runPhase(root, "json", `
      const conversations = await import(${JSON.stringify(conversationsModule)});
      const persistence = await import(${JSON.stringify(persistenceModule)});
      const paths = await import(${JSON.stringify(pathsModule)});
      const { copyFileSync, mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      conversations.loadFromDisk();
      conversations.create(${JSON.stringify(duplicateId)}, "openai", "gpt-5.6-sol", "Duplicate");
      conversations.flushAll();
      mkdirSync(paths.trashDir(), { recursive: true });
      copyFileSync(join(paths.conversationsDir(), ${JSON.stringify(`${duplicateId}.json`)}), join(paths.trashDir(), ${JSON.stringify(`${duplicateId}.json`)}));
      persistence.closeConversationPersistence();
    `);

    runPhase(root, "sqlite", `
      const conversations = await import(${JSON.stringify(conversationsModule)});
      const persistence = await import(${JSON.stringify(persistenceModule)});
      const { Database } = await import("bun:sqlite");
      let message = "";
      try { conversations.loadFromDisk(); } catch (error) { message = String(error); }
      if (!message.includes("legacy import incomplete") || !message.includes("both live and trash")) {
        throw new Error("ambiguous source did not fail safely: " + message);
      }
      const db = new Database(persistence.sqliteConversationStorePath(), { readonly: true });
      const row = db.query("SELECT id FROM conversations WHERE id=?").get(${JSON.stringify(duplicateId)});
      const complete = db.query("SELECT value FROM store_metadata WHERE key='legacy_import_complete'").get();
      db.close();
      if (row || complete) throw new Error("ambiguous source was imported or marked complete");
      persistence.closeConversationPersistence();
    `);
  });

  test("exports a JSON rollback tree that preserves deleted conversations and undo", () => {
    const sqliteRoot = testRoot();
    const rollbackRoot = testRoot();
    const exportRoot = join(sqliteRoot, "rollback-export");
    const liveId = "sqlite-export-live";
    const deletedId = "sqlite-export-deleted";

    runPhase(sqliteRoot, "sqlite", `
      const conversations = await import(${JSON.stringify(conversationsModule)});
      const persistence = await import(${JSON.stringify(persistenceModule)});
      const { SqliteConversationStore } = await import(${JSON.stringify(join(import.meta.dir, "sqlite-conversation-store.ts"))});
      conversations.loadFromDisk();
      conversations.create(${JSON.stringify(liveId)}, "openai", "gpt-5.6-sol", "Export live");
      conversations.create(${JSON.stringify(deletedId)}, "openai", "gpt-5.6-sol", "Export deleted");
      if (!conversations.remove(${JSON.stringify(deletedId)})) throw new Error("SQLite delete failed");
      conversations.flushAll();
      persistence.closeConversationPersistence();
      const store = new SqliteConversationStore({ path: persistence.sqliteConversationStorePath() });
      const manifest = store.exportAll(${JSON.stringify(exportRoot)});
      store.close();
      if (manifest.conversations.length !== 2 || !manifest.conversations.some((entry) => entry.id === ${JSON.stringify(deletedId)} && entry.deleted === true)) {
        throw new Error("deleted export manifest entry missing");
      }
    `);

    const rollbackData = dataRoot(rollbackRoot);
    mkdirSync(rollbackData, { recursive: true });
    cpSync(exportRoot, rollbackData, { recursive: true });
    runPhase(rollbackRoot, "json", `
      const conversations = await import(${JSON.stringify(conversationsModule)});
      const persistence = await import(${JSON.stringify(persistenceModule)});
      const stats = conversations.loadFromDisk();
      if (stats.total !== 1 || !conversations.getSummary(${JSON.stringify(liveId)})) throw new Error("live rollback conversation missing");
      if (conversations.getSummary(${JSON.stringify(deletedId)}) !== null) throw new Error("deleted rollback conversation became live");
      if (conversations.undoDelete()?.type !== "conversation") throw new Error("rollback undo failed");
      if (!conversations.getSummary(${JSON.stringify(deletedId)})) throw new Error("rollback did not restore deleted conversation");
      persistence.closeConversationPersistence();
    `);
  });
});
