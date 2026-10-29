#!/usr/bin/env bun
/**
 * Prune this instance's Claude Code session files (session-prune.ts).
 *
 *   bun daemon/src/providers/anthropic/session-prune-cli.ts            # dry run: what would go
 *   bun daemon/src/providers/anthropic/session-prune-cli.ts --apply    # move it to the quarantine
 *   bun daemon/src/providers/anthropic/session-prune-cli.ts --restore 2026-10-30   # undo that day's
 *       [--protect <session id>,…] [--json] [--top N]
 *       [--data-dir DIR]   another instance's data directory (default: this checkout's)
 *
 * Reads the conversation store read-only. The daemon runs it with --apply
 * once a day, naming the sessions its running processes hold.
 */

import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "fs";
import { join } from "path";
import { conversationWorkspacesDir, dataDir } from "@exocortex/shared/paths";
import { listClaudeAccounts, setClaudeAccountsFileForTests } from "./accounts";
import {
  applyClaudeSessionPrune,
  quarantineRoot,
  readAliases,
  restoreQuarantine,
  CLAUDE_SESSION_ALIASES_FILE,
  planClaudeSessionPrune,
  type ConversationResumePoints,
  type PruneReason,
  type SessionPrunePlan,
} from "./session-prune";

/** Every conversation the store holds (deleted ones included) with its recorded Claude Code resume points, oldest first. */
export function readResumePoints(dbPath: string): ConversationResumePoints[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const conversations = new Map<string, ConversationResumePoints>();
    for (const row of db.query<{ id: string }, []>("SELECT id FROM conversations").all()) {
      conversations.set(row.id, { convId: row.id, points: [] });
    }
    const rows = db.query<{ conversation_id: string; provider_data_json: string }, []>(
      `SELECT conversation_id, provider_data_json FROM messages
       WHERE provider_data_json LIKE '{"anthropic":%' ORDER BY conversation_id, sequence`,
    );
    for (const row of rows.iterate()) {
      let data: { anthropic?: { sessionId?: unknown; resumeAt?: unknown; cwd?: unknown } };
      try { data = JSON.parse(row.provider_data_json); } catch { continue; }
      const point = data.anthropic;
      if (typeof point?.sessionId !== "string" || typeof point.resumeAt !== "string" || typeof point.cwd !== "string") continue;
      conversations.get(row.conversation_id)?.points.push({ sessionId: point.sessionId, resumeAt: point.resumeAt, cwd: point.cwd });
    }
    return [...conversations.values()];
  } finally {
    db.close();
  }
}

export function claudeProjectsRoots(): string[] {
  return listClaudeAccounts().map(account => join(account.configDir, "projects"));
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function summarizePrunePlan(plan: SessionPrunePlan, top = 0): string {
  const removed = plan.remove.reduce((sum, file) => sum + file.bytes, 0);
  const byReason = new Map<PruneReason, { files: number; bytes: number }>();
  for (const file of plan.remove) {
    const entry = byReason.get(file.reason) ?? { files: 0, bytes: 0 };
    entry.files++;
    entry.bytes += file.bytes;
    byReason.set(file.reason, entry);
  }
  const lines = [
    `scanned: ${plan.scanned.dirs} project dirs, ${plan.scanned.files} session files, ${gib(plan.scanned.bytes)}`,
    `keep:    ${plan.keep.files} files, ${gib(plan.keep.bytes)}`,
    `held:    ${plan.held.files} files, ${gib(plan.held.bytes)} (written in the last day, or held by a running process)`,
    `prune:   ${plan.remove.length} entries, ${gib(removed)} (moved to the quarantine, purged after 7 days)`,
    ...[...byReason].map(([reason, entry]) => `  ${reason}: ${entry.files} ${reason === "conversation-gone" ? "dirs" : "files"}, ${gib(entry.bytes)}`),
    `aliases: ${Object.keys(plan.aliases).length} pruned sessions resume from a kept file`,
    `not touched: ${plan.outOfScope.points} resume points of ${plan.outOfScope.conversations} conversations outside this instance's workspaces`,
  ];
  if (top > 0) {
    const perDir = new Map<string, number>();
    for (const file of plan.remove) {
      const dir = file.directory ? file.path : file.path.slice(0, file.path.lastIndexOf("/"));
      perDir.set(dir, (perDir.get(dir) ?? 0) + file.bytes);
    }
    lines.push(`largest:`);
    for (const [dir, bytes] of [...perDir].sort((a, b) => b[1] - a[1]).slice(0, top)) lines.push(`  ${gib(bytes)}  ${dir.split("/").pop()}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const json = args.includes("--json");
  const protectIndex = args.indexOf("--protect");
  const protectedSessions = new Set(protectIndex >= 0 ? (args[protectIndex + 1] ?? "").split(",").filter(Boolean) : []);
  const topIndex = args.indexOf("--top");
  const top = topIndex >= 0 ? Number(args[topIndex + 1]) || 0 : 0;
  const dataIndex = args.indexOf("--data-dir");
  const data = dataIndex >= 0 ? args[dataIndex + 1] : dataDir();
  // That instance's Claude accounts name its configuration directories.
  if (dataIndex >= 0) setClaudeAccountsFileForTests(join(data, "anthropic-accounts.json"));
  const restoreIndex = args.indexOf("--restore");
  if (restoreIndex >= 0) {
    const date = args[restoreIndex + 1] ?? "";
    for (const root of [...new Set(claudeProjectsRoots().filter(root => existsSync(root)).map(root => realpathSync(root)))]) {
      if (!existsSync(join(quarantineRoot(root), date))) continue;
      const restored = restoreQuarantine(root, date);
      console.log(`restored ${restored.restored} files from ${join(quarantineRoot(root), date)}${restored.conflicts.length ? `; ${restored.conflicts.length} left there (a file of that name exists again): ${restored.conflicts.slice(0, 5).join(", ")}` : ""}`);
    }
    process.exit(0);
  }
  const dbPath = join(data, "exocortex.sqlite3");
  if (!existsSync(dbPath)) {
    console.error(`No conversation store at ${dbPath}; nothing to prune.`);
    process.exit(json ? 0 : 1);
  }
  const started = performance.now();
  const plan = planClaudeSessionPrune({
    conversations: readResumePoints(dbPath),
    projectsRoots: claudeProjectsRoots(),
    workspacesRoot: dataIndex >= 0 ? join(data, "workspaces") : conversationWorkspacesDir(),
    protectedSessions,
    previousAliases: readAliases(join(data, CLAUDE_SESSION_ALIASES_FILE)),
  });
  const planned = performance.now();
  const result = apply ? applyClaudeSessionPrune(plan, join(data, CLAUDE_SESSION_ALIASES_FILE), protectedSessions) : null;
  if (json) {
    console.log(JSON.stringify({
      scanned: plan.scanned, keep: plan.keep, held: plan.held,
      remove: { entries: plan.remove.length, bytes: plan.remove.reduce((sum, file) => sum + file.bytes, 0) },
      aliases: Object.keys(plan.aliases).length, outOfScope: plan.outOfScope,
      result, planMs: Math.round(planned - started),
    }));
  } else {
    console.log(`${apply ? "Pruned" : "Dry run (nothing moved; --apply moves it to the quarantine)"} for ${data}\n${summarizePrunePlan(plan, top)}`);
    console.log(`planned in ${((planned - started) / 1000).toFixed(1)} s`);
    if (result) console.log(`quarantined ${result.removedFiles} files (${gib(result.removedBytes)}) in ${result.quarantined.join(", ") || "-"}, skipped ${result.skipped}, purged ${result.purged.length} old quarantine days, ${result.errors.length} errors${result.errors.length ? `:\n  ${result.errors.slice(0, 10).join("\n  ")}` : ""}`);
  }
}
