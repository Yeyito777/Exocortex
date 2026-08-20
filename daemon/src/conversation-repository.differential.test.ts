import { afterAll, describe, expect, test } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationsDir, dataDir, trashDir } from "@exocortex/shared/paths";
import type { ConversationRepository } from "./conversation-repository";
import { JsonConversationRepository } from "./json-conversation-repository";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { createConversation, type Conversation } from "./messages";

const prefix = `premerge-differential-${Date.now()}`;
const primaryId = `${prefix}-primary`;
const cloneId = `${prefix}-clone`;
const folderId = `${prefix}-folder`;
const sqliteRoot = mkdtempSync(join(tmpdir(), "exocortex-differential-"));
let jsonRepo = new JsonConversationRepository();
let sqliteRepo = new SqliteConversationStore({ path: join(sqliteRoot, "store.sqlite3") });

function cleanup(): void {
  jsonRepo.close();
  sqliteRepo.close();
  for (const id of [primaryId, cloneId]) {
    rmSync(join(conversationsDir(), `${id}.json`), { force: true });
    rmSync(join(conversationsDir(), `${id}.sidebar`), { force: true });
    rmSync(join(conversationsDir(), `${id}.unwind`), { force: true });
    rmSync(join(trashDir(), `${id}.json`), { force: true });
    rmSync(join(dataDir(), "display-pages", id), { recursive: true, force: true });
  }
  rmSync(sqliteRoot, { recursive: true, force: true });
}
afterAll(cleanup);

function normalizePage(repo: ConversationRepository, id: string, before?: number) {
  const page = repo.loadDisplayPage(id, 2, before);
  return page && {
    entries: page.entries,
    pinnedEntries: page.pinnedEntries,
    startIndex: page.startIndex,
    startUserIndex: page.startUserIndex,
    endIndex: page.endIndex,
    totalEntries: page.totalEntries,
    hasOlder: page.hasOlder,
  };
}

function normalizeBtw(repo: ConversationRepository) {
  const state = repo.loadConversationBtwState();
  return {
    btws: [...state.btws].filter(([id]) => id.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)),
    seen: [...state.seenSessionIds]
      .filter(([id]) => id.startsWith(prefix))
      .map(([id, ids]) => [id, [...ids].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  };
}

function normalizeConversation(conv: Conversation | null) {
  return conv && {
    id: conv.id,
    provider: conv.provider,
    model: conv.model,
    effort: conv.effort,
    fastMode: conv.fastMode,
    messages: conv.messages,
    activeContext: conv.activeContext ?? null,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    lastContextTokens: conv.lastContextTokens,
    marked: conv.marked,
    pinned: conv.pinned,
    sortOrder: conv.sortOrder,
    folderId: conv.folderId ?? null,
    title: conv.title,
    goal: conv.goal ?? null,
    subagentMaxDepth: conv.subagentMaxDepth ?? null,
    subagentPolicy: conv.subagentPolicy ?? null,
  };
}

function snapshot(repo: ConversationRepository) {
  const summaries = repo.listSummaries().filter((entry) => entry.id.startsWith(prefix)).sort((a, b) => a.id.localeCompare(b.id));
  const ids = summaries.map((entry) => entry.id);
  return {
    summaries,
    conversations: ids.map((id) => normalizeConversation(repo.load(id))),
    folders: repo.loadFolders().filter((folder) => folder.id.startsWith(prefix)),
    instructions: [...repo.loadFolderInstructions()].filter(([id]) => id.startsWith(prefix)),
    unread: repo.loadUnreadConversationIds().filter((id) => id.startsWith(prefix)).sort(),
    queue: repo.loadQueuedMessages().filter((entry) => entry.id.startsWith(prefix)),
    btw: normalizeBtw(repo),
    pages: ids.map((id) => {
      const newest = normalizePage(repo, id);
      return { id, newest, older: newest?.hasOlder ? normalizePage(repo, id, newest.startIndex) : null };
    }),
    tools: ids.map((id) => [id, repo.loadToolOutputs(id)]),
  };
}

function checkpoint(label: string): void {
  const json = snapshot(jsonRepo);
  const sqlite = snapshot(sqliteRepo);
  if (!isDeepStrictEqual(json, sqlite)) {
    throw new Error(`Differential repository mismatch after ${label}: ${JSON.stringify({ json, sqlite }, null, 2)}`);
  }
  expect(sqlite).toEqual(json);
  expect(sqliteRepo.integrityCheck().ok).toBe(true);
}

function both(action: (repo: ConversationRepository) => void): void {
  action(jsonRepo);
  action(sqliteRepo);
}

describe("JSON/SQLite deterministic differential state machine", () => {
  test("keeps all durable projections equal through mixed mutations", () => {
    cleanup();
    jsonRepo = new JsonConversationRepository();
    sqliteRepo = new SqliteConversationStore({ path: join(sqliteRoot, "store.sqlite3") });

    const folder = { id: folderId, name: "Differential", parentId: null, createdAt: 1, updatedAt: 2, pinned: false, sortOrder: 3 };
    both((repo) => {
      repo.saveFolders([folder]);
      repo.saveFolderInstructions(new Map([[folderId, "Inherited differential instruction"]]));
    });

    const primary = createConversation(primaryId, "openai", "gpt-5.6-sol", 10, "Differential source", "medium", false);
    primary.folderId = folderId;
    primary.messages.push(
      { role: "system_instructions", content: "Conversation instruction", metadata: null },
      { role: "user", content: "first", metadata: { startedAt: 1, endedAt: 2, model: primary.model, tokens: 3 } },
      { role: "assistant", content: [{ type: "tool_use", id: "differential-call", name: "bash", input: { command: "printf ok" } }], metadata: null },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "differential-call", content: "deferred output", is_error: false }], metadata: null },
      { role: "assistant", content: "first answer", metadata: null },
      { role: "user", content: "second", metadata: null },
      { role: "assistant", content: "second answer", metadata: null },
    );
    both((repo) => repo.save(structuredClone(primary)));
    checkpoint("initial save");

    both((repo) => {
      repo.saveUnreadConversationIds([primaryId]);
      repo.saveQueuedMessages([
        { id: `${prefix}-queue-a`, convId: primaryId, text: "one", timing: "next-turn", source: "daemon", createdAt: 20 },
        { id: `${prefix}-queue-b`, convId: primaryId, text: "two", timing: "message-end", source: "daemon", createdAt: 21 },
      ]);
      repo.saveConversationBtwState({
        btws: new Map([[primaryId, {
          sessionId: `${prefix}-btw`, query: "q", provider: "openai", model: "gpt-5.6-sol",
          startedAt: 22, endedAt: 23, phase: "complete", text: "a", status: "complete",
        }]]),
        seenSessionIds: new Map([[primaryId, new Set([`${prefix}-btw`])]]),
      });
    });
    checkpoint("auxiliary state");

    both((repo) => {
      const conv = repo.load(primaryId)!;
      conv.title = "Differential renamed";
      conv.marked = true;
      conv.pinned = true;
      conv.provider = "deepseek";
      conv.model = "deepseek-v4-pro";
      conv.effort = "high";
      conv.fastMode = true;
      conv.lastContextTokens = 4321;
      conv.updatedAt += 10;
      repo.save(conv);
    });
    checkpoint("metadata and settings");

    both((repo) => {
      const conv = repo.load(primaryId)!;
      conv.messages.push(
        { role: "user", content: "third", metadata: null },
        { role: "assistant", content: "third answer", metadata: { startedAt: 30, endedAt: 31, model: conv.model, tokens: 4 } },
      );
      conv.updatedAt += 1;
      repo.save(conv);
      repo.saveQueuedMessages([
        { id: `${prefix}-queue-b`, convId: primaryId, text: "two edited", timing: "next-turn", source: "daemon", createdAt: 21 },
        { id: `${prefix}-queue-a`, convId: primaryId, text: "one", timing: "next-turn", source: "daemon", createdAt: 20 },
      ]);
    });
    checkpoint("append and queue reorder");

    both((repo) => {
      const source = repo.getSummary(primaryId)!;
      expect(repo.cloneConversation(primaryId, {
        id: cloneId,
        title: "Differential clone",
        sortOrder: source.sortOrder + 0.5,
        createdAt: source.createdAt + 100,
        updatedAt: source.updatedAt + 100,
      })?.id).toBe(cloneId);
    });
    checkpoint("durable clone");

    both((repo) => { expect(repo.trashConversations([cloneId], false)).toEqual([cloneId]); });
    checkpoint("soft delete");
    both((repo) => { expect(repo.restoreConversationsFromTrash([cloneId]).map((entry) => entry.id)).toEqual([cloneId]); });
    checkpoint("restore");

    const undo = { type: "conversation_renamed", convId: primaryId, title: "before" } as const;
    const redo = { type: "conversation_marked", convId: primaryId, marked: false } as const;
    both((repo) => { repo.pushUndoEntry(undo); repo.pushRedoEntry(redo); });
    expect(jsonRepo.popUndoEntry()).toEqual(sqliteRepo.popUndoEntry());
    expect(jsonRepo.popRedoEntry()).toEqual(sqliteRepo.popRedoEntry());
    checkpoint("undo redo stacks");

    const jsonBase = jsonRepo.load(primaryId)!;
    const sqliteBase = sqliteRepo.load(primaryId)!;
    const jsonResult = { ...jsonBase, messages: jsonBase.messages.slice(0, 7), updatedAt: jsonBase.updatedAt + 1 };
    const sqliteResult = { ...sqliteBase, messages: sqliteBase.messages.slice(0, 7), updatedAt: sqliteBase.updatedAt + 1 };
    const options = { operationId: `${prefix}-unwind`, userMessageIndex: 2, historyTotalEntries: 7, messageCount: 4, supersededQueueIds: [`${prefix}-queue-b`] };
    jsonRepo.saveUnwind(jsonBase, jsonResult, 7, options);
    sqliteRepo.saveUnwind(sqliteBase, sqliteResult, 7, options);
    // SQLite removes superseded queue IDs in the unwind transaction. The legacy
    // adapter requires the existing compensating queue cleanup before parity.
    jsonRepo.saveQueuedMessages(jsonRepo.loadQueuedMessages().filter((entry) => !options.supersededQueueIds.includes(entry.id)));
    checkpoint("unwind and compensated legacy queue receipt");

    both((repo) => {
      const conv = repo.load(primaryId)!;
      conv.folderId = null;
      conv.sortOrder = -999;
      conv.updatedAt += 1;
      repo.save(conv);
      repo.saveUnreadConversationIds([]);
      repo.saveConversationBtwState({ btws: new Map(), seenSessionIds: new Map() });
    });
    checkpoint("folder move and auxiliary clear");
  });
});
