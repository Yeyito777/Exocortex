import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { loadConversationOffThread, prefetchConversation, prepareArchiveHashes, releaseArchiveWindow, stopConversationLoader } from "./conversation-loader";
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

test("verified windows survive release/eviction and unrelated writes without rereading the archive", async () => {
  const { store, conv } = fixture();
  const first = await loadConversationOffThread(conv.id, false, store.path);
  expect(first!.loadDiagnostics).toEqual({ cacheHit: false, archiveRowsRead: conv.messages.length });
  releaseArchiveWindow(first!.conversation.messages, first!.window?.handle);
  const other = createConversation("unrelated", "openai", "gpt-6.1-sol", 1);
  store.save(other);
  const next = await loadConversationOffThread(conv.id, false, store.path);
  expect(next!.loadDiagnostics).toEqual({ cacheHit: true, archiveRowsRead: 0 });
  expect(next!.window?.handle).not.toBe(first!.window?.handle);
  expect(store.adoptLoadedConversation(next!)).toBe(true);
  expect(currentReplayHistoryPrefix(next!.conversation.messages)).toEqual(currentReplayHistoryPrefix(conv.messages));
});

test("prefetch validates off-thread and admission consumes a zero-scan cached window", async () => {
  const { store, conv } = fixture();
  expect(await prefetchConversation(conv.id, store.path)).toBe(true);
  const next = await loadConversationOffThread(conv.id, false, store.path);
  expect(next!.loadDiagnostics?.cacheHit).toBe(true);
  expect(store.adoptLoadedConversation(next!)).toBe(true);
  next!.conversation.messages.push({ role: "user", content: "after prefetch", metadata: null });
  await prepareArchiveHashes(next!.conversation.messages);
  expect(createStoredUserContextCheckpoint(next!.conversation)).not.toBeNull();
});

test("out-of-band canonical, metadata and checkpoint edits invalidate cached proofs", async () => {
  const { store, conv } = fixture();
  const before = await loadConversationOffThread(conv.id, false, store.path);
  store.db.query("UPDATE conversations SET title='external title' WHERE id=?").run(conv.id);
  expect(store.adoptLoadedConversation(before!)).toBe(false);
  const changed = await loadConversationOffThread(conv.id, false, store.path);
  expect(changed!.loadDiagnostics?.cacheHit).toBe(false);
  expect(changed!.conversation.title).toBe("external title");
  store.db.query("UPDATE messages SET content_json=? WHERE conversation_id=? AND sequence=1").run(JSON.stringify("tampered"), conv.id);
  const damaged = await loadConversationOffThread(conv.id, false, store.path);
  expect(damaged!.loadDiagnostics?.cacheHit).toBe(false);
  expect(store.adoptLoadedConversation(damaged!)).toBe(true);
  expect(() => buildConversationApiContext(damaged!.conversation)).toThrow(/checkpoint is invalid/);
});

test("canonical fallback preserves legacy whitespace and provider-null semantics", async () => {
  const { store, conv } = fixture();
  store.db.query("UPDATE messages SET content_json=? WHERE conversation_id=? AND sequence=1")
    .run('  "original task for title"  ', conv.id);
  store.db.query("UPDATE messages SET provider_data_json=' null ', has_provider_data=1 WHERE conversation_id=? AND sequence=2").run(conv.id);
  const loaded = await load(store, conv);
  expect(isValidActiveContextCached(loaded.activeContext!, loaded.messages)).toBe(true);
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(currentReplayHistoryPrefix(conv.messages));
});

test("SQL rollback leaves cache receipts valid, and unknown edits cannot be blessed by metadata writes", async () => {
  const { store, conv } = fixture();
  const loaded = await load(store, conv);
  expect(() => store.db.transaction(() => {
    store.db.query("UPDATE messages SET content_json='\"rolled back\"' WHERE conversation_id=? AND sequence=1").run(conv.id);
    throw new Error("rollback");
  })()).toThrow("rollback");
  expect((await loadConversationOffThread(conv.id, false, store.path))!.loadDiagnostics?.cacheHit).toBe(true);
  store.db.query("UPDATE messages SET content_json='\"tampered\"' WHERE conversation_id=? AND sequence=1").run(conv.id);
  const before = loaded.messages.length;
  loaded.messages.push({ role: "user", content: "must not commit", metadata: null });
  store.updateConversationPresentation(conv.id, { title: "metadata" });
  store.saveConversationSidebarState({ id: conv.id, folderId: null, pinned: true, sortOrder: 1 });
  expect(() => store.appendMessages(loaded, before)).toThrow(/Stale conversation revision/);
  expect(store.load(conv.id)!.messages.length).toBe(before);
});

test("unwind queue-cleanup acknowledgements do not invalidate the freshly loaded runtime receipt", async () => {
  const { store, conv } = fixture();
  store.db.query(`INSERT INTO unwind_receipts(
    conversation_id, operation_id, user_message_index, history_total_entries, superseded_queue_ids_json
  ) VALUES (?, 'unwind-operation', 1, 2, '["old-queue"]')`).run(conv.id);
  const loaded = await load(store, conv);
  store.acknowledgeUnwindQueueCleanup(conv.id, "unwind-operation");
  store.acknowledgeRecoveredUnwindQueueCleanup();
  expect((await loadConversationOffThread(conv.id, false, store.path))!.loadDiagnostics?.cacheHit).toBe(true);
  const count = loaded.messages.length;
  loaded.messages.push({ role: "user", content: "after cleanup", metadata: null });
  store.appendMessages(loaded, count);
  expect(store.load(conv.id)!.messages.at(-1)?.content).toBe("after cleanup");
});

test("a writer winning between the preliminary check and BEGIN cannot authorize a stale append", async () => {
  const { store, conv } = fixture();
  const loaded = await load(store, conv);
  const count = loaded.messages.length;
  loaded.messages.push({ role: "user", content: "must not commit", metadata: null });
  const transaction = store.db.transaction;
  const descriptor = Object.getOwnPropertyDescriptor(store.db, "transaction");
  Object.defineProperty(store.db, "transaction", {
    configurable: true,
    value: (...args: unknown[]) => {
      store.db.query("UPDATE messages SET content_json='\"writer won\"' WHERE conversation_id=? AND sequence=1").run(conv.id);
      return Reflect.apply(transaction, store.db, args);
    },
  });
  try { expect(() => store.appendMessages(loaded, count)).toThrow(/Stale conversation revision/); }
  finally {
    if (descriptor) Object.defineProperty(store.db, "transaction", descriptor);
    else Reflect.deleteProperty(store.db, "transaction");
  }
  expect(store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?").get(conv.id)!.n).toBe(count);
});

test.skipIf(process.platform === "win32")("atomic database replacement cannot authorize an old worker cache", async () => {
  const { store, conv } = fixture();
  await loadConversationOffThread(conv.id, false, store.path);
  // Checkpoint the owned test file before moving it; never move a live main DB.
  store.checkpoint("TRUNCATE");
  renameSync(store.path, store.path + ".old");
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(store.path + suffix)) renameSync(store.path + suffix, store.path + ".old" + suffix);
  }
  const replacement = new SqliteConversationStore({ path: store.path });
  stores.push(replacement);
  replacement.save(conv);
  await rejects(loadConversationOffThread(conv.id, false, store.path), /database was replaced/);
});

test("owner blob edits invalidate verified clone windows through alias revision fanout", async () => {
  const { store, conv } = fixture();
  const id = "cached-alias";
  store.cloneConversation(conv.id, { id, title: "copy", sortOrder: 2, createdAt: 100, updatedAt: 100 });
  await loadConversationOffThread(id, false, store.path);
  store.db.query("UPDATE message_blobs SET payload_json=? WHERE conversation_id=? AND message_sequence=3 AND kind='tool_result'")
    .run(JSON.stringify({ blockIndex: 0, value: "changed owner" }), conv.id);
  const result = await loadConversationOffThread(id, false, store.path);
  expect(result!.loadDiagnostics?.cacheHit).toBe(false);
  expect(store.adoptLoadedConversation(result!)).toBe(true);
  expect(() => buildConversationApiContext(result!.conversation)).toThrow(/checkpoint is invalid/);
});

test("missing revision triggers cannot silently authorize a cached checkpoint", async () => {
  const { store, conv } = fixture();
  await loadConversationOffThread(conv.id, false, store.path);
  store.db.exec("DROP TRIGGER runtime_revision_messages_update");
  await rejects(loadConversationOffThread(conv.id, false, store.path), /revision trigger is missing or changed/);
});

test("urgent native tail hashing is serviced during a cooperative archive scan", async () => {
  const { store, conv } = fixture(2048, 4000);
  const small = createConversation("hash-owner", "openai", "gpt-6.1-sol", 1);
  small.messages.push({ role: "user", content: "small", metadata: null });
  store.save(small);
  const owner = await load(store, small);
  owner.messages.push({ role: "user", content: "urgent", metadata: null });
  let completed = false;
  const slow = loadConversationOffThread(conv.id, false, store.path).then(result => { completed = true; return result; });
  await prepareArchiveHashes(owner.messages);
  expect(completed).toBe(false);
  expect(currentReplayHistoryPrefix(owner.messages)).toEqual(currentReplayHistoryPrefix([...small.messages, owner.messages.at(-1)!]));
  expect(await slow).not.toBeNull();
}, 20_000);

test("foreground loads use a free lane, while same-chat admission joins a prefetch instead of rescanning", async () => {
  const { store, conv } = fixture(2048, 4000);
  const small = createConversation("other-lane", "openai", "gpt-6.1-sol", 1);
  small.messages.push({ role: "user", content: "small", metadata: null });
  store.save(small);
  let finished = false;
  const warming = prefetchConversation(conv.id, store.path).then(result => { finished = true; return result; });
  const independent = await loadConversationOffThread(small.id, false, store.path);
  expect(independent).not.toBeNull();
  expect(finished).toBe(false);
  const joined = await loadConversationOffThread(conv.id, false, store.path);
  expect(await warming).toBe(true);
  expect(joined!.loadDiagnostics).toEqual({ cacheHit: true, archiveRowsRead: 0 });
  expect(store.adoptLoadedConversation(joined!)).toBe(true);
  expect(currentReplayHistoryPrefix(joined!.conversation.messages)).toEqual(currentReplayHistoryPrefix(conv.messages));
}, 20_000);

test("worker cache has a hard LRU entry bound and never retains full/uncompacted archives", async () => {
  const { store, conv } = fixture(1024, 2);
  for (let index = 0; index < 9; index++) {
    const id = `cache-lru-${index}`;
    store.cloneConversation(conv.id, { id, title: "LRU", sortOrder: index + 1, createdAt: 100, updatedAt: 100 });
    const loaded = await loadConversationOffThread(id, false, store.path);
    releaseArchiveWindow(loaded!.conversation.messages, loaded!.window?.handle);
  }
  expect((await loadConversationOffThread("cache-lru-0", false, store.path))!.loadDiagnostics?.cacheHit).toBe(false);
  expect((await loadConversationOffThread("cache-lru-8", false, store.path))!.loadDiagnostics?.cacheHit).toBe(true);
  expect((await loadConversationOffThread(conv.id, true, store.path))!.loadDiagnostics?.cacheHit).toBe(false);
  const plain = createConversation("not-compacted", "openai", "gpt-6.1-sol", 2);
  plain.messages.push({ role: "user", content: "plain", metadata: null });
  store.save(plain);
  expect(await prefetchConversation(plain.id, store.path)).toBe(false);
});
