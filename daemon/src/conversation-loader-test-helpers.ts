/** Fixtures shared by the conversation-loader*.cases.ts files. */
import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConversationStore } from "./sqlite-conversation-store";
import { loadConversationOffThread, stopConversationLoader } from "./conversation-loader";
import { checkpointTailHasher, updateCheckpointTailHash } from "./checkpoint-tail-integrity";
import { CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT, createConversation, currentReplayHistoryPrefix, isReplayHistoryMessage, type Conversation } from "./messages";

export const stores: SqliteConversationStore[] = [];
export const roots: string[] = [];

/** Run after each case: stops the loader workers and removes this case's stores. */
export function cleanupLoaderFixtures(): void {
  stopConversationLoader();
  for (const store of stores.splice(0)) store.close();
  if (process.platform === "win32") Bun.gc(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
}

export function fixture(size = 16_000, rounds = 8) {
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

export async function load(store: SqliteConversationStore, conv: Conversation) {
  const result = await loadConversationOffThread(conv.id, false, store.path);
  expect(result).not.toBeNull();
  expect(store.adoptLoadedConversation(result!)).toBe(true);
  return result!.conversation;
}

export async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  let error: unknown;
  try { await promise; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(pattern);
}

export function checkpointPrefix(conv: Conversation, messages = conv.messages) {
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
