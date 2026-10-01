import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { loadConversationOffThread, prepareArchiveHashes, releaseArchiveWindow, stopConversationLoader } from "./conversation-loader";
import { archiveWindow, inheritArchiveHashProof, isArchivedMessage } from "./conversation-window";
import { titleContext } from "./conversation-title-context";
import {
  CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT,
  createConversation, createStoredUserContextCheckpoint, currentReplayHistoryPrefix,
  historyPrefixHash, isValidActiveContextCached, type Conversation, type StoredMessage,
} from "./messages";
import { buildConversationApiContext } from "./context-compaction";

const stores: SqliteConversationStore[] = [];
const roots: string[] = [];
afterEach(() => {
  stopConversationLoader();
  for (const store of stores.splice(0)) store.close();
  if (process.platform === "win32") Bun.gc(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
});

function fixture(size = 16_000, rounds = 8) {
  const root = mkdtempSync(join(tmpdir(), "exo-archive-worker-"));
  roots.push(root);
  const store = new SqliteConversationStore({ path: join(root, "store.sqlite3") });
  stores.push(store);
  const conv = createConversation("worker-fixture", "openai", "gpt-6.1-sol", 0, "fixture");
  conv.messages.push({ role: "system_instructions", content: "instructions", metadata: null });
  conv.messages.push({ role: "user", content: "original task for title", metadata: null });
  for (let i = 0; i < rounds; i++) conv.messages.push(
    { role: "assistant", content: [{ type: "tool_use", id: `tool-${i}`, name: "exec_command", input: { cmd: "true" } }], metadata: null },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `tool-${i}`, content: `${i}:` + "x".repeat(size) }], metadata: null },
  );
  const prefix = currentReplayHistoryPrefix(conv.messages);
  conv.activeContext = {
    version: 1, kind: "openai_native", provider: "openai", model: conv.model,
    messages: [{ role: "assistant", content: [], providerData: { openai: { compactionItems: [{ encryptedContent: "opaque" }] } } }],
    transcriptHistoryCount: prefix.historyCount, transcriptPrefixHash: prefix.hash,
    compactionHistoryCount: prefix.historyCount, compactionPrefixHash: prefix.hash,
    windowId: `${conv.id}:1`, windowNumber: 1, compactedAt: 123, compactionCount: 1,
  };
  conv.messages.push({
    role: "system", content: CONTEXT_COMPACTION_FINISHED_TEXT,
    metadata: { startedAt: 123, endedAt: 123, model: conv.model, tokens: 0, kind: CONTEXT_COMPACTION_FINISHED_KIND },
  });
  conv.messages.push({ role: "user", content: "recent editable task", metadata: null });
  conv.messages.push({ role: "assistant", content: "recent answer", metadata: null });
  store.save(conv);
  return { store, conv };
}

async function load(store: SqliteConversationStore, conv: Conversation) {
  const result = await loadConversationOffThread(conv.id, false, store.path);
  expect(result).not.toBeNull();
  expect(store.adoptLoadedConversation(result!)).toBe(true);
  return result!.conversation;
}

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  let error: unknown;
  try { await promise; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(pattern);
}

test("worker keeps a checkpoint and actual tail, never a huge single-user group", async () => {
  const { store, conv } = fixture();
  const loaded = await load(store, conv);
  expect(archiveWindow(loaded.messages)?.prefixSequence).toBe(conv.messages.length - 3);
  expect(loaded.messages.filter(isArchivedMessage)).toHaveLength(conv.messages.length - 3);
  expect(JSON.stringify(loaded).length).toBeLessThan(15_000);
  expect(isValidActiveContextCached(loaded.activeContext!, loaded.messages)).toBe(true);
  expect(buildConversationApiContext(loaded)).toEqual(buildConversationApiContext(conv));
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(currentReplayHistoryPrefix(conv.messages));
  expect(createStoredUserContextCheckpoint(loaded)).toEqual(createStoredUserContextCheckpoint(conv));
  expect(titleContext(loaded)).toEqual(titleContext(conv));
  expect(titleContext(loaded, "extra")).toEqual(titleContext(conv, "extra"));
  expect(() => { (loaded.messages[1] as StoredMessage).content = "fake"; }).toThrow();
});

test("appends, metadata, attribution and indexed display never overwrite archived bytes", async () => {
  const { store, conv } = fixture();
  const before = store.exportConversation(conv.id)!;
  const loaded = await load(store, conv);
  loaded.title = "renamed";
  store.save(loaded);
  const message: StoredMessage = { role: "user", content: "new task", metadata: null };
  const count = loaded.messages.length;
  loaded.messages.push(message);
  store.appendMessages(loaded, count);
  // Old immutable checkpoints remain usable without rehashing an appended tail.
  expect(isValidActiveContextCached(loaded.activeContext!, loaded.messages)).toBe(true);
  await prepareArchiveHashes(loaded.messages);
  expect(createStoredUserContextCheckpoint(loaded)).not.toBeNull();
  store.save(loaded, { forceMessages: true });
  loaded.lastContextTokens = 123;
  store.saveContextAttribution(loaded);
  const canonical = store.load(conv.id)!;
  expect(canonical.messages.slice(0, count)).toEqual(before.messages as StoredMessage[]);
  expect(store.loadDisplayPage(conv.id, 100)?.entries).toEqual(
    (() => { const other = new SqliteConversationStore({ path: join(roots.at(-1)!, "comparison.sqlite3") }); stores.push(other); other.save(canonical); return other.loadDisplayPage(conv.id, 100)?.entries; })(),
  );
  expect(store.integrityCheck().ok).toBe(true);
});

test("off-thread proofs refresh after appends, copy to unwind plans, reject replacements", async () => {
  const { store, conv } = fixture();
  const loaded = await load(store, conv);
  const planned = loaded.messages.slice(0, -1);
  inheritArchiveHashProof(loaded.messages, planned);
  expect(currentReplayHistoryPrefix(planned)).toEqual(currentReplayHistoryPrefix(conv.messages.slice(0, -1)));
  loaded.messages.push({ role: "user", content: "queued one", metadata: null });
  expect(() => currentReplayHistoryPrefix(loaded.messages)).toThrow(/refresh|Missing/);
  await prepareArchiveHashes(loaded.messages);
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(currentReplayHistoryPrefix([...conv.messages, loaded.messages.at(-1)!]));
  const tail = loaded.messages.at(-1)!;
  tail.content = "changed";
  expect(() => currentReplayHistoryPrefix(loaded.messages)).toThrow(/refresh/);
  await prepareArchiveHashes(loaded.messages);
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(currentReplayHistoryPrefix([...conv.messages, tail]));
  loaded.messages[0] = { role: "system_instructions", content: "replacement", metadata: null };
  await rejects(prepareArchiveHashes(loaded.messages), /changed/);
});

test("worker loss restores native hash state from verified canonical bytes", async () => {
  const { store, conv } = fixture();
  const loaded = await load(store, conv);
  stopConversationLoader("simulated worker crash");
  loaded.messages.push({ role: "user", content: "after worker crash", metadata: null });
  await prepareArchiveHashes(loaded.messages);
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(currentReplayHistoryPrefix([...conv.messages, loaded.messages.at(-1)!]));
  releaseArchiveWindow(loaded.messages);
  store.db.query("UPDATE messages SET content_json=? WHERE conversation_id=? AND sequence=1").run(JSON.stringify("corrupt"), conv.id);
  loaded.messages.push({ role: "user", content: "force another refresh", metadata: null });
  await rejects(prepareArchiveHashes(loaded.messages), /prefix changed/);
});

test("corrupt checkpoint, missing checkpoint and archive holes fail closed", async () => {
  const { store, conv } = fixture();
  const active = { ...conv.activeContext!, transcriptPrefixHash: "bad" };
  store.db.query("UPDATE active_contexts SET payload_json=? WHERE conversation_id=?").run(JSON.stringify(active), conv.id);
  let loaded = await load(store, conv);
  expect(loaded.activeContext?.transcriptPrefixHash).toBe("bad");
  expect(() => buildConversationApiContext(loaded)).toThrow(/checkpoint is invalid/);
  store.db.query("DELETE FROM active_contexts WHERE conversation_id=?").run(conv.id);
  loaded = await load(store, conv);
  expect(loaded.messages.every(isArchivedMessage)).toBe(true);
  expect(() => buildConversationApiContext(loaded)).toThrow(/checkpoint is missing/);
  store.db.query("DELETE FROM messages WHERE conversation_id=? AND sequence=2").run(conv.id);
  await rejects(loadConversationOffThread(conv.id, false, store.path), /Non-contiguous/);
});

test("stale worker generations and deleted conversations cannot be adopted", async () => {
  const { store, conv } = fixture();
  const result = await loadConversationOffThread(conv.id, false, store.path);
  conv.title = "new durable state";
  store.save(conv);
  expect(store.adoptLoadedConversation(result!)).toBe(false);
  const next = await loadConversationOffThread(conv.id, false, store.path);
  store.db.query("UPDATE conversations SET deleted_at=1 WHERE id=?").run(conv.id);
  expect(store.adoptLoadedConversation(next!)).toBe(false);
  expect(await loadConversationOffThread(conv.id, false, store.path)).toBeNull();
});

test("missing and corrupted canonical blobs invalidate the checkpoint without replay fallback", async () => {
  const { store, conv } = fixture();
  const blob = store.db.query<{ message_sequence: number; ordinal: number; payload_json: string }, [string]>(
    "SELECT message_sequence, ordinal, payload_json FROM message_blobs WHERE conversation_id=? AND kind='tool_result' LIMIT 1",
  ).get(conv.id)!;
  store.db.query("UPDATE message_blobs SET payload_json=? WHERE conversation_id=? AND message_sequence=? AND kind='tool_result' AND ordinal=?")
    .run(JSON.stringify({ blockIndex: 0, value: "tampered" }), conv.id, blob.message_sequence, blob.ordinal);
  let loaded = await load(store, conv);
  expect(isValidActiveContextCached(loaded.activeContext!, loaded.messages)).toBe(false);
  expect(() => buildConversationApiContext(loaded)).toThrow(/checkpoint is invalid/);
  releaseArchiveWindow(loaded.messages);
  store.db.query("DELETE FROM message_blobs WHERE conversation_id=? AND message_sequence=? AND kind='tool_result' AND ordinal=?")
    .run(conv.id, blob.message_sequence, blob.ordinal);
  loaded = await load(store, conv);
  expect(() => buildConversationApiContext(loaded)).toThrow(/checkpoint is invalid/);
});

test("cloned copy-on-write archives get the same integrity proof and rebound checkpoint", async () => {
  const { store, conv } = fixture();
  const cloneId = "cloned-worker-fixture";
  expect(store.cloneConversation(conv.id, {
    id: cloneId, title: "cloned", sortOrder: 1, createdAt: 100, updatedAt: 100,
  })).not.toBeNull();
  const canonical = store.load(cloneId)!;
  const result = await loadConversationOffThread(cloneId, false, store.path);
  expect(store.adoptLoadedConversation(result!)).toBe(true);
  const loaded = result!.conversation;
  expect(archiveWindow(loaded.messages)?.prefixSequence).toBe(conv.messages.length - 3);
  expect(loaded.activeContext?.windowId).toBe(`${cloneId}:1`);
  expect(buildConversationApiContext(loaded)).toEqual(buildConversationApiContext(canonical));
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(currentReplayHistoryPrefix(conv.messages));
  loaded.messages.push({ role: "user", content: "clone-only append", metadata: null });
  await prepareArchiveHashes(loaded.messages);
  store.appendMessages(loaded, canonical.messages.length);
  expect(store.load(conv.id)?.messages).toEqual(conv.messages);
  expect(store.integrityCheck().ok).toBe(true);
});

test("truncating or replacing headers cannot delete canonical archive rows", async () => {
  const { store, conv } = fixture();
  const loaded = await load(store, conv);
  loaded.activeContext = null;
  loaded.messages.splice(0);
  expect(() => store.save(loaded, { forceMessages: true })).toThrow(/prefix was changed/);
  expect(store.load(conv.id)?.messages.length).toBe(conv.messages.length);
});

test("legacy checkpoints use their fixed divider, not the advancing replay cursor", async () => {
  const { store, conv } = fixture();
  const active = conv.activeContext!;
  delete active.compactionHistoryCount;
  delete active.compactionPrefixHash;
  active.messages.push({ role: "user", content: "recent editable task" }, { role: "assistant", content: "recent answer" });
  active.transcriptHistoryCount += 2;
  active.transcriptPrefixHash = historyPrefixHash(conv.messages, active.transcriptHistoryCount);
  conv.activeContext = structuredClone(active);
  store.save(conv);
  const loaded = await load(store, conv);
  expect(archiveWindow(loaded.messages)?.prefixSequence).toBe(conv.messages.length - 3);
  expect(buildConversationApiContext(loaded)).toEqual(buildConversationApiContext(conv));
});

test("even noncompacted cold transcripts use worker proofs instead of foreground hashing", async () => {
  const { store, conv } = fixture();
  conv.activeContext = null;
  conv.messages = conv.messages.filter(message => message.metadata?.kind !== CONTEXT_COMPACTION_FINISHED_KIND);
  store.save(conv, { forceMessages: true });
  const loaded = await load(store, conv);
  expect(archiveWindow(loaded.messages)?.prefixSequence).toBe(0);
  expect(loaded.messages.some(isArchivedMessage)).toBe(false);
  const expected = currentReplayHistoryPrefix(conv.messages);
  const original = JSON.stringify;
  let serializations = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { serializations++; return original(...args); }) as typeof JSON.stringify;
  try {
    expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(expected);
    expect(createStoredUserContextCheckpoint(loaded)?.transcriptPrefixHash).toBe(expected.hash);
    expect(serializations).toBe(0);
  } finally { JSON.stringify = original; }
});
