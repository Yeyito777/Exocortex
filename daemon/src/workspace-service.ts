/**
 * Lifecycle owner for persistent per-conversation working directories.
 *
 * Workspaces are cwd boundaries, not security sandboxes: tools may still use
 * absolute paths and follow symlinks under their existing safety policies.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  type Dirent,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  conversationWorkspaceDir,
  conversationWorkspacesDir,
  trashedConversationWorkspaceDir,
  trashedConversationWorkspacesDir,
} from "@exocortex/shared/paths";

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = statSync(path);
  if (!stat.isDirectory()) throw new Error(`Conversation workspace path is not a directory: ${path}`);
  try { chmodSync(path, 0o700); } catch { /* best effort on platforms without POSIX modes */ }
}

function archiveConflictingTrash(path: string): string {
  const archived = `${path}.replaced-${Date.now()}-${randomUUID()}`;
  renameSync(path, archived);
  return archived;
}

function archiveOrphanedLiveWorkspace(conversationId: string): boolean {
  const live = conversationWorkspaceDir(conversationId);
  if (!existsSync(live)) return false;
  const trashed = trashedConversationWorkspaceDir(conversationId);
  ensureDirectory(trashedConversationWorkspacesDir());
  if (existsSync(trashed)) {
    renameSync(live, `${trashed}.orphaned-${Date.now()}-${randomUUID()}`);
  } else {
    renameSync(live, trashed);
  }
  return true;
}

export class ConversationWorkspaceRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationWorkspaceRestoreError";
  }
}

/** Create (or lazily recover) a conversation's live workspace and return it. */
export function ensureConversationWorkspace(conversationId: string): string {
  const live = conversationWorkspaceDir(conversationId);
  const trashed = trashedConversationWorkspaceDir(conversationId);
  ensureDirectory(conversationWorkspacesDir());

  if (existsSync(live) && existsSync(trashed)) {
    throw new ConversationWorkspaceRestoreError(
      `Refusing to choose between colliding live and trashed conversation workspaces: ${live}`,
    );
  }

  // A crash can occur after durable conversation restore but before the
  // workspace rename. Recover that state instead of creating an empty cwd.
  if (!existsSync(live) && existsSync(trashed)) {
    if (!statSync(trashed).isDirectory()) {
      throw new Error(`Trashed conversation workspace path is not a directory: ${trashed}`);
    }
    renameSync(trashed, live);
  }
  ensureDirectory(live);
  return live;
}

/** Create the workspace for a newly-created conversation without reviving trash. */
export function createConversationWorkspace(conversationId: string): string {
  const live = conversationWorkspaceDir(conversationId);
  ensureDirectory(conversationWorkspacesDir());
  if (existsSync(live)) {
    // A failed/crashed create or delete can leave an unindexed live workspace.
    // Preserve it as recoverable trash before assigning the ID a clean cwd.
    archiveOrphanedLiveWorkspace(conversationId);
  }
  // Reusing a deleted conversation ID starts clean. Keep its old canonical
  // trash in place until the replacement is itself deleted, at which point the
  // conflict is archived rather than overwritten.
  ensureDirectory(live);
  return live;
}

/** Move a live workspace to recoverable trash. Missing workspaces are valid. */
export function trashConversationWorkspace(conversationId: string): boolean {
  const live = conversationWorkspaceDir(conversationId);
  if (!existsSync(live)) return false;
  const trashed = trashedConversationWorkspaceDir(conversationId);
  ensureDirectory(trashedConversationWorkspacesDir());
  if (existsSync(trashed)) {
    archiveConflictingTrash(trashed);
  }
  renameSync(live, trashed);
  return true;
}

/** Refuse restore before durable transcript state changes if live data collides. */
export function assertConversationWorkspaceRestorable(conversationId: string): void {
  const live = conversationWorkspaceDir(conversationId);
  const trashed = trashedConversationWorkspaceDir(conversationId);
  try {
    if (existsSync(trashed) && !statSync(trashed).isDirectory()) {
      throw new ConversationWorkspaceRestoreError(
        `Trashed conversation workspace path is not a directory: ${trashed}`,
      );
    }
    if (!existsSync(live)) return;
    const liveStat = statSync(live);
    if (!liveStat.isDirectory()) {
      throw new ConversationWorkspaceRestoreError(
        `Live conversation workspace path is not a directory: ${live}`,
      );
    }
    if (existsSync(trashed)) {
      throw new ConversationWorkspaceRestoreError(
        `Refusing to overwrite existing live conversation workspace: ${live}`,
      );
    }
  } catch (err) {
    if (err instanceof ConversationWorkspaceRestoreError) throw err;
    throw new ConversationWorkspaceRestoreError(
      `Could not inspect live conversation workspace before restore: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Restore a trashed workspace, or create an empty one when none existed. */
export function restoreConversationWorkspace(conversationId: string): string {
  const live = conversationWorkspaceDir(conversationId);
  const trashed = trashedConversationWorkspaceDir(conversationId);
  ensureDirectory(conversationWorkspacesDir());
  assertConversationWorkspaceRestorable(conversationId);

  if (existsSync(trashed)) {
    renameSync(trashed, live);
    ensureDirectory(live);
    return live;
  }
  ensureDirectory(live);
  return live;
}

export interface WorkspaceReconciliationReport {
  movedToTrash: string[];
  errors: Array<{ conversationId: string; error: string }>;
}

/**
 * Repair crash gaps by moving live workspace entries with no live
 * conversation index entry into recoverable trash. This never creates the root.
 */
export function reconcileConversationWorkspaces(liveConversationIds: Iterable<string>): WorkspaceReconciliationReport {
  const report: WorkspaceReconciliationReport = { movedToTrash: [], errors: [] };
  const root = conversationWorkspacesDir();
  if (!existsSync(root)) return report;
  const liveIds = new Set(liveConversationIds);
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" });
  } catch (err) {
    report.errors.push({
      conversationId: "<workspace-root>",
      error: err instanceof Error ? err.message : String(err),
    });
    return report;
  }
  for (const entry of entries) {
    if (liveIds.has(entry.name)) continue;
    try {
      if (archiveOrphanedLiveWorkspace(entry.name)) report.movedToTrash.push(entry.name);
    } catch (err) {
      report.errors.push({
        conversationId: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}
