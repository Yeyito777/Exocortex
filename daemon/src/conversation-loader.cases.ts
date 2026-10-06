import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { loadConversationOffThread, loadToolOutputsOffThread, prefetchConversation, prepareArchiveHashes, releaseArchiveWindow, stopConversationLoader } from "./conversation-loader";
import { checkpointTailHasher, updateCheckpointTailHash, integritySha } from "./checkpoint-tail-integrity";
import { archiveWindow, inheritArchiveHashProof, isArchivedMessage, storedMessageCount, systemInstructionMessages } from "./conversation-window";
import { titleContext } from "./conversation-title-context";
import { workTimerForTurn } from "./work-timer";
import {
  CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT,
  createConversation, createStoredUserContextCheckpoint, currentReplayHistoryPrefix, countConversationMessages,
  historyPrefixHash, isReplayHistoryMessage, isValidActiveContextCached, rewindActiveContextToHistoryCount, type Conversation, type StoredMessage,
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

function checkpointPrefix(conv: Conversation, messages = conv.messages) {
  const anchor = { historyCount: conv.activeContext!.transcriptHistoryCount, hash: conv.activeContext!.transcriptPrefixHash };
  const hash = checkpointTailHasher(anchor);
  let count = 0;
  for (const message of messages) {
    if (!isReplayHistoryMessage(message)) continue;
    if (count >= anchor.historyCount) updateCheckpointTailHash(hash, message);
    count++;
  }
  return { historyCount: count, hash: count === anchor.historyCount ? anchor.hash : hash.digest("hex") };
}

test("worker keeps a checkpoint and actual tail, never a huge single-user group", async () => {
  const { store, conv } = fixture();
  const loaded = await load(store, conv);
  expect(archiveWindow(loaded.messages)?.prefixSequence).toBe(conv.messages.length - 3);
  expect(loaded.messages.filter(isArchivedMessage)).toHaveLength(0);
  expect(loaded.messages).toHaveLength(3);
  expect(storedMessageCount(loaded.messages)).toBe(conv.messages.length);
  expect(JSON.stringify(loaded).length).toBeLessThan(15_000);
  expect(isValidActiveContextCached(loaded.activeContext!, loaded.messages)).toBe(true);
  expect(buildConversationApiContext(loaded)).toEqual(buildConversationApiContext(conv));
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(checkpointPrefix(conv));
  expect(createStoredUserContextCheckpoint(loaded)).toMatchObject({
    transcriptHistoryCount: checkpointPrefix(conv).historyCount, transcriptPrefixHash: checkpointPrefix(conv).hash,
  });
  expect(titleContext(loaded)).toEqual(titleContext(conv));
  expect(titleContext(loaded, "extra")).toEqual(titleContext(conv, "extra"));
  expect(() => { systemInstructionMessages(loaded.messages)[0].content = "fake"; }).toThrow();
});

test("appends, metadata, attribution and indexed display never overwrite archived bytes", async () => {
  const { store, conv } = fixture();
  const before = store.exportConversation(conv.id)!;
  const loaded = await load(store, conv);
  loaded.title = "renamed";
  store.save(loaded);
  const message: StoredMessage = { role: "user", content: "new task", metadata: null };
  const count = storedMessageCount(loaded.messages);
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
  expect(currentReplayHistoryPrefix(planned)).toEqual(checkpointPrefix(conv, conv.messages.slice(0, -1)));
  loaded.messages.push({ role: "user", content: "queued one", metadata: null });
  expect(() => currentReplayHistoryPrefix(loaded.messages)).toThrow(/refresh|Missing/);
  await prepareArchiveHashes(loaded.messages);
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(checkpointPrefix(conv, [...conv.messages, loaded.messages.at(-1)!]));
  const tail = loaded.messages.at(-1)!;
  tail.content = "changed";
  expect(() => currentReplayHistoryPrefix(loaded.messages)).toThrow(/refresh/);
  await prepareArchiveHashes(loaded.messages);
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(checkpointPrefix(conv, [...conv.messages, tail]));
  expect(() => { archiveWindow(loaded.messages)!.prefixSequence = 0; }).toThrow();
  expect(() => { archiveWindow(loaded.messages)!.sparse!.userCount = 0; }).toThrow();
  expect(() => { archiveWindow(loaded.messages)!.hashAnchor!.hash = "changed"; }).toThrow();
});

test("worker loss restores checkpoint-tail state without reading superseded canonical bytes", async () => {
  const { store, conv } = fixture();
  const loaded = await load(store, conv);
  stopConversationLoader("simulated worker crash");
  loaded.messages.push({ role: "user", content: "after worker crash", metadata: null });
  await prepareArchiveHashes(loaded.messages);
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(checkpointPrefix(conv, [...conv.messages, loaded.messages.at(-1)!]));
  releaseArchiveWindow(loaded.messages);
  store.db.query("UPDATE messages SET content_json=? WHERE conversation_id=? AND sequence=1").run(JSON.stringify("corrupt"), conv.id);
  loaded.messages.push({ role: "user", content: "force another refresh", metadata: null });
  await prepareArchiveHashes(loaded.messages);
  expect(currentReplayHistoryPrefix(loaded.messages).historyCount).toBe(21);
  await rejects(loadConversationOffThread(conv.id, true, store.path), /integrity/);
});

test("corrupt/missing checkpoints fail admission; archive holes fail when requested", async () => {
  const { store, conv } = fixture();
  const active = { ...conv.activeContext!, transcriptPrefixHash: "bad" };
  store.db.query("UPDATE active_contexts SET payload_json=? WHERE conversation_id=?").run(JSON.stringify(active), conv.id);
  await rejects(loadConversationOffThread(conv.id, false, store.path), /Checkpoint integrity/);
  store.db.query("UPDATE active_contexts SET payload_json=? WHERE conversation_id=?").run(JSON.stringify(conv.activeContext), conv.id);
  store.db.query("DELETE FROM messages WHERE conversation_id=? AND sequence=2").run(conv.id);
  expect((await loadConversationOffThread(conv.id, false, store.path))!.loadDiagnostics?.archivedHeadersRead).toBe(0);
  await rejects(loadConversationOffThread(conv.id, true, store.path), /missing/);
  store.save(conv, { forceMessages: true });
  store.db.query("DELETE FROM active_contexts WHERE conversation_id=?").run(conv.id);
  await rejects(loadConversationOffThread(conv.id, false, store.path), /checkpoint is missing/);
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

test("old missing/corrupt blobs do not block resume but fail closed on requested expansion", async () => {
  const { store, conv } = fixture();
  const blob = store.db.query<{ message_sequence: number; ordinal: number; payload_json: string }, [string]>(
    "SELECT message_sequence, ordinal, payload_json FROM message_blobs WHERE conversation_id=? AND kind='tool_result' LIMIT 1",
  ).get(conv.id)!;
  store.db.query("UPDATE message_blobs SET payload_json=? WHERE conversation_id=? AND message_sequence=? AND kind='tool_result' AND ordinal=?")
    .run(JSON.stringify({ blockIndex: 0, value: "tampered" }), conv.id, blob.message_sequence, blob.ordinal);
  let loaded = await load(store, conv);
  expect(isValidActiveContextCached(loaded.activeContext!, loaded.messages)).toBe(true);
  expect(buildConversationApiContext(loaded)).toEqual(buildConversationApiContext(conv));
  await rejects(loadToolOutputsOffThread(conv.id, ["tool-0"], store.path), /blob checksum/);
  expect((await loadToolOutputsOffThread(conv.id, ["tool-1"], store.path))?.[0].toolCallId).toBe("tool-1");
  releaseArchiveWindow(loaded.messages);
  store.db.query("DELETE FROM message_blobs WHERE conversation_id=? AND message_sequence=? AND kind='tool_result' AND ordinal=?")
    .run(conv.id, blob.message_sequence, blob.ordinal);
  loaded = await load(store, conv);
  expect(buildConversationApiContext(loaded).usedActiveContext).toBe(true);
  await rejects(loadToolOutputsOffThread(conv.id, ["tool-0"], store.path), /missing or duplicate/);
});

test("clones retain only the checkpoint/tail with independent offsets and integrity proofs", async () => {
  const { store, conv } = fixture();
  const cloneId = "cloned-worker-fixture";
  expect(store.cloneConversation(conv.id, {
    id: cloneId, title: "cloned", sortOrder: 1, createdAt: 100, updatedAt: 100,
  })).not.toBeNull();
  const canonical = store.load(cloneId)!;
  const result = await loadConversationOffThread(cloneId, false, store.path);
  expect(store.adoptLoadedConversation(result!)).toBe(true);
  const loaded = result!.conversation;
  expect(archiveWindow(loaded.messages)?.prefixSequence).toBe(0);
  expect(canonical.messages).toHaveLength(4); // instructions, divider, recent user/answer
  expect(loaded.activeContext?.windowId).toBe(`${cloneId}:1`);
  expect(buildConversationApiContext(loaded)).toEqual(buildConversationApiContext(canonical));
  expect(buildConversationApiContext(loaded)).toEqual(buildConversationApiContext(conv));
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(checkpointPrefix(canonical));
  loaded.messages.push({ role: "user", content: "clone-only append", metadata: null });
  await prepareArchiveHashes(loaded.messages);
  store.appendMessages(loaded, canonical.messages.length);
  expect(store.load(conv.id)?.messages).toEqual(conv.messages);
  expect(store.integrityCheck().ok).toBe(true);
});

test("dropping a sparse checkpoint or descriptor cannot delete canonical archive rows", async () => {
  const { store, conv } = fixture();
  const loaded = await load(store, conv);
  loaded.activeContext = null;
  loaded.messages.splice(0);
  expect(() => store.save(loaded, { forceMessages: true })).toThrow(/unmaterialized archive/);
  const other = await load(store, conv);
  other.messages = other.messages.slice();
  expect(() => store.save(other, { forceMessages: true })).toThrow(/descriptor was changed/);
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

test("legacy represented-tail rewind uses verified requested user cursors, without an old-prefix scan", async () => {
  const { store, conv } = fixture();
  const active = conv.activeContext!;
  const floor = active.compactionHistoryCount!;
  conv.messages.at(-2)!.contextCheckpoint = createStoredUserContextCheckpoint({
    ...conv, messages: conv.messages.slice(0, -2),
  })!;
  delete active.compactionHistoryCount;
  delete active.compactionPrefixHash;
  active.messages.push({ role: "user", content: "recent editable task" }, { role: "assistant", content: "recent answer" });
  active.transcriptHistoryCount += 2;
  active.transcriptPrefixHash = historyPrefixHash(conv.messages, active.transcriptHistoryCount);
  conv.activeContext = structuredClone(active);
  store.save(conv);
  const loaded = await load(store, conv);
  const rewound = rewindActiveContextToHistoryCount(loaded.activeContext!, loaded.messages, floor);
  expect(rewound).not.toBeNull();
  const messages = loaded.messages.slice(0, -2);
  inheritArchiveHashProof(loaded.messages, messages);
  expect(buildConversationApiContext({ ...loaded, messages, activeContext: rewound }).usedActiveContext).toBe(true);
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
  expect(first!.loadDiagnostics).toEqual({ cacheHit: false, archiveRowsRead: 4, archivedBodiesRead: 1, archivedHeadersRead: 0 });
  releaseArchiveWindow(first!.conversation.messages, first!.window?.handle);
  const other = createConversation("unrelated", "openai", "gpt-6.1-sol", 1);
  store.save(other);
  const next = await loadConversationOffThread(conv.id, false, store.path);
  expect(next!.loadDiagnostics).toEqual({ cacheHit: true, archiveRowsRead: 0, archivedBodiesRead: 0, archivedHeadersRead: 0 });
  expect(next!.window?.handle).not.toBe(first!.window?.handle);
  expect(store.adoptLoadedConversation(next!)).toBe(true);
  expect(currentReplayHistoryPrefix(next!.conversation.messages)).toEqual(checkpointPrefix(conv));
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
  expect(buildConversationApiContext(damaged!.conversation).usedActiveContext).toBe(true);
  await rejects(loadConversationOffThread(conv.id, true, store.path), /content checksum/);
  store.db.query("UPDATE active_contexts SET payload_json='{}' WHERE conversation_id=?").run(conv.id);
  await rejects(loadConversationOffThread(conv.id, false, store.path), /Checkpoint integrity/);
});

test("canonical fallback preserves legacy whitespace and provider-null semantics", async () => {
  const { store, conv } = fixture();
  store.db.query("UPDATE messages SET content_json=? WHERE conversation_id=? AND sequence=1")
    .run('  "original task for title"  ', conv.id);
  store.db.query("UPDATE messages SET provider_data_json=' null ', has_provider_data=1 WHERE conversation_id=? AND sequence=2").run(conv.id);
  const loaded = await load(store, conv);
  expect(isValidActiveContextCached(loaded.activeContext!, loaded.messages)).toBe(true);
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(checkpointPrefix(conv));
  await rejects(loadConversationOffThread(conv.id, true, store.path), /envelope checksum/);
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
  const before = storedMessageCount(loaded.messages);
  loaded.messages.push({ role: "user", content: "must not commit", metadata: null });
  store.updateConversationPresentation(conv.id, { title: "metadata" });
  store.saveConversationSidebarState({ id: conv.id, folderId: null, pinned: true, sortOrder: 1 });
  expect(() => store.appendMessages(loaded, before)).toThrow(/Stale conversation revision/);
  expect(store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?").get(conv.id)!.n).toBe(before);
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
  const count = storedMessageCount(loaded.messages);
  loaded.messages.push({ role: "user", content: "after cleanup", metadata: null });
  store.appendMessages(loaded, count);
  expect(store.load(conv.id)!.messages.at(-1)?.content).toBe("after cleanup");
});

test("a writer winning between the preliminary check and BEGIN cannot authorize a stale append", async () => {
  const { store, conv } = fixture();
  const loaded = await load(store, conv);
  const count = storedMessageCount(loaded.messages);
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
  // Copy before compaction, then compact the copy: its archived bodies remain
  // aliases. Copying an already-compacted source no longer inherits its archive.
  const active = structuredClone(conv.activeContext!);
  const divider = conv.messages.at(-3)!;
  conv.activeContext = null;
  conv.messages = conv.messages.filter(message => message.metadata?.kind !== CONTEXT_COMPACTION_FINISHED_KIND);
  store.save(conv, { forceMessages: true });
  const id = "cached-alias";
  store.cloneConversation(conv.id, { id, title: "copy", sortOrder: 2, createdAt: 100, updatedAt: 100 });
  const copy = store.load(id)!;
  copy.messages.splice(copy.messages.length - 2, 0, divider);
  copy.activeContext = { ...active, windowId: `${id}:1` };
  store.save(copy);
  await loadConversationOffThread(id, false, store.path);
  store.db.query("UPDATE message_blobs SET payload_json=? WHERE conversation_id=? AND message_sequence=3 AND kind='tool_result'")
    .run(JSON.stringify({ blockIndex: 0, value: "changed owner" }), conv.id);
  const result = await loadConversationOffThread(id, false, store.path);
  expect(result!.loadDiagnostics?.cacheHit).toBe(false);
  expect(store.adoptLoadedConversation(result!)).toBe(true);
  expect(buildConversationApiContext(result!.conversation).usedActiveContext).toBe(true);
  await rejects(loadToolOutputsOffThread(id, ["tool-0"], store.path), /blob checksum/);
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
  // Verify actual routing, not a race that requires cold loads to stay slower
  // than another worker's startup as the loader gets faster.
  const NativeWorker = globalThis.Worker;
  const requests: Array<{ worker: Worker; request: { type: string; id?: string } }> = [];
  globalThis.Worker = class extends NativeWorker {
    postMessage(message: any, transfer: Transferable[]): void;
    postMessage(message: any, options?: StructuredSerializeOptions): void;
    postMessage(message: any, options?: Transferable[] | StructuredSerializeOptions): void {
      requests.push({ worker: this, request: message });
      if (Array.isArray(options)) super.postMessage(message, options);
      else super.postMessage(message, options);
    }
  };
  try {
    const warming = prefetchConversation(conv.id, store.path);
    const independent = await loadConversationOffThread(small.id, false, store.path);
    expect(independent).not.toBeNull();
    const joined = await loadConversationOffThread(conv.id, false, store.path);
    expect(await warming).toBe(true);
    const prefetch = requests.find(item => item.request.type === "prefetch" && item.request.id === conv.id)!;
    const foreground = requests.find(item => item.request.type === "load" && item.request.id === small.id)!;
    const sameChat = requests.find(item => item.request.type === "load" && item.request.id === conv.id)!;
    expect(foreground.worker).not.toBe(prefetch.worker);
    expect(sameChat.worker).toBe(prefetch.worker);
    expect(joined!.loadDiagnostics).toEqual({ cacheHit: true, archiveRowsRead: 0, archivedBodiesRead: 0, archivedHeadersRead: 0 });
    expect(store.adoptLoadedConversation(joined!)).toBe(true);
    expect(currentReplayHistoryPrefix(joined!.conversation.messages)).toEqual(checkpointPrefix(conv));
  } finally { globalThis.Worker = NativeWorker; }
}, 20_000);

test("worker cache has a hard LRU entry bound and never retains full/uncompacted archives", async () => {
  const { store, conv } = fixture(1024, 2);
  for (let index = 0; index < 9; index++) {
    const id = `cache-lru-${index}`;
    store.save({ ...structuredClone(conv), id });
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

test("checkpoint-tail fingerprints survive a new compaction, worker loss and cold restart", async () => {
  const { store, conv } = fixture();
  const loaded = await load(store, conv);
  const prefix = currentReplayHistoryPrefix(loaded.messages);
  loaded.activeContext = {
    ...loaded.activeContext!, historyHashMode: "checkpoint_tail_v1",
    transcriptHistoryCount: prefix.historyCount, transcriptPrefixHash: prefix.hash,
    compactionHistoryCount: prefix.historyCount, compactionPrefixHash: prefix.hash,
    windowId: `${conv.id}:2`, windowNumber: 2, compactionCount: 2,
  };
  expect(isValidActiveContextCached(loaded.activeContext, loaded.messages)).toBe(true);
  store.save(loaded);
  const length = storedMessageCount(loaded.messages);
  loaded.messages.push({ role: "user", content: "after newer checkpoint", metadata: null });
  await prepareArchiveHashes(loaded.messages);
  const before = currentReplayHistoryPrefix(loaded.messages);
  store.appendMessages(loaded, length);
  stopConversationLoader("restart after compaction");
  const restarted = await load(store, conv);
  expect(currentReplayHistoryPrefix(restarted.messages)).toEqual(before);
  expect(buildConversationApiContext(restarted)).toEqual(buildConversationApiContext(loaded));
  const canonical = store.load(conv.id)!;
  expect(currentReplayHistoryPrefix(canonical.messages)).toEqual(before);
  restarted.messages.at(-1)!.content = "changed after checkpoint";
  await prepareArchiveHashes(restarted.messages);
  expect(currentReplayHistoryPrefix(restarted.messages)).not.toEqual(before);
});

test("tail and required instructions are checked on cold resume; missing seals never get repaired", async () => {
  const { store, conv } = fixture();
  const last = conv.messages.length - 1;
  store.db.query("UPDATE messages SET content_json='\"changed tail\"' WHERE conversation_id=? AND sequence=?").run(conv.id, last);
  await rejects(loadConversationOffThread(conv.id, false, store.path), /content checksum/);
  store.db.query("UPDATE messages SET content_json=? WHERE conversation_id=? AND sequence=?").run(JSON.stringify("recent answer"), conv.id, last);
  store.db.query("DELETE FROM message_integrity WHERE conversation_id=? AND sequence=?").run(conv.id, last);
  await rejects(loadConversationOffThread(conv.id, false, store.path), /envelope checksum/);
  expect(store.db.query("SELECT 1 FROM message_integrity WHERE conversation_id=? AND sequence=?").get(conv.id, last)).toBeNull();
  store.db.query("UPDATE messages SET content_json='\"changed instructions\"' WHERE conversation_id=? AND sequence=0").run(conv.id);
  await rejects(loadConversationOffThread(conv.id, false, store.path), /message 0.*content checksum/);
});

test("checkpoint range receipts fail closed and readonly restart does not enroll removed checksums", async () => {
  const { store, conv } = fixture();
  store.db.query("UPDATE checkpoint_integrity SET sequence_floor=sequence_floor-1 WHERE conversation_id=?").run(conv.id);
  await rejects(loadConversationOffThread(conv.id, false, store.path), /Checkpoint integrity/);
  store.db.query("DELETE FROM checkpoint_integrity WHERE conversation_id=?").run(conv.id);
  stopConversationLoader();
  await rejects(loadConversationOffThread(conv.id, false, store.path), /Checkpoint integrity/);
  expect(store.db.query("SELECT 1 FROM checkpoint_integrity WHERE conversation_id=?").get(conv.id)).toBeNull();
});

test("scroll checks only requested projection chunks; expansion separately checks canonical bodies", async () => {
  const { store, conv } = fixture();
  const page = store.loadDisplayPage(conv.id, 1)!;
  expect(page.hasOlder).toBe(true);
  store.db.query("UPDATE display_entries SET payload_json='{}' WHERE conversation_id=? AND pinned=0 AND entry_index=0").run(conv.id);
  expect(store.loadDisplayPage(conv.id, 1)?.entries).toEqual(page.entries);
  expect(() => store.loadDisplayPage(conv.id, 1, page.startIndex)).toThrow(/display chunk/);
  expect((await load(store, conv)).activeContext).toBeDefined();
  expect((await loadToolOutputsOffThread(conv.id, ["tool-0"], store.path))?.[0].toolCallId).toBe("tool-0");
  store.db.query("DELETE FROM display_integrity WHERE conversation_id=? AND pinned=0 AND entry_index=?").run(conv.id, page.startIndex);
  expect(() => store.loadDisplayPage(conv.id, 1)).toThrow(/display chunk/);
});

test("clone refuses corrupt checkpoints but rebuilds display solely from its verified tail", async () => {
  const { store, conv } = fixture();
  const target = { id: "not-blessed", title: "clone", sortOrder: 1, createdAt: 1, updatedAt: 1 };
  store.db.query("UPDATE active_contexts SET payload_json='{}' WHERE conversation_id=?").run(conv.id);
  expect(() => store.cloneConversation(conv.id, target)).toThrow(/Checkpoint integrity/);
  expect(store.has(target.id)).toBe(false);
  store.db.query("UPDATE active_contexts SET payload_json=? WHERE conversation_id=?").run(JSON.stringify(conv.activeContext), conv.id);
  store.db.query("UPDATE display_entries SET payload_json='{}' WHERE conversation_id=? AND pinned=0 AND entry_index=0").run(conv.id);
  expect(store.cloneConversation(conv.id, target)?.id).toBe(target.id);
  expect(store.loadDisplayPage(target.id, 20)?.entries.find(entry => entry.type === "user"))
    .toMatchObject({ text: "recent editable task" });
});

test("requested blob ordinal corruption cannot pass an unchanged payload/content checksum", async () => {
  const { store, conv } = fixture();
  store.db.query("UPDATE message_blobs SET ordinal=42 WHERE conversation_id=? AND message_sequence=3 AND kind='tool_result'").run(conv.id);
  expect(buildConversationApiContext(await load(store, conv)).usedActiveContext).toBe(true);
  await rejects(loadToolOutputsOffThread(conv.id, ["tool-0"], store.path), /blob block mapping/);
});

test("full-window instruction insertion/removal preserves replay proofs, but covered replay edits do not", async () => {
  const { store, conv } = fixture();
  const result = (await loadConversationOffThread(conv.id, true, store.path))!;
  expect(store.adoptLoadedConversation(result)).toBe(true);
  const loaded = result.conversation;
  const before = currentReplayHistoryPrefix(loaded.messages);
  loaded.messages.shift();
  store.save(loaded, { forceMessages: true });
  await prepareArchiveHashes(loaded.messages);
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(before);
  loaded.messages.unshift({ role: "system_instructions", content: "new instruction", metadata: null });
  store.save(loaded, { forceMessages: true });
  await prepareArchiveHashes(loaded.messages);
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(before);
  stopConversationLoader();
  expect(currentReplayHistoryPrefix((await load(store, conv)).messages)).toEqual(before);
  loaded.messages[1].content = "cannot replace checkpoint-covered user";
  await rejects(prepareArchiveHashes(loaded.messages), /Checkpoint-covered/);
});

test("ordinary writes cannot seal a structurally valid checkpoint with an unproved replay root", async () => {
  const { store, conv } = fixture();
  conv.activeContext = { ...conv.activeContext!, transcriptPrefixHash: "a".repeat(24) };
  store.save(conv);
  await rejects(loadConversationOffThread(conv.id, false, store.path), /Checkpoint integrity/);
  expect(store.db.query("SELECT 1 FROM checkpoint_integrity WHERE conversation_id=?").get(conv.id)).toBeNull();
});

test("sparse admission transfers a bounded tail, not a per-row representation of a large prefix", async () => {
  const { store, conv } = fixture(8, 16_000);
  const result = (await loadConversationOffThread(conv.id, false, store.path))!;
  expect(result.conversation.messages).toHaveLength(3);
  expect(result.window?.prefixSequence).toBe(32_002);
  expect(result.loadDiagnostics).toMatchObject({ archiveRowsRead: 4, archivedBodiesRead: 1, archivedHeadersRead: 0 });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(10_000);
  expect(store.adoptLoadedConversation(result)).toBe(true);
  const loaded = result.conversation;
  expect(archiveWindow(loaded.messages)!.headers).toHaveLength(0);
  expect(countConversationMessages(loaded.messages)).toBe(countConversationMessages(conv.messages));
  expect(buildConversationApiContext(loaded)).toEqual(buildConversationApiContext(conv));
  expect(systemInstructionMessages(loaded.messages)[0].content).toBe("instructions");
  expect(currentReplayHistoryPrefix(loaded.messages)).toEqual(checkpointPrefix(conv));
}, 20_000);

test("sparse absolute user/count offsets survive checkpoint adoption, clone and requested pages", async () => {
  const { store, conv } = fixture();
  conv.messages[3] = {
    role: "user", content: "second historical task",
    metadata: { startedAt: 100, endedAt: 100, model: conv.model, tokens: 0, automation: { kind: "chrono_wake" } },
  };
  conv.messages[5] = {
    role: "user", content: "model notice",
    metadata: { startedAt: 101, endedAt: 101, model: conv.model, tokens: 0, system: true },
  };
  const hash = historyPrefixHash(conv.messages, conv.activeContext!.transcriptHistoryCount);
  conv.activeContext = { ...conv.activeContext!, transcriptPrefixHash: hash, compactionPrefixHash: hash };
  conv.messages.at(-2)!.contextCheckpoint = createStoredUserContextCheckpoint({
    ...conv, messages: conv.messages.slice(0, -2),
  });
  store.save(conv, { forceMessages: true });
  const loaded = await load(store, conv);
  expect(archiveWindow(loaded.messages)?.sparse?.userCount).toBe(2);
  expect(countConversationMessages(loaded.messages)).toBe(countConversationMessages(conv.messages));
  expect(createStoredUserContextCheckpoint(loaded).transcriptHistoryCount).toBe(
    currentReplayHistoryPrefix(conv.messages).historyCount,
  );
  store.cloneConversation(conv.id, { id: "sparse-count-clone", title: "clone", sortOrder: 1, createdAt: 2, updatedAt: 2 });
  const clone = (await loadConversationOffThread("sparse-count-clone", false, store.path))!;
  expect(store.adoptLoadedConversation(clone)).toBe(true);
  expect(archiveWindow(clone.conversation.messages)?.sparse?.userCount).toBe(0);
  expect(store.loadDisplayPage(clone.conversation.id, 1)!.startUserIndex).toBe(0);
});

test("sealed sparse descriptors reject changed counts and omitted required instructions", async () => {
  const { store, conv } = fixture();
  store.db.query("UPDATE checkpoint_integrity SET prefix_summary_json=? WHERE conversation_id=?")
    .run(JSON.stringify({ userCount: 0, messageCount: 0, instructions: [] }), conv.id);
  await rejects(loadConversationOffThread(conv.id, false, store.path), /Checkpoint integrity/);
  expect(store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?").get(conv.id)!.n).toBe(conv.messages.length);
});

test("sparse automation continues the archived work clock but a new human turn resets it", async () => {
  const { store, conv } = fixture();
  conv.messages[conv.messages.length - 5].metadata = {
    startedAt: 0, endedAt: 134_000, model: conv.model, tokens: 0, workTimerStartedAt: 6_000,
  };
  conv.messages.at(-2)!.metadata = {
    startedAt: 140_000, endedAt: 140_000, model: conv.model, tokens: 0, automation: { kind: "chrono_wake" },
  };
  store.save(conv, { forceMessages: true });
  const loaded = await load(store, conv);
  expect(workTimerForTurn(loaded.messages, 150_000)).toBe(workTimerForTurn(conv.messages, 150_000));
  expect(workTimerForTurn(loaded.messages, 150_000)).toBe(22_000);
  expect(() => { archiveWindow(loaded.messages)!.sparse!.workTimer!.startedAt = 1; }).toThrow();
  loaded.messages.push({ role: "user", content: "new human", metadata: null });
  expect(workTimerForTurn(loaded.messages, 150_000)).toBe(150_000);
});

test("a checkpoint with no materialized tail still has replay, counts, instructions and a safe append edge", async () => {
  const { store, conv } = fixture();
  conv.messages.splice(-3);
  store.save(conv, { forceMessages: true });
  const loaded = await load(store, conv);
  expect(loaded.messages).toHaveLength(0);
  expect(storedMessageCount(loaded.messages)).toBe(conv.messages.length);
  expect(countConversationMessages(loaded.messages)).toBe(countConversationMessages(conv.messages));
  expect(buildConversationApiContext(loaded)).toEqual(buildConversationApiContext(conv));
  expect(systemInstructionMessages(loaded.messages)[0].content).toBe("instructions");
  const checkpoint = createStoredUserContextCheckpoint(loaded);
  const edge = storedMessageCount(loaded.messages);
  loaded.messages.push({ role: "user", content: "new after empty tail", metadata: null, contextCheckpoint: checkpoint });
  await prepareArchiveHashes(loaded.messages);
  store.appendMessages(loaded, edge);
  expect(store.load(conv.id)!.messages.at(-1)!.content).toBe("new after empty tail");
  expect(store.loadDisplayPage(conv.id, 1)!.startUserIndex).toBe(1);
});

test("v13 extends valid v12 receipts, preserves bad/missing receipts and never scans old blobs", async () => {
  for (const condition of ["valid", "bad", "missing"]) {
    const { store, conv } = fixture();
    const path = store.path;
    const payload = store.db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM active_contexts WHERE conversation_id=?").get(conv.id)!.payload_json;
    const receipt = store.db.query<{
      sequence_floor: number; history_floor: number; payload_hash: string; title_context_json: string; archived_bytes: number;
    }, [string]>("SELECT * FROM checkpoint_integrity WHERE conversation_id=?").get(conv.id)!;
    store.db.query("UPDATE checkpoint_integrity SET receipt_hash=? WHERE conversation_id=?").run(
      condition === "bad" ? "broken" : integritySha(JSON.stringify([
        conv.id, receipt.sequence_floor, receipt.history_floor, receipt.payload_hash, receipt.title_context_json, receipt.archived_bytes,
      ])), conv.id,
    );
    if (condition === "missing") store.db.query("DELETE FROM checkpoint_integrity WHERE conversation_id=?").run(conv.id);
    store.db.exec("ALTER TABLE checkpoint_integrity DROP COLUMN prefix_summary_json; DELETE FROM schema_migrations WHERE version>=13;");
    store.db.query("UPDATE message_blobs SET payload_json='{' WHERE conversation_id=? AND message_sequence=3").run(conv.id);
    store.close();
    const upgraded = new SqliteConversationStore({ path });
    stores.push(upgraded);
    expect(upgraded.db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM active_contexts WHERE conversation_id=?").get(conv.id)!.payload_json).toBe(payload);
    if (condition === "valid") {
      expect((await load(upgraded, conv)).messages).toHaveLength(3);
      await rejects(loadToolOutputsOffThread(conv.id, ["tool-0"], path), /blob checksum/);
    } else {
      await rejects(loadConversationOffThread(conv.id, false, path), /Checkpoint integrity/);
      if (condition === "missing") expect(upgraded.db.query("SELECT 1 FROM checkpoint_integrity WHERE conversation_id=?").get(conv.id)).toBeNull();
      else expect(upgraded.db.query<{ receipt_hash: string }, [string]>("SELECT receipt_hash FROM checkpoint_integrity WHERE conversation_id=?").get(conv.id)!.receipt_hash).toBe("broken");
    }
  }
});
