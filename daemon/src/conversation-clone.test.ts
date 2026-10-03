import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clonedConversationValue } from "./conversation-clone";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { buildConversationApiContext } from "./context-compaction";
import {
  CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT,
  createConversation, createStoredUserContextCheckpoint, currentReplayHistoryPrefix,
  historyPrefixHash, isValidActiveContext, rewindActiveContextToHistoryCount,
  type Conversation,
} from "./messages";
import { inheritArchiveHashProof } from "./conversation-window";

const target = { id: "copy", title: "copy", sortOrder: 1, createdAt: 200, updatedAt: 200 };
const stores: SqliteConversationStore[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function database(faultInjection?: (point: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "checkpoint-copy-"));
  roots.push(root);
  const store = new SqliteConversationStore({ path: join(root, "store.sqlite3"), faultInjection });
  stores.push(store);
  return store;
}
function fixture(kind: "plaintext" | "openai_native" = "openai_native", legacy = false): Conversation {
  const conv = createConversation("source", "openai", "gpt-6.1-sol", 0, "source");
  conv.messages.push(
    { role: "system_instructions", content: "Keep these instructions", metadata: null },
    { role: "user", content: "archived task", metadata: null },
    { role: "assistant", content: "old body ".repeat(100_000), metadata: null },
  );
  const prefix = currentReplayHistoryPrefix(conv.messages);
  conv.activeContext = {
    version: 1, kind, provider: conv.provider, model: conv.model,
    messages: kind === "openai_native"
      ? [{ role: "assistant", content: [], providerData: { openai: { compactionItems: [{ encryptedContent: "checkpoint" }] } } }]
      : [{ role: "user", content: "Continuation summary", metadata: {
        startedAt: 100, endedAt: 100, model: conv.model, tokens: 0, system: true, kind: "context_checkpoint",
      } }],
    transcriptHistoryCount: prefix.historyCount, transcriptPrefixHash: prefix.hash,
    compactionHistoryCount: prefix.historyCount, compactionPrefixHash: prefix.hash,
    windowId: "source:2", windowNumber: 2, compactedAt: 100, compactionCount: 2,
  };
  conv.messages.push({
    role: "system", content: CONTEXT_COMPACTION_FINISHED_TEXT,
    metadata: { startedAt: 100, endedAt: 100, model: conv.model, tokens: 0, kind: CONTEXT_COMPACTION_FINISHED_KIND },
  });
  for (const text of ["recent task", "followup"]) {
    conv.messages.push({
      role: "user", content: text, metadata: null, contextCheckpoint: createStoredUserContextCheckpoint(conv),
    }, { role: "assistant", content: "answer", metadata: null });
  }
  if (legacy) {
    for (const message of structuredClone(conv.messages.slice(-4))) {
      if (message.role === "user" || message.role === "assistant") {
        conv.activeContext.messages.push({ ...message, role: message.role });
      }
    }
    const prefix = currentReplayHistoryPrefix(conv.messages);
    conv.activeContext.transcriptHistoryCount = prefix.historyCount;
    conv.activeContext.transcriptPrefixHash = prefix.hash;
    // Very old checkpoints resolve their immutable boundary using the divider.
    delete conv.activeContext.compactionHistoryCount;
    delete conv.activeContext.compactionPrefixHash;
  }
  return conv;
}

for (const kind of ["plaintext", "openai_native"] as const) {
  for (const legacy of [false, true]) {
    test(`${kind} ${legacy ? "legacy cursor" : "immutable checkpoint"}: independent replay, edit and restart`, () => {
      const store = database();
      const source = fixture(kind, legacy);
      store.save(source);
      const original = JSON.stringify(source);
      const compatibility = clonedConversationValue(source, target);
      expect(compatibility.messages).toHaveLength(6);
      expect(isValidActiveContext(compatibility.activeContext, compatibility.messages)).toBe(true);
      expect(compatibility.activeContext?.compactionHistoryCount).toBe(0);
      expect(compatibility.activeContext?.transcriptHistoryCount).toBe(legacy ? 4 : 0);
      expect(compatibility.messages[2].contextCheckpoint).toMatchObject({
        windowId: "copy:2", transcriptHistoryCount: 0, transcriptPrefixHash: historyPrefixHash([], 0),
      });
      expect(store.cloneConversation(source.id, target)?.messageCount).toBe(4);
      expect(JSON.stringify(source)).toBe(original);
      // Local rewind checkpoints are not provider replay payload.
      const replay = (conv: Conversation) => buildConversationApiContext(conv).messages.map(({ contextCheckpoint, ...message }) => message);
      const copy = store.load(target.id)!;
      expect(replay(copy)).toEqual(replay(source));
      expect(copy.messages).toHaveLength(6);
      expect(JSON.stringify(copy).length).toBeLessThan(10_000);
      expect(store.loadDisplayPage(copy.id, 20)?.startUserIndex).toBe(0);

      // Rewind to the second retained user, including legacy replay that had
      // advanced beyond the fixed compaction boundary.
      const planned = copy.messages.slice(0, -2);
      inheritArchiveHashProof(copy.messages, planned);
      const checkpoint = copy.messages.at(-2)!.contextCheckpoint!;
      expect(checkpoint.transcriptHistoryCount).toBe(2);
      expect(checkpoint.transcriptPrefixHash).toBe(historyPrefixHash(copy.messages, 2));
      const activeContext = rewindActiveContextToHistoryCount(copy.activeContext!, planned, 2);
      expect(activeContext).not.toBeNull();
      const edited = { ...copy, messages: planned, activeContext };
      store.saveUnwind(copy, edited, 2, {
        operationId: "copy-edit", userMessageIndex: 1, historyTotalEntries: 3, messageCount: 2, supersededQueueIds: [],
      });
      const restarted = new SqliteConversationStore({ path: store.path });
      stores.push(restarted);
      const loaded = restarted.load(copy.id)!;
      expect(buildConversationApiContext(loaded).messages).toHaveLength(3);
      loaded.messages.push({ role: "user", content: "new independent task", metadata: null });
      restarted.appendMessages(loaded, 4);
      expect(restarted.cloneConversation(copy.id, { ...target, id: "copy-again" })).not.toBeNull();
      restarted.db.query("DELETE FROM conversations WHERE id=?").run(source.id);
      expect(restarted.load("copy-again")?.messages.at(-1)?.content).toBe("new independent task");
      expect(restarted.integrityCheck().ok).toBe(true);
    });
  }
}

test("copy does not read or retain superseded canonical bodies or display rows", () => {
  const store = database();
  const source = fixture();
  store.save(source);
  // Broken superseded bytes must neither block copying nor be blessed/copied.
  store.db.query("UPDATE messages SET content_json='broken' WHERE conversation_id=? AND sequence=2").run(source.id);
  store.db.query("UPDATE display_entries SET payload_json='broken' WHERE conversation_id=?").run(source.id);
  expect(store.cloneConversation(source.id, target)).not.toBeNull();
  expect(store.load(target.id)?.messages).toHaveLength(6);
  expect(store.loadDisplayPage(target.id, 20)?.entries).toHaveLength(4);
  expect(store.db.query<{ content_json: string }, []>("SELECT content_json FROM messages WHERE conversation_id='source' AND sequence=2")
    .get()?.content_json).toBe("broken");
  expect(store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM messages WHERE conversation_id='copy'").get()?.n).toBe(6);
});

test("missing/corrupt checkpoints and corrupt retained tail fail closed without an undo record", () => {
  for (const corruption of ["checkpoint", "missing", "tail"]) {
    const store = database();
    const source = fixture();
    store.save(source);
    if (corruption === "checkpoint") store.db.exec("UPDATE active_contexts SET payload_json='{}'");
    else if (corruption === "missing") store.db.exec("DELETE FROM active_contexts");
    else store.db.exec("UPDATE messages SET content_json='\"corrupt\"' WHERE sequence=4");
    expect(() => store.cloneConversation(source.id, target)).toThrow();
    expect(store.has(target.id)).toBe(false);
    expect(store.popUndoEntry()).toBeNull();
  }
});

test("checkpoint-only copies, instructions, and all transaction rollback boundaries", () => {
  let failAt = "";
  const store = database(point => { if (point === failAt) throw new Error(point); });
  const source = fixture();
  source.messages.splice(4);
  store.save(source);
  for (const point of ["clone.after-conversation", "clone.after-messages", "clone.after-display", "clone.before-commit"]) {
    failAt = point;
    expect(() => store.cloneConversation(source.id, target)).toThrow(point);
    expect(store.has(target.id)).toBe(false);
    expect(store.popUndoEntry()).toBeNull();
  }
  failAt = "";
  expect(store.cloneConversation(source.id, target)?.messageCount).toBe(0);
  const copy = store.load(target.id)!;
  expect(copy.messages).toHaveLength(2);
  expect(copy.messages[0].content).toBe("Keep these instructions");
  expect(buildConversationApiContext(copy)).toEqual(buildConversationApiContext(source));
  expect(store.popUndoEntry()).toEqual({ type: "conversation_removed", id: target.id });
});

test("a source revision change between snapshot and commit cannot create a stale copy", () => {
  const store = database();
  const source = fixture();
  store.save(source);
  const read = store.loadRuntimeWindow.bind(store);
  store.loadRuntimeWindow = (...args) => {
    const result = read(...args);
    store.updateConversationPresentation(source.id, { title: "changed during copy" });
    return result;
  };
  expect(() => store.cloneConversation(source.id, target)).toThrow("Clone source changed");
  expect(store.has(target.id)).toBe(false);
  expect(store.popUndoEntry()).toBeNull();
});

test("uncompacted copies retain all messages without sharing mutable values", () => {
  const source = createConversation("plain", "openai", "gpt-6.1-sol", 0);
  source.messages.push({ role: "user", content: "task", metadata: null });
  const copy = clonedConversationValue(source, target);
  expect(copy.messages).toEqual(source.messages);
  copy.messages[0].content = "changed";
  expect(source.messages[0].content).toBe("task");
});

test("the newest checkpoint wins; earlier compaction dividers stay in the original", () => {
  const source = fixture();
  source.messages.splice(2, 0, {
    role: "system", content: CONTEXT_COMPACTION_FINISHED_TEXT,
    metadata: { startedAt: 50, endedAt: 50, model: source.model, tokens: 0, kind: CONTEXT_COMPACTION_FINISHED_KIND },
  });
  const store = database();
  store.save(source);
  store.cloneConversation(source.id, target);
  const copy = store.load(target.id)!;
  expect(copy.messages.filter(message => message.metadata?.kind === CONTEXT_COMPACTION_FINISHED_KIND)
    .map(message => message.metadata!.startedAt)).toEqual([100]);
  expect(copy.activeContext?.windowNumber).toBe(2);
  source.activeContext = null;
  expect(() => clonedConversationValue(source, target)).toThrow("missing compaction checkpoint");
});

test("retained tool/image payloads and a mid-turn continuation survive source deletion", () => {
  const store = database();
  const source = fixture();
  source.messages.splice(4, 0,
    { role: "assistant", content: [{ type: "tool_use", id: "recent-tool", name: "exec_command", input: { cmd: "true" } }], metadata: null },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "recent-tool", content: "retained output".repeat(10_000) }], metadata: null },
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }], metadata: null },
  );
  store.save(source);
  expect(store.cloneConversation(source.id, target)).not.toBeNull();
  store.db.query("DELETE FROM conversations WHERE id=?").run(source.id);
  const copy = store.load(target.id)!;
  const replay = (conv: Conversation) => buildConversationApiContext(conv).messages.map(({ contextCheckpoint, ...message }) => message);
  expect(replay(copy)).toEqual(replay(source));
  expect(store.loadToolOutputs(target.id)).toEqual([{ toolCallId: "recent-tool", output: "retained output".repeat(10_000) }]);
  expect(store.integrityCheck().ok).toBe(true);
});
