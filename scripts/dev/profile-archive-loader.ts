#!/usr/bin/env bun
/**
 * Read-only cold-load comparison. Seed writes ONLY a new explicit fixture DB;
 * profile modes always open readonly and never contact a provider/daemon.
 *
 * bun scripts/dev/profile-archive-loader.ts seed NEW_DB ID [archiveMiB]
 * bun scripts/dev/profile-archive-loader.ts worker|baseline DB ID
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteConversationStore } from "../../daemon/src/sqlite-conversation-store";
import { loadConversationOffThread, stopConversationLoader } from "../../daemon/src/conversation-loader";
import { archiveWindow } from "../../daemon/src/conversation-window";
import { buildConversationApiContext } from "../../daemon/src/context-compaction";
import {
  CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT,
  createConversation, createStoredUserContextCheckpoint, currentReplayHistoryPrefix,
} from "../../daemon/src/messages";

const [mode, rawPath, id, sizeRaw = "150"] = process.argv.slice(2);
if (!rawPath || !id || !["seed", "worker", "baseline"].includes(mode)) throw new Error("See usage in profile-archive-loader.ts");
const path = resolve(rawPath);
if (mode === "seed") {
  if (existsSync(path)) throw new Error("Refusing to overwrite an existing fixture DB");
  const sizeMiB = Number(sizeRaw);
  if (!Number.isFinite(sizeMiB) || sizeMiB < 1 || sizeMiB > 512) throw new Error("Fixture size must be 1..512 MiB");
  const store = new SqliteConversationStore({ path });
  const conv = createConversation(id, "openai", "gpt-6.1-sol", 0, "Synthetic cold archive");
  conv.messages.push({ role: "user", content: "single very long user task", metadata: null });
  const rounds = 16_000;
  const bodySize = Math.ceil(sizeMiB * 1024 * 1024 / rounds);
  for (let i = 0; i < rounds; i++) conv.messages.push(
    { role: "assistant", content: [{ type: "tool_use", id: `tool-${i}`, name: "exec_command", input: { cmd: "true" } }], metadata: null },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `tool-${i}`, content: `${i}:` + "x".repeat(bodySize) }], metadata: null },
  );
  const prefix = currentReplayHistoryPrefix(conv.messages);
  conv.activeContext = {
    version: 1, kind: "openai_native", provider: "openai", model: conv.model,
    messages: [{ role: "assistant", content: [], providerData: { openai: { compactionItems: [{ encryptedContent: "fixture-opaque" }] } } }],
    transcriptHistoryCount: prefix.historyCount, transcriptPrefixHash: prefix.hash,
    compactionHistoryCount: prefix.historyCount, compactionPrefixHash: prefix.hash,
    windowId: `${id}:1`, windowNumber: 1, compactedAt: 123, compactionCount: 1,
  };
  conv.messages.push({
    role: "system", content: CONTEXT_COMPACTION_FINISHED_TEXT,
    metadata: { startedAt: 123, endedAt: 123, model: conv.model, tokens: 0, kind: CONTEXT_COMPACTION_FINISHED_KIND },
  });
  conv.messages.push({ role: "user", content: "recent tail", metadata: null }, { role: "assistant", content: "recent answer", metadata: null });
  store.save(conv);
  console.log(JSON.stringify({ fixture: path, id, messages: conv.messages.length, archiveBytes: store.indexEntryFromConversation(conv).fileSize }));
  store.close();
} else {
  const store = new SqliteConversationStore({ path, readonly: true });
  const stat = store.getConversationFileStat(id);
  const lag: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    lag.push(Math.max(0, now - last - 5));
    last = now;
  }, 5);
  await Bun.sleep(20);
  const before = process.memoryUsage();
  const start = performance.now();
  const result = mode === "worker" ? await loadConversationOffThread(id, false, path) : null;
  const conv = mode === "worker" ? result?.conversation : store.load(id);
  if (!conv) throw new Error("Conversation could not be loaded");
  if (result && !store.adoptLoadedConversation(result)) throw new Error("Conversation changed during profiling; retry when idle");
  const loadMs = performance.now() - start;
  const prepareStart = performance.now();
  const replay = buildConversationApiContext(conv, conv.activeContext?.accountScope);
  const checkpoint = createStoredUserContextCheckpoint(conv);
  const prepareMs = performance.now() - prepareStart;
  const memory = process.memoryUsage();
  const window = archiveWindow(conv.messages);
  const foregroundBytes = mode === "worker" ? Buffer.byteLength(JSON.stringify(conv)) : stat.fileSize;
  await Bun.sleep(20);
  clearInterval(timer);
  lag.sort((a, b) => a - b);
  console.log(JSON.stringify({
    mode, id, archiveBytes: stat.fileSize, messages: conv.messages.length,
    loadMs, prepareMs, eventLoop: {
      samples: lag.length, maxLagMs: lag.at(-1), p95LagMs: lag[Math.floor(lag.length * .95)],
    },
    foregroundBytes, archivedHeaders: window?.prefixSequence ?? 0,
    actualTailRows: conv.messages.length - (window?.prefixSequence ?? 0),
    replayMessages: replay.messages.length, checkpointHash: checkpoint.transcriptPrefixHash,
    memoryDelta: { rss: memory.rss - before.rss, heapUsed: memory.heapUsed - before.heapUsed },
  }, null, 2));
  stopConversationLoader();
  store.close();
}
