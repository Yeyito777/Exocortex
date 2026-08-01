#!/usr/bin/env bun
import { isDeepStrictEqual } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../shared/src/paths";
import { JsonConversationRepository } from "../../daemon/src/json-conversation-repository";
import { SqliteConversationStore, sqliteConversationStorePath } from "../../daemon/src/sqlite-conversation-store";

const root = dataDir();
const manifestPath = join(root, "sqlite-fixture", "manifest.json");
const reportPath = join(root, "pre-merge", "exhaustive-pagination-report.json");
if (!existsSync(manifestPath)) throw new Error(`Missing fixture manifest: ${manifestPath}`);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const json = new JsonConversationRepository();
const sqlite = new SqliteConversationStore({ path: sqliteConversationStorePath() });
const results: Array<Record<string, unknown>> = [];
let mismatchCount = 0;
let totalPages = 0;
let totalEntries = 0;
let totalToolOutputs = 0;
let oldImagePayloadViolations = 0;

function normalized(page: ReturnType<JsonConversationRepository["loadDisplayPage"]>) {
  return page && {
    entries: page.entries,
    pinnedEntries: page.pinnedEntries,
    startIndex: page.startIndex,
    startUserIndex: page.startUserIndex,
    endIndex: page.endIndex,
    totalEntries: page.totalEntries,
    hasOlder: page.hasOlder,
  };
}

try {
  for (const selected of manifest.selected) {
    const id = String(selected.id);
    const mismatches: string[] = [];
    let cursor: number | undefined;
    let priorStart: number | null = null;
    let pages = 0;
    let walkedEntries = 0;
    let expectedTotal: number | null = null;
    let expectedPinned: unknown = null;
    const seenRanges = new Set<string>();

    while (true) {
      const jsonPage = json.loadDisplayPage(id, 5, cursor);
      const sqlitePage = sqlite.loadDisplayPage(id, 5, cursor);
      if (!jsonPage || !sqlitePage) {
        mismatches.push(`missing_page_at_${cursor ?? "newest"}`);
        break;
      }
      if (!isDeepStrictEqual(normalized(jsonPage), normalized(sqlitePage))) {
        mismatches.push(`page_parity_at_${cursor ?? "newest"}`);
        break;
      }
      if (expectedTotal == null) {
        expectedTotal = sqlitePage.totalEntries;
        expectedPinned = sqlitePage.pinnedEntries;
      } else {
        if (sqlitePage.totalEntries !== expectedTotal) mismatches.push("total_changed_while_walking");
        if (!isDeepStrictEqual(sqlitePage.pinnedEntries, expectedPinned)) mismatches.push("pinned_changed_while_walking");
      }
      if (priorStart != null && sqlitePage.endIndex !== priorStart) mismatches.push(`cursor_gap_${sqlitePage.endIndex}_${priorStart}`);
      if (sqlitePage.startIndex < 0 || sqlitePage.startIndex > sqlitePage.endIndex) mismatches.push("invalid_page_range");
      const range = `${sqlitePage.startIndex}:${sqlitePage.endIndex}`;
      if (seenRanges.has(range)) mismatches.push(`duplicate_range_${range}`);
      seenRanges.add(range);

      for (let local = 0; local < sqlitePage.entries.length; local++) {
        const entry: any = sqlitePage.entries[local];
        const absoluteIndex = sqlitePage.startIndex + local;
        if (absoluteIndex < sqlitePage.totalEntries - 8 && entry?.type === "user" && Array.isArray(entry.images)) {
          for (const image of entry.images) {
            if (typeof image?.base64 === "string" && image.base64.length > 0) oldImagePayloadViolations++;
          }
        }
      }

      pages++;
      walkedEntries += sqlitePage.entries.length;
      if (!sqlitePage.hasOlder) {
        if (sqlitePage.startIndex !== 0) mismatches.push(`terminal_page_starts_at_${sqlitePage.startIndex}`);
        break;
      }
      if (sqlitePage.startIndex >= (cursor ?? Number.POSITIVE_INFINITY)) mismatches.push("cursor_did_not_strictly_decrease");
      if (sqlitePage.startIndex === 0) {
        mismatches.push("has_older_at_zero");
        break;
      }
      priorStart = sqlitePage.startIndex;
      cursor = sqlitePage.startIndex;
      if (pages > 100_000) {
        mismatches.push("page_walk_limit");
        break;
      }
    }

    if (expectedTotal != null && walkedEntries !== expectedTotal) mismatches.push(`walked_${walkedEntries}_expected_${expectedTotal}`);
    const jsonTools = json.loadToolOutputs(id);
    const sqliteTools = sqlite.loadToolOutputs(id);
    if (!isDeepStrictEqual(jsonTools, sqliteTools)) mismatches.push("tool_outputs");
    const toolOutputs = sqliteTools?.length ?? 0;
    totalToolOutputs += toolOutputs;
    totalPages += pages;
    totalEntries += walkedEntries;
    mismatchCount += mismatches.length;
    results.push({ id, ok: mismatches.length === 0, mismatches, pages, walkedEntries, expectedTotal, toolOutputs });
  }

  const integrity = sqlite.integrityCheck();
  const report = {
    version: 1,
    verifiedAt: Date.now(),
    conversationCount: results.length,
    totalPages,
    totalEntries,
    totalToolOutputs,
    oldImagePayloadViolations,
    mismatchCount,
    integrity,
    conversations: results,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ report: reportPath, conversationCount: results.length, totalPages, totalEntries, totalToolOutputs, oldImagePayloadViolations, mismatchCount, integrity }, null, 2));
  if (mismatchCount > 0 || oldImagePayloadViolations > 0 || !integrity.ok) process.exitCode = 1;
} finally {
  json.close();
  sqlite.close();
  rmSync(join(root, "display-pages"), { recursive: true, force: true });
}
