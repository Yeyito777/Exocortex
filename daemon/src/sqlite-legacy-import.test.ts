import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { conversationsDir, dataDir } from "@exocortex/shared/paths";
import { createConversation } from "./messages";
import * as legacy from "./json-persistence";
import { SqliteConversationStore } from "./sqlite-conversation-store";

const prefix = `premerge-import-${Date.now()}`;
const goodId = `${prefix}-good`;
const overlayId = `${prefix}-overlay`;
const repairedId = `${prefix}-repaired`;
const folderId = `${prefix}-folder`;
const databasePath = join(dataDir(), `${prefix}.sqlite3`);
const sourceDir = conversationsDir();
const hiddenSourceDir = `${sourceDir}.${prefix}.hidden`;

function clean(): void {
  for (const id of [goodId, overlayId, repairedId]) {
    rmSync(join(sourceDir, `${id}.json`), { force: true });
    rmSync(join(sourceDir, `${id}.sidebar`), { force: true });
    rmSync(join(sourceDir, `${id}.unwind`), { force: true });
  }
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  if (existsSync(hiddenSourceDir) && !existsSync(sourceDir)) renameSync(hiddenSourceDir, sourceDir);
}

afterAll(clean);

describe("SQLite resumable legacy import", () => {
  test("resumes a partial import, reimports changed sources, and then stops scanning JSON", () => {
    clean();
    mkdirSync(sourceDir, { recursive: true });

    const folder = {
      id: folderId,
      name: "Imported folder",
      parentId: null,
      createdAt: 1,
      updatedAt: 2,
      pinned: true,
      sortOrder: 3,
    };
    legacy.saveFolders([folder]);
    legacy.saveFolderInstructions(new Map([[folderId, "Inherited import instruction"]]));

    const good = createConversation(goodId, "openai", "gpt-5.6-sol", 1, "Good source", "medium", true);
    good.folderId = folderId;
    good.messages.push(
      { role: "user", content: "first", metadata: null },
      { role: "assistant", content: "answer", metadata: null },
    );
    legacy.save(good);

    const overlay = createConversation(overlayId, "deepseek", "deepseek-v4-pro", 2, "Overlay source", "high", false);
    overlay.messages.push(
      { role: "user", content: "keep", metadata: null },
      { role: "assistant", content: "kept answer", metadata: null },
      { role: "user", content: "remove", metadata: null },
      { role: "assistant", content: "removed answer", metadata: null },
    );
    legacy.save(overlay);
    legacy.saveConversationSidebarState({ id: overlayId, folderId, pinned: true, sortOrder: -50 });
    const overlayResult = { ...overlay, messages: overlay.messages.slice(0, 2), updatedAt: overlay.updatedAt + 1 };
    legacy.saveUnwind(overlay, overlayResult, 2, {
      operationId: `${prefix}-unwind`,
      userMessageIndex: 1,
      historyTotalEntries: 2,
      messageCount: 2,
      supersededQueueIds: [],
    });

    writeFileSync(join(sourceDir, `${repairedId}.json`), "{corrupt", { mode: 0o600 });
    legacy.saveUnreadConversationIds([goodId]);
    legacy.saveQueuedMessages([{
      id: `${prefix}-queue`,
      convId: goodId,
      text: "queued import",
      timing: "next-turn",
      source: "daemon",
      createdAt: 10,
    }]);
    legacy.saveConversationBtwState({
      btws: new Map([[goodId, {
        sessionId: `${prefix}-btw`,
        query: "question",
        provider: "openai",
        model: "gpt-5.6-sol",
        startedAt: 11,
        endedAt: 12,
        phase: "complete",
        text: "answer",
        status: "complete",
      }]]),
      seenSessionIds: new Map([[goodId, new Set([`${prefix}-btw`])]]),
    });

    let store = new SqliteConversationStore({ path: databasePath });
    const first = store.importLegacyIfNeeded();
    expect(first.status).toBe("incomplete");
    // The complete daemon suite intentionally shares one isolated config root, so
    // other tests may leave valid legacy fixtures for this importer to discover.
    // Assert this test's sources directly instead of assuming a globally empty dir.
    expect(first.discovered).toBeGreaterThanOrEqual(3);
    expect(first.imported).toBeGreaterThanOrEqual(2);
    expect(first.skipped).toContainEqual({ id: repairedId, error: "legacy loader rejected the conversation" });
    expect(store.db.query<{ count: number }, [string, string]>("SELECT COUNT(*) AS count FROM import_sources WHERE conversation_id IN (?, ?)").get(goodId, overlayId)?.count).toBe(2);
    expect(store.load(goodId)?.messages).toHaveLength(2);
    expect(store.load(overlayId)).toMatchObject({ folderId, pinned: true, sortOrder: -50 });
    expect(store.load(overlayId)?.messages.map((message) => message.content)).toEqual(["keep", "kept answer"]);
    store.close();

    const changed = legacy.load(goodId)!;
    changed.title = "Changed before completion";
    changed.messages.push({ role: "user", content: "new before resume", metadata: null });
    legacy.save(changed);
    rmSync(join(sourceDir, `${repairedId}.json`), { force: true });
    const repaired = createConversation(repairedId, "openai", "gpt-5.6-sol", 3, "Repaired source");
    repaired.messages.push({ role: "user", content: "repaired", metadata: null });
    legacy.save(repaired);

    store = new SqliteConversationStore({ path: databasePath });
    const second = store.importLegacyIfNeeded();
    expect(second.status).toBe("complete");
    expect(second.discovered).toBeGreaterThanOrEqual(3);
    expect(second.imported).toBeGreaterThanOrEqual(2);
    expect(second.reused).toBeGreaterThanOrEqual(1);
    expect(store.load(goodId)).toMatchObject({ title: "Changed before completion" });
    expect(store.load(goodId)?.messages.map((message) => message.content)).toEqual(["first", "answer", "new before resume"]);
    expect(store.load(repairedId)?.messages).toHaveLength(1);
    expect(store.loadFolders()).toEqual([folder]);
    expect(store.loadFolderInstructions().get(folderId)).toBe("Inherited import instruction");
    expect(store.loadUnreadConversationIds()).toEqual([goodId]);
    expect(store.loadQueuedMessages().map((entry) => entry.id)).toEqual([`${prefix}-queue`]);
    expect(store.loadConversationBtwState().seenSessionIds.get(goodId)?.has(`${prefix}-btw`)).toBe(true);
    expect(store.db.query<{ count: number }, [string, string, string]>("SELECT COUNT(*) AS count FROM import_sources WHERE conversation_id IN (?, ?, ?)").get(goodId, overlayId, repairedId)?.count).toBe(3);
    expect(store.integrityCheck().ok).toBe(true);

    renameSync(sourceDir, hiddenSourceDir);
    try {
      const noScan = store.importLegacyIfNeeded();
      expect(noScan).toMatchObject({ status: "not-needed", discovered: 0, imported: 0, reused: 0 });
    } finally {
      renameSync(hiddenSourceDir, sourceDir);
    }
    store.close();

    store = new SqliteConversationStore({ path: databasePath, autoImportLegacy: true });
    const diagnostics = store.diagnostics();
    expect(diagnostics).toMatchObject({ schemaVersion: 7, importStatus: "complete" });
    expect(diagnostics.liveConversations).toBeGreaterThanOrEqual(3);
    expect([goodId, overlayId, repairedId].every((id) => store.has(id))).toBe(true);
    expect(store.integrityCheck().ok).toBe(true);
    store.close();
  });
});
