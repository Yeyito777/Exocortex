import { afterEach, expect, test } from "bun:test";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { loadConversationOffThread, loadToolOutputsOffThread, prefetchConversation, prepareArchiveHashes, releaseArchiveWindow, stopConversationLoader } from "./conversation-loader";
import { archiveWindow, inheritArchiveHashProof, isArchivedMessage, storedMessageCount, systemInstructionMessages } from "./conversation-window";
import { titleContext } from "./conversation-title-context";
import { CONTEXT_COMPACTION_FINISHED_KIND, createConversation, createStoredUserContextCheckpoint, currentReplayHistoryPrefix, historyPrefixHash, isValidActiveContextCached, rewindActiveContextToHistoryCount, type StoredMessage } from "./messages";
import { buildConversationApiContext } from "./context-compaction";
import { cleanupLoaderFixtures, stores, roots, fixture, load, rejects, checkpointPrefix } from "./conversation-loader-test-helpers";

afterEach(cleanupLoaderFixtures);

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
