import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationsDir, dataDir, trashDir } from "@exocortex/shared/paths";
import type { ConversationRepository } from "./conversation-repository";
import { JsonConversationRepository } from "./json-conversation-repository";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { createConversation, type Conversation } from "./messages";

interface Harness {
  name: "json" | "sqlite";
  repository: ConversationRepository;
  reopen(): ConversationRepository;
  cleanup(): void;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function harness(name: "json" | "sqlite", id: string): Harness {
  if (name === "sqlite") {
    const root = mkdtempSync(join(tmpdir(), "exocortex-sqlite-contract-"));
    const path = join(root, "store.sqlite3");
    let current = new SqliteConversationStore({ path });
    const value: Harness = {
      name,
      get repository() { return current; },
      reopen() {
        current.close();
        current = new SqliteConversationStore({ path });
        return current;
      },
      cleanup() {
        current.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
    cleanups.push(() => value.cleanup());
    return value;
  }

  let current = new JsonConversationRepository();
  const removeFixture = () => {
    rmSync(join(conversationsDir(), `${id}.json`), { force: true });
    rmSync(join(conversationsDir(), `${id}.sidebar`), { force: true });
    rmSync(join(conversationsDir(), `${id}.unwind`), { force: true });
    rmSync(join(trashDir(), `${id}.json`), { force: true });
    rmSync(join(dataDir(), "display-pages", id), { recursive: true, force: true });
    current.saveFolders([]);
    current.saveFolderInstructions(new Map());
    current.saveUnreadConversationIds([]);
    current.saveQueuedMessages([]);
    current.saveConversationBtwState({ btws: new Map(), seenSessionIds: new Map() });
  };
  const value: Harness = {
    name,
    get repository() { return current; },
    reopen() { current.close(); current = new JsonConversationRepository(); return current; },
    cleanup: removeFixture,
  };
  cleanups.push(removeFixture);
  return value;
}

function fixture(id: string): Conversation {
  const conv = createConversation(id, "openai", "gpt-5.6-sol", 7, "Repository contract", "medium", true);
  conv.messages.push(
    { role: "system_instructions", content: "Be exact.", metadata: null },
    { role: "user", content: "first", metadata: { startedAt: 1, endedAt: 2, model: conv.model, tokens: 3 } },
    { role: "assistant", content: "answer", metadata: null },
  );
  return conv;
}

for (const backend of ["json", "sqlite"] as const) {
  describe(`${backend} conversation repository contract`, () => {
    test("persists metadata, ordered messages, and restart reads", () => {
      const id = `contract-${backend}-roundtrip-${Date.now()}`;
      const h = harness(backend, id);
      const conv = fixture(id);
      conv.subagentMaxDepth = 0;
      conv.subagentPolicy = { parentConversationId: "parent", allowEdits: false, parentSystemInstructions: "Parent" };
      conv.toolPolicy = { internal: ["read"], external: [] };
      h.repository.save(conv);

      expect(h.repository.has(id)).toBe(true);
      expect(h.repository.getSummary(id)?.messageCount).toBe(2);
      expect(h.repository.loadToolPolicyState(id)).toEqual({
        id,
        subagentMaxDepth: 0,
        subagentPolicy: conv.subagentPolicy,
        toolPolicy: conv.toolPolicy,
      });
      expect(h.repository.load(id)?.messages).toEqual(conv.messages);

      conv.title = "Changed title";
      conv.marked = true;
      conv.pinned = true;
      conv.effort = "high";
      conv.messages.push({ role: "user", content: "second", metadata: null });
      h.repository.save(conv);

      const reopened = h.reopen();
      const loaded = reopened.load(id)!;
      expect(loaded.title).toBe("Changed title");
      expect(loaded.marked).toBe(true);
      expect(loaded.pinned).toBe(true);
      expect(loaded.effort).toBe("high");
      expect(loaded.messages.map((message) => message.content)).toEqual(["Be exact.", "first", "answer", "second"]);
    });

    test("pages history and defers tool output", () => {
      const id = `contract-${backend}-paging-${Date.now()}`;
      const h = harness(backend, id);
      const conv = fixture(id);
      conv.messages.push(
        { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "printf ok" } }], metadata: null },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "large result", is_error: false }], metadata: null },
        { role: "assistant", content: "done", metadata: null },
        { role: "user", content: "newest", metadata: null },
        { role: "assistant", content: "latest answer", metadata: null },
      );
      h.repository.save(conv);

      const newest = h.repository.loadDisplayPage(id, 1)!;
      expect(newest.entries.find((entry) => entry.type === "user")?.text).toBe("newest");
      expect(JSON.stringify(newest.entries)).not.toContain("large result");
      expect(newest.hasOlder).toBe(true);
      const older = h.repository.loadDisplayPage(id, 1, newest.startIndex)!;
      expect(older.entries.length).toBeGreaterThan(0);
      expect(h.repository.loadToolOutputs(id)).toEqual([{ toolCallId: "call-1", output: "large result" }]);
    });

    test("persists folders, unread, queue, and BTW receipts", () => {
      const id = `contract-${backend}-aux-${Date.now()}`;
      const h = harness(backend, id);
      const folder = { id: `${id}-folder`, name: "Folder", parentId: null, createdAt: 1, updatedAt: 2, pinned: false, sortOrder: 3 };
      h.repository.saveFolders([folder]);
      h.repository.saveFolderInstructions(new Map([[folder.id, "Inherited"]]));
      const conv = fixture(id);
      conv.folderId = folder.id;
      h.repository.save(conv);
      h.repository.saveUnreadConversationIds([id]);
      h.repository.saveQueuedMessages([{
        id: `${id}-queue`, convId: id, text: "later", timing: "next-turn", source: "daemon", createdAt: 4,
      }]);
      h.repository.saveConversationBtwState({
        btws: new Map([[id, {
          sessionId: `${id}-btw`, query: "q", provider: "openai", model: conv.model,
          startedAt: 5, endedAt: 6, phase: "complete", text: "a", status: "complete",
        }]]),
        seenSessionIds: new Map([[id, new Set([`${id}-btw`])]]),
      });

      const reopened = h.reopen();
      expect(reopened.loadFolders()).toEqual([folder]);
      expect(reopened.loadFolderInstructions().get(folder.id)).toBe("Inherited");
      expect(reopened.loadUnreadConversationIds()).toEqual([id]);
      expect(reopened.loadQueuedMessages()[0]?.id).toBe(`${id}-queue`);
      expect(reopened.loadConversationBtwState().seenSessionIds.get(id)?.has(`${id}-btw`)).toBe(true);
    });

    test("soft-deletes, restores, and persists stack ordering", () => {
      const id = `contract-${backend}-trash-${Date.now()}`;
      const h = harness(backend, id);
      h.repository.save(fixture(id));
      h.repository.pushTrashEntry({ type: "conversation_renamed", convId: id, title: "before" });
      h.repository.pushTrashEntry({ type: "conversation_marked", convId: id, marked: false });
      expect(h.repository.popUndoEntry()?.type).toBe("conversation_marked");
      h.repository.pushRedoEntry({ type: "conversation_marked", convId: id, marked: true });
      expect(h.repository.popRedoEntry()?.type).toBe("conversation_marked");

      expect(h.repository.trashConversations([id], false)).toEqual([id]);
      expect(h.repository.has(id)).toBe(false);
      const reopened = h.reopen();
      expect(reopened.restoreConversationsFromTrash([id])[0]?.id).toBe(id);
      expect(reopened.has(id)).toBe(true);
      expect(reopened.popUndoEntry()?.type).toBe("conversation_renamed");
    });

    test("commits unwind history and receipt atomically", () => {
      const id = `contract-${backend}-unwind-${Date.now()}`;
      const h = harness(backend, id);
      const base = fixture(id);
      base.messages.push(
        { role: "user", content: "remove", metadata: null },
        { role: "assistant", content: "remove answer", metadata: null },
      );
      h.repository.save(base);
      const result = { ...base, messages: base.messages.slice(0, 3), updatedAt: base.updatedAt + 1 };
      h.repository.saveUnwind(base, result, 2, {
        operationId: `${id}-operation`, userMessageIndex: 1, historyTotalEntries: 2,
        messageCount: 2, supersededQueueIds: [],
      });
      expect(h.reopen().load(id)?.messages).toHaveLength(3);
    });
  });
}

describe("SQLite generation and transactional health", () => {
  test("rejects stale writers and remains consistent", () => {
    const id = `contract-sqlite-stale-${Date.now()}`;
    const h = harness("sqlite", id);
    h.repository.save(fixture(id));
    const first = h.repository.load(id)!;
    const stale = h.repository.load(id)!;
    first.title = "winner";
    h.repository.save(first);
    stale.title = "stale";
    expect(() => h.repository.save(stale)).toThrow("Stale conversation generation");
    expect((h.repository as SqliteConversationStore).integrityCheck().ok).toBe(true);
    expect(h.repository.load(id)?.title).toBe("winner");
  });
});
