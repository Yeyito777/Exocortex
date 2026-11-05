import { afterEach, expect, test } from "bun:test";
import { loadConversationOffThread, loadToolOutputsOffThread, prefetchConversation, prepareArchiveHashes, releaseArchiveWindow, stopConversationLoader } from "./conversation-loader";
import { storedMessageCount } from "./conversation-window";
import { createConversation, currentReplayHistoryPrefix, isValidActiveContextCached } from "./messages";
import { buildConversationApiContext } from "./context-compaction";
import { cleanupLoaderFixtures, fixture, load, rejects, checkpointPrefix } from "./conversation-loader-test-helpers";

afterEach(cleanupLoaderFixtures);

test("urgent native tail hashing is serviced during a cooperative archive scan", async () => {
  const { store, conv } = fixture(2048, 4000);
  const small = createConversation("hash-owner", "openai", "gpt-6.1-sol", 1);
  small.messages.push({ role: "user", content: "small", metadata: null });
  store.save(small);
  const owner = await load(store, small);
  owner.messages.push({ role: "user", content: "urgent", metadata: null });
  let completed = false;
  // A full load scans the whole archive in batches (~200 ms here); a sparse one
  // reads only the tail and finished within a millisecond or two of the hash,
  // so the test raced under load.
  const slow = loadConversationOffThread(conv.id, true, store.path).then(result => { completed = true; return result; });
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
