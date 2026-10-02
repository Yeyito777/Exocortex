#!/usr/bin/env bun
/**
 * Read-only cold-load comparison. Seed writes ONLY a new explicit fixture DB;
 * profile modes always open readonly and never contact a provider/daemon.
 *
 * bun scripts/dev/profile-archive-loader.ts seed NEW_DB ID [archiveMiB] [toolRounds]
 * bun scripts/dev/profile-archive-loader.ts worker|ready|baseline|warm|prefetch|syncwindow DB ID
 * warm/prefetch report warmup separately; syncwindow is a CPU-profiling helper,
 * NOT a production foreground loading path. Use a current-schema fixture.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteConversationStore } from "../../daemon/src/sqlite-conversation-store";
import { loadConversationOffThread, releaseArchiveWindow, prefetchConversation, stopConversationLoader } from "../../daemon/src/conversation-loader";
import { archiveWindow, storedMessageCount } from "../../daemon/src/conversation-window";
import { buildConversationApiContext } from "../../daemon/src/context-compaction";
import {
  CONTEXT_COMPACTION_FINISHED_KIND, CONTEXT_COMPACTION_FINISHED_TEXT,
  createConversation, createStoredUserContextCheckpoint, currentReplayHistoryPrefix,
} from "../../daemon/src/messages";

const [mode, rawPath, id, sizeRaw = "150", roundsRaw = "16000"] = process.argv.slice(2);
if (!rawPath || !id || !["seed", "worker", "ready", "warm", "prefetch", "syncwindow", "baseline"].includes(mode)) throw new Error("See usage in profile-archive-loader.ts");
const path = resolve(rawPath);
if (mode === "seed") {
  if (existsSync(path)) throw new Error("Refusing to overwrite an existing fixture DB");
  const sizeMiB = Number(sizeRaw);
  if (!Number.isFinite(sizeMiB) || sizeMiB < 1 || sizeMiB > 512) throw new Error("Fixture size must be 1..512 MiB");
  const rounds = Number(roundsRaw);
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 128_000) throw new Error("Fixture rounds must be 1..128000");
  const store = new SqliteConversationStore({ path });
  const conv = createConversation(id, "openai", "gpt-6.1-sol", 0, "Synthetic cold archive");
  conv.messages.push({ role: "user", content: "single very long user task", metadata: null });
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
  let warmupMs = 0;
  if (mode === "warm" || mode === "prefetch" || mode === "ready") {
    const warmup = performance.now();
    if (mode === "ready") {
      // Initialize a worker/connection, but do not load/cache the target chat.
      const absent = "__readonly_worker_boot_probe__";
      if (store.has(absent)) throw new Error("Probe ID unexpectedly exists");
      await loadConversationOffThread(absent, false, path);
    } else if (mode === "prefetch") await prefetchConversation(id, path);
    else {
      const first = await loadConversationOffThread(id, false, path);
      if (first?.window) releaseArchiveWindow(first.conversation.messages, first.window.handle);
    }
    warmupMs = performance.now() - warmup;
    lag.length = 0;
  }
  const start = performance.now();
  const result = mode === "syncwindow" ? store.loadRuntimeWindow(id, "readonly-profile")?.result
    : mode !== "baseline" ? await loadConversationOffThread(id, false, path) : null;
  const conv = mode !== "baseline" ? result?.conversation : store.load(id);
  if (!conv) throw new Error("Conversation could not be loaded");
  const rpcMs = performance.now() - start;
  const adoptionStarted = performance.now();
  if (result && !store.adoptLoadedConversation(result)) throw new Error("Conversation changed during profiling; retry when idle");
  const loadMs = performance.now() - start;
  const prepareStart = performance.now();
  const replay = buildConversationApiContext(conv, conv.activeContext?.accountScope);
  const checkpoint = createStoredUserContextCheckpoint(conv);
  const prepareMs = performance.now() - prepareStart;
  const memory = process.memoryUsage();
  const window = archiveWindow(conv.messages);
  const foregroundBytes = mode !== "baseline" ? Buffer.byteLength(JSON.stringify(conv)) : stat.fileSize;
  await Bun.sleep(20);
  clearInterval(timer);
  lag.sort((a, b) => a - b);
  console.log(JSON.stringify({
    mode, id, archiveBytes: stat.fileSize, messages: storedMessageCount(conv.messages),
    loadMs, rpcMs, adoptionMs: loadMs - (adoptionStarted - start), prepareMs, warmupMs, loadDiagnostics: result?.loadDiagnostics, eventLoop: {
      samples: lag.length, maxLagMs: lag.at(-1), p95LagMs: lag[Math.floor(lag.length * .95)],
    },
    foregroundBytes, archivedHeaders: window?.headers.length ?? 0,
    archivedRows: window?.prefixSequence ?? 0,
    actualTailRows: conv.messages.length - (window?.headers.length ?? 0),
    replayMessages: replay.messages.length, checkpointHash: checkpoint.transcriptPrefixHash,
    memoryDelta: { rss: memory.rss - before.rss, heapUsed: memory.heapUsed - before.heapUsed },
  }, null, 2));
  stopConversationLoader();
  store.close();
}
