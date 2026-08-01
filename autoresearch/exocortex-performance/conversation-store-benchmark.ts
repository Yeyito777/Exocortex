#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "../../shared/src/paths";
import { createConversation, summarizeConversation, type Conversation } from "../../daemon/src/messages";
import { SqliteConversationStore, sqliteConversationStorePath } from "../../daemon/src/sqlite-conversation-store";

interface Sample {
  wallMs: number;
  cpuMs: number;
  rssDelta: number;
  writeBytes: number | null;
}
interface Stats {
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  medianCpuMs: number;
  maxRssDelta: number;
  medianWriteBytes: number | null;
  samples: Sample[];
}

const RESULT_DIR = join(import.meta.dir, "results");
mkdirSync(RESULT_DIR, { recursive: true });
const quick = process.argv.includes("--quick");
const repetitions = quick ? 3 : 7;
const syntheticCount = quick ? 2_000 : 10_000;

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

function ioWriteBytes(): number | null {
  try {
    const match = readFileSync("/proc/self/io", "utf8").match(/^write_bytes:\s+(\d+)$/m);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

function sample(operation: () => void): Sample {
  Bun.gc(true);
  const rss = process.memoryUsage().rss;
  const io = ioWriteBytes();
  const cpu = process.cpuUsage();
  const started = performance.now();
  operation();
  const wallMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const afterIo = ioWriteBytes();
  return {
    wallMs,
    cpuMs: (used.user + used.system) / 1000,
    rssDelta: process.memoryUsage().rss - rss,
    writeBytes: io == null || afterIo == null ? null : afterIo - io,
  };
}

function measure(operation: () => void, count = repetitions): Stats {
  // SQLite may finish allocating WAL pages/preparing statements over the first
  // couple of calls after a large import; compare steady-state warm backends.
  operation();
  operation();
  operation();
  const samples = Array.from({ length: count }, () => sample(operation));
  const writes = samples.flatMap((value) => value.writeBytes == null ? [] : [value.writeBytes]);
  return {
    medianMs: percentile(samples.map((value) => value.wallMs), 0.5),
    p95Ms: percentile(samples.map((value) => value.wallMs), 0.95),
    maxMs: Math.max(...samples.map((value) => value.wallMs)),
    medianCpuMs: percentile(samples.map((value) => value.cpuMs), 0.5),
    maxRssDelta: Math.max(...samples.map((value) => value.rssDelta)),
    medianWriteBytes: writes.length ? percentile(writes, 0.5) : null,
    samples,
  };
}

function dirSize(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + dirSize(join(path, name)), 0);
}

function syntheticConversation(id: string, index: number): Conversation {
  const conv = createConversation(id, index % 19 === 0 ? "deepseek" : "openai", index % 19 === 0 ? "deepseek-v4-pro" : "gpt-5.6-sol", index, `Synthetic ${index}`, index % 7 === 0 ? "medium" : "high", index % 31 === 0);
  conv.createdAt = 1_700_000_000_000 + index;
  conv.updatedAt = conv.createdAt + 1;
  conv.messages.push(
    { role: "user", content: `request-${index}`, metadata: null },
    { role: "assistant", content: `answer-${index}`, metadata: null },
  );
  conv.marked = index % 29 === 0;
  conv.pinned = index % 101 === 0;
  conv.folderId = index % 4 === 0 ? `folder-${index % 20}` : null;
  return conv;
}

function jsonFile(conv: Conversation): Record<string, unknown> {
  return {
    version: 18,
    id: conv.id,
    provider: conv.provider,
    model: conv.model,
    effort: conv.effort,
    fastMode: conv.fastMode,
    messages: conv.messages,
    activeContext: conv.activeContext ?? null,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    lastContextTokens: conv.lastContextTokens,
    marked: conv.marked,
    pinned: conv.pinned,
    sortOrder: conv.sortOrder,
    folderId: conv.folderId ?? null,
    title: conv.title,
    goal: conv.goal ?? null,
    subagentMaxDepth: conv.subagentMaxDepth ?? null,
    subagentPolicy: conv.subagentPolicy ?? null,
    storageGeneration: 1,
    lastUnwindReceipt: null,
  };
}

function writeJsonConversation(dir: string, conv: Conversation): void {
  writeFileSync(join(dir, `${conv.id}.json`), JSON.stringify(jsonFile(conv), null, 2));
}

function buildJsonIndex(dir: string, conversations: Conversation[], path: string): void {
  const entries = conversations.map((conv) => {
    const stat = statSync(join(dir, `${conv.id}.json`));
    return { ...summarizeConversation(conv), fileSize: stat.size, fileMtimeMs: stat.mtimeMs, storageGeneration: 1 };
  });
  // The production legacy writer persists the monolithic index pretty-printed.
  writeFileSync(path, JSON.stringify({ version: 3, updatedAt: Date.now(), conversations: entries }, null, 2));
}

function scanJsonIndex(dir: string, indexPath: string): any[] {
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const byId = new Map(index.conversations.map((entry: any) => [entry.id, entry]));
  const result: any[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const stat = statSync(join(dir, name));
    const entry: any = byId.get(id);
    // Legacy cache reuse probes both targeted overlay paths for every summary.
    existsSync(join(dir, `${id}.unwind`));
    existsSync(join(dir, `${id}.sidebar`));
    if (entry && entry.fileSize === stat.size && entry.fileMtimeMs === stat.mtimeMs) result.push(entry);
    else {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      result.push({ id, title: raw.title, pinned: raw.pinned, sortOrder: raw.sortOrder, messageCount: raw.messages.length });
    }
  }
  return result.sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) || a.sortOrder - b.sortOrder);
}

const root = mkdtempSync(join(tmpdir(), "exocortex-store-benchmark-"));
const jsonDir = join(root, "json", "conversations");
const jsonIndex = join(root, "json", "conversations-index.json");
const sqlitePath = join(root, "sqlite", "store.sqlite3");
mkdirSync(jsonDir, { recursive: true });
mkdirSync(join(root, "sqlite"), { recursive: true });

console.error(`building deterministic ${syntheticCount}-conversation datasets`);
const synthetic = Array.from({ length: syntheticCount }, (_, index) => syntheticConversation(`synthetic-${String(index).padStart(6, "0")}`, index));
for (const conv of synthetic) writeJsonConversation(jsonDir, conv);
buildJsonIndex(jsonDir, synthetic, jsonIndex);
let sqlite = new SqliteConversationStore({ path: sqlitePath });
const folders = Array.from({ length: 20 }, (_, index) => ({ id: `folder-${index}`, name: `Folder ${index}`, parentId: null, createdAt: index, updatedAt: index, pinned: false, sortOrder: index }));
sqlite.saveFolders(folders);
sqlite.db.transaction(() => { for (const conv of synthetic) sqlite.save(conv); })();
sqlite.checkpoint("TRUNCATE");

let jsonSummaries: any[] = [];
const largeScale: Record<string, any> = {};
largeScale.jsonStartupAndList = measure(() => { jsonSummaries = scanJsonIndex(jsonDir, jsonIndex); });
largeScale.sqliteStartupAndList = measure(() => {
  sqlite.close();
  sqlite = new SqliteConversationStore({ path: sqlitePath });
  sqlite.listSummaries();
});
largeScale.jsonWarmList = measure(() => { JSON.parse(readFileSync(jsonIndex, "utf8")).conversations.slice().sort((a: any, b: any) => a.sortOrder - b.sortOrder); });
largeScale.sqliteWarmList = measure(() => { sqlite.listSummaries(); });
const lookupId = `synthetic-${String(Math.min(5000, syntheticCount - 1)).padStart(6, "0")}`;
largeScale.jsonFindById = measure(() => { if (!jsonSummaries.find((entry) => entry.id === lookupId)) throw new Error("missing"); });
largeScale.sqliteFindById = measure(() => { if (!sqlite.getSummary(lookupId)) throw new Error("missing"); });
largeScale.jsonTitleSearch = measure(() => { jsonSummaries.filter((entry) => entry.title.includes("999")).slice(0, 50); });
largeScale.sqliteTitleSearch = measure(() => { sqlite.searchTitles("999", 50); });
largeScale.sqliteRecentPage = measure(() => { sqlite.loadDisplayPage("synthetic-000100", 5); });
const metadataConv = sqlite.load("synthetic-000100")!;
let renameCounter = 0;
largeScale.sqliteMetadataWrite = measure(() => { metadataConv.title = `Renamed ${renameCounter++}`; sqlite.save(metadataConv); });
let orderCounter = 0;
largeScale.sqliteSidebarMove = measure(() => { sqlite.saveConversationSidebarState({ id: metadataConv.id, folderId: metadataConv.folderId ?? null, pinned: metadataConv.pinned, sortOrder: orderCounter++ }); });

function appendDataset(sizeMiB: number): { json: Stats; sqlite: Stats; jsonBytes: number; sqliteBytes: number } {
  const name = `append-${sizeMiB}`;
  const appendJsonDir = join(root, name, "json");
  const appendSqlitePath = join(root, name, "sqlite", "store.sqlite3");
  mkdirSync(appendJsonDir, { recursive: true });
  mkdirSync(join(root, name, "sqlite"), { recursive: true });
  const payload = "x".repeat(sizeMiB * 1024 * 1024);
  const jsonConv = createConversation(name, "openai", "gpt-5.6-sol", 0, name);
  jsonConv.messages.push(
    { role: "user", content: "run", metadata: null },
    { role: "assistant", content: [{ type: "tool_use", id: "large-tool", name: "bash", input: {} }], metadata: null },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "large-tool", content: payload }], metadata: null },
    { role: "assistant", content: "done", metadata: null },
  );
  writeJsonConversation(appendJsonDir, jsonConv);
  const appendSqlite = new SqliteConversationStore({ path: appendSqlitePath });
  const sqliteConv = structuredClone(jsonConv);
  appendSqlite.save(sqliteConv);
  let sequence = 0;
  const jsonStats = measure(() => {
    jsonConv.messages.push({ role: "user", content: `next-${sequence}`, metadata: null }, { role: "assistant", content: `reply-${sequence++}`, metadata: null });
    jsonConv.updatedAt++;
    writeJsonConversation(appendJsonDir, jsonConv);
  }, quick ? 2 : 5);
  sequence = 0;
  const sqliteStats = measure(() => {
    sqliteConv.messages.push({ role: "user", content: `next-${sequence}`, metadata: null }, { role: "assistant", content: `reply-${sequence++}`, metadata: null });
    sqliteConv.updatedAt++;
    appendSqlite.save(sqliteConv);
  }, quick ? 2 : 5);
  appendSqlite.checkpoint("TRUNCATE");
  appendSqlite.close();
  return {
    json: jsonStats,
    sqlite: sqliteStats,
    jsonBytes: dirSize(appendJsonDir),
    sqliteBytes: dirSize(join(root, name, "sqlite")),
  };
}

const appendSizes = quick ? [1, 10] : [1, 10, 50, 96];
const largeAppend = Object.fromEntries(appendSizes.map((size) => [String(size), appendDataset(size)]));

// Low-scale startup/list uses the copied real fixture and canonical SQLite DB.
const fixtureDir = join(dataDir(), "conversations");
const fixtureManifestPath = join(dataDir(), "sqlite-fixture", "manifest.json");
const lowScale: Record<string, any> = {};
if (existsSync(fixtureManifestPath) && existsSync(sqliteConversationStorePath())) {
  const fixtureManifest = JSON.parse(readFileSync(fixtureManifestPath, "utf8"));
  const fixtureIndexPath = join(root, "fixture-index.json");
  const entries = fixtureManifest.selected.map((entry: any) => {
    const stat = statSync(join(fixtureDir, `${entry.id}.json`));
    return { id: entry.id, title: "", pinned: entry.flags.pinned, sortOrder: 0, fileSize: stat.size, fileMtimeMs: stat.mtimeMs, storageGeneration: 1 };
  });
  writeFileSync(fixtureIndexPath, JSON.stringify({ version: 3, conversations: entries }));
  lowScale.jsonStartupAndList = measure(() => { scanJsonIndex(fixtureDir, fixtureIndexPath); });
  let fixtureSqlite = new SqliteConversationStore({ path: sqliteConversationStorePath() });
  lowScale.sqliteStartupAndList = measure(() => { fixtureSqlite.close(); fixtureSqlite = new SqliteConversationStore({ path: sqliteConversationStorePath() }); fixtureSqlite.listSummaries(); });
  const fixtureId = fixtureManifest.selected.find((entry: any) => entry.flags.multiplePages)?.id ?? fixtureManifest.selected[0].id;
  lowScale.sqliteRecentPage = measure(() => { fixtureSqlite.loadDisplayPage(fixtureId, 5); });
  lowScale.sqliteToolOutputs = measure(() => { fixtureSqlite.loadToolOutputs(fixtureId); });
  fixtureSqlite.close();
}

sqlite.checkpoint("TRUNCATE");
sqlite.close();
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  machine: { platform: process.platform, arch: process.arch, bun: Bun.version },
  methodology: {
    quick,
    repetitions,
    syntheticConversationCount: syntheticCount,
    appendSizesMiB: appendSizes,
    cachePolicy: "warmup then measured warm repetitions; startup closes/reopens the SQLite connection; JSON startup rescans/stats files",
    metrics: "wall, process CPU, RSS delta, Linux /proc write_bytes when available",
  },
  corpusShape: { syntheticMessagesPerConversation: 2, syntheticFolderCount: folders.length },
  lowScale,
  largeScale,
  largeAppend,
  storageBytes: { jsonSynthetic: dirSize(join(root, "json")), sqliteSynthetic: dirSize(join(root, "sqlite")) },
};
const suffix = quick ? "quick" : "full";
const resultPath = join(RESULT_DIR, `conversation-store-${suffix}.json`);
writeFileSync(resultPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ resultPath, syntheticCount, lowScale: Object.fromEntries(Object.entries(lowScale).map(([key, value]: any) => [key, value.medianMs])), largeStartupSpeedup: largeScale.jsonStartupAndList.medianMs / largeScale.sqliteStartupAndList.medianMs, appendSpeedups: Object.fromEntries(Object.entries(largeAppend).map(([size, value]: any) => [size, value.json.medianMs / value.sqlite.medianMs])), storageBytes: report.storageBytes }, null, 2));
rmSync(root, { recursive: true, force: true });
