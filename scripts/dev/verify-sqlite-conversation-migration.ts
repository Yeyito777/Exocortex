#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../shared/src/paths";
import type { Conversation } from "../../daemon/src/messages";
import { JsonConversationRepository } from "../../daemon/src/json-conversation-repository";
import { SqliteConversationStore, sqliteConversationStorePath } from "../../daemon/src/sqlite-conversation-store";
import * as legacy from "../../daemon/src/json-persistence";

const root = dataDir();
const manifestPath = join(root, "sqlite-fixture", "manifest.json");
const reportPath = join(root, "sqlite-fixture", "migration-report.json");

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalized(conv: Conversation): Record<string, unknown> {
  return {
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
  };
}

if (!existsSync(manifestPath)) throw new Error(`Fixture manifest missing: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sqlite = new SqliteConversationStore({ path: sqliteConversationStorePath() });
const jsonRepo = new JsonConversationRepository();
const unread = new Set(legacy.loadUnreadConversationIds());
const sqliteUnread = new Set(sqlite.loadUnreadConversationIds());
const results: any[] = [];
let mismatchCount = 0;

for (const selected of manifest.selected) {
  const id = selected.id as string;
  const source = legacy.load(id);
  const migrated = sqlite.load(id);
  const mismatches: string[] = [];
  if (!source) mismatches.push("legacy_load");
  if (!migrated) mismatches.push("sqlite_load");
  if (source && migrated) {
    const sourceNormalized = normalized(source);
    const migratedNormalized = normalized(migrated);
    for (const key of Object.keys(sourceNormalized)) {
      if (!isDeepStrictEqual(sourceNormalized[key], migratedNormalized[key])) mismatches.push(key);
    }
    if ((unread.has(id)) !== (sqliteUnread.has(id))) mismatches.push("unread");

    const jsonNewest = jsonRepo.loadDisplayPage(id, 5);
    const sqliteNewest = sqlite.loadDisplayPage(id, 5);
    if (!isDeepStrictEqual(jsonNewest && {
      entries: jsonNewest.entries,
      pinnedEntries: jsonNewest.pinnedEntries,
      startIndex: jsonNewest.startIndex,
      startUserIndex: jsonNewest.startUserIndex,
      endIndex: jsonNewest.endIndex,
      totalEntries: jsonNewest.totalEntries,
      hasOlder: jsonNewest.hasOlder,
    }, sqliteNewest && {
      entries: sqliteNewest.entries,
      pinnedEntries: sqliteNewest.pinnedEntries,
      startIndex: sqliteNewest.startIndex,
      startUserIndex: sqliteNewest.startUserIndex,
      endIndex: sqliteNewest.endIndex,
      totalEntries: sqliteNewest.totalEntries,
      hasOlder: sqliteNewest.hasOlder,
    })) mismatches.push("newest_display_page");

    if (jsonNewest?.hasOlder && sqliteNewest?.hasOlder) {
      const jsonOlder = jsonRepo.loadDisplayPage(id, 5, jsonNewest.startIndex);
      const sqliteOlder = sqlite.loadDisplayPage(id, 5, sqliteNewest.startIndex);
      if (!isDeepStrictEqual(jsonOlder?.entries, sqliteOlder?.entries)) mismatches.push("older_display_page");
    }
    if (!isDeepStrictEqual(jsonRepo.loadToolOutputs(id), sqlite.loadToolOutputs(id))) mismatches.push("tool_outputs");

    const exported = sqlite.exportConversation(id);
    if (!exported) mismatches.push("export");
    else {
      const exportedNormalized = {
        id: exported.id,
        provider: exported.provider,
        model: exported.model,
        effort: exported.effort,
        fastMode: exported.fastMode,
        messages: exported.messages,
        activeContext: exported.activeContext,
        createdAt: exported.createdAt,
        updatedAt: exported.updatedAt,
        lastContextTokens: exported.lastContextTokens,
        marked: exported.marked,
        pinned: exported.pinned,
        sortOrder: exported.sortOrder,
        folderId: exported.folderId,
        title: exported.title,
        goal: exported.goal,
        subagentMaxDepth: exported.subagentMaxDepth,
        subagentPolicy: exported.subagentPolicy,
      };
      if (!isDeepStrictEqual(sourceNormalized, exportedNormalized)) mismatches.push("normalized_export");
    }

    results.push({
      id,
      ok: mismatches.length === 0,
      mismatches,
      sourceBytes: selected.bytes,
      sourceVersion: selected.version,
      provider: selected.provider,
      storedMessageCount: source.messages.length,
      messageHash: hash(source.messages),
      activeContextHash: hash(source.activeContext ?? null),
      normalizedTranscriptHash: hash(sourceNormalized),
      recentPageEntries: sqliteNewest?.entries.length ?? 0,
      olderPageChecked: Boolean(jsonNewest?.hasOlder),
      toolOutputCount: sqlite.loadToolOutputs(id)?.length ?? 0,
    });
  } else {
    results.push({ id, ok: false, mismatches, sourceBytes: selected.bytes, provider: selected.provider });
  }
  mismatchCount += mismatches.length;
}

const integrity = sqlite.integrityCheck();
const report = {
  version: 1,
  verifiedAt: Date.now(),
  database: sqliteConversationStorePath(),
  conversationCount: results.length,
  mismatchCount,
  integrity,
  allGoalsAbsent: results.every((result) => legacy.load(result.id)?.goal == null),
  forbiddenAutomationFilesAbsent: [
    "chrono.json", "external-notifications.json", "subagent-notifications.json",
    "btw.json", "external-notification-soft-wakes.json",
  ].every((name) => !existsSync(join(root, name))),
  conversations: results,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
sqlite.close();
// JSON page parity builds disposable baseline pages; do not leave that obsolete
// projection tree in the canonical SQLite fixture.
rmSync(join(root, "display-pages"), { recursive: true, force: true });
console.log(JSON.stringify({ report: reportPath, conversationCount: results.length, mismatchCount, integrity, allGoalsAbsent: report.allGoalsAbsent, forbiddenAutomationFilesAbsent: report.forbiddenAutomationFilesAbsent }, null, 2));
if (mismatchCount > 0 || !integrity.ok || !report.allGoalsAbsent || !report.forbiddenAutomationFilesAbsent) process.exit(1);
