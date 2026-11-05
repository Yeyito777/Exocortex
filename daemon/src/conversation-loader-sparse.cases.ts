import { afterEach, expect, test } from "bun:test";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { loadConversationOffThread, loadToolOutputsOffThread, prepareArchiveHashes } from "./conversation-loader";
import { integritySha } from "./checkpoint-tail-integrity";
import { archiveWindow, storedMessageCount, systemInstructionMessages } from "./conversation-window";
import { createStoredUserContextCheckpoint, currentReplayHistoryPrefix, countConversationMessages, historyPrefixHash } from "./messages";
import { buildConversationApiContext } from "./context-compaction";
import { cleanupLoaderFixtures, stores, fixture, load, rejects, checkpointPrefix } from "./conversation-loader-test-helpers";

afterEach(cleanupLoaderFixtures);

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
