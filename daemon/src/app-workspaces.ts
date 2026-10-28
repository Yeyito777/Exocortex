/**
 * Working directories and Claude Code session files of app conversations
 * (docs/app-api.md).
 *
 * An app may give its own `cwd`, which the daemon never creates, moves or
 * deletes. Without one, an ephemeral conversation works in a temporary
 * directory under this instance's root in the system temp directory, and a
 * saved or temporary one in the usual per-conversation workspace. Deleting an
 * app conversation removes only these daemon-created directories, after
 * checking each is where the daemon puts them, and the Claude Code session
 * files of its turns.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { conversationWorkspaceDir, conversationWorkspacesDir, dataDir } from "@exocortex/shared/paths";
import { getAppRecord, type AppConversationRecord } from "./app-registry";
import { log } from "./log";

let ephemeralRootOverride: string | null = null;
let claudeConfigDirOverride: string | null = null;

/** Tests use scratch directories. */
export function setAppWorkspaceRootsForTests(roots: { ephemeral?: string | null; claudeConfig?: string | null }): void {
  if (roots.ephemeral !== undefined) ephemeralRootOverride = roots.ephemeral;
  if (roots.claudeConfig !== undefined) claudeConfigDirOverride = roots.claudeConfig;
}

/** This daemon instance's root for ephemeral working directories. */
export function ephemeralWorkspaceRoot(): string {
  if (ephemeralRootOverride) return ephemeralRootOverride;
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const instance = createHash("sha256").update(resolve(dataDir())).digest("hex").slice(0, 12);
  return join(tmpdir(), `exocortex-apps-${uid}-${instance}`);
}

function ephemeralWorkspacePath(convId: string): string {
  const root = resolve(ephemeralWorkspaceRoot());
  const path = resolve(root, convId);
  if (dirname(path) !== root || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(convId)) throw new Error(`Invalid conversation id: ${convId}`);
  return path;
}

export function createEphemeralWorkspace(convId: string): string {
  const root = ephemeralWorkspaceRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = ephemeralWorkspacePath(convId);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/** Where an app conversation's turn runs, or undefined for the usual workspace. Throws when an app cwd is gone. */
export function appTurnWorkingDirectory(convId: string): string | undefined {
  const record = getAppRecord(convId);
  if (!record) return undefined;
  if (record.cwd) {
    let isDirectory = false;
    try { isDirectory = statSync(record.cwd).isDirectory(); } catch { /* missing */ }
    if (!isDirectory) throw new Error(`The app's working directory ${record.cwd} no longer exists`);
    return record.cwd;
  }
  if (record.ephemeralWorkspace) {
    // Never anything but the daemon's own directory for it, recreated if the system cleaned it.
    const path = ephemeralWorkspacePath(convId);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }
  return undefined;
}

/** The daemon-created working directory of an app conversation, if it has one (never an app cwd). */
export function daemonCreatedAppWorkspace(record: AppConversationRecord): string | undefined {
  if (record.cwd) return undefined;
  if (record.lifetime === "ephemeral") return record.ephemeralWorkspace ? ephemeralWorkspacePath(record.convId) : undefined;
  return conversationWorkspaceDir(record.convId);
}

/**
 * Remove an ended app conversation's daemon-created working directory.
 * An app-supplied cwd is never touched, even if it happens to be the same path.
 */
export function removeAppWorkspace(record: AppConversationRecord): void {
  const path = daemonCreatedAppWorkspace(record);
  if (!path) return;
  const expectedRoot = resolve(record.lifetime === "ephemeral" ? ephemeralWorkspaceRoot() : conversationWorkspacesDir());
  if (dirname(resolve(path)) !== expectedRoot) {
    log("error", `app-workspaces: refusing to remove ${path}: not a daemon workspace`);
    return;
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    log("error", `app-workspaces: could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── Claude Code session files ───────────────────────────────────────

function claudeConfigDir(): string {
  return claudeConfigDirOverride ?? (process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"));
}

/** Claude Code's project directory name for a working directory. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/;

/**
 * Remove Claude Code's files for these sessions: the transcripts (projects/),
 * and the per-session file history, environment and debug log. Projects are
 * shared by every Claude account's configuration directory.
 */
export function removeClaudeSessionFiles(sessions: Iterable<{ sessionId: string; cwd?: string }>): number {
  const config = claudeConfigDir();
  const projects = join(config, "projects");
  let removed = 0;
  let projectDirs: string[] | null = null;
  for (const { sessionId, cwd } of sessions) {
    if (!SESSION_ID.test(sessionId)) continue;
    const candidates = cwd ? [join(projects, claudeProjectDirName(cwd))] : (projectDirs ??= listDirs(projects));
    for (const dir of candidates) {
      for (const path of [join(dir, `${sessionId}.jsonl`), join(dir, sessionId)]) {
        if (removePath(path)) removed++;
      }
    }
    for (const path of [join(config, "file-history", sessionId), join(config, "session-env", sessionId), join(config, "debug", `${sessionId}.txt`)]) {
      if (removePath(path)) removed++;
    }
  }
  return removed;
}

/** Remove Claude Code's project directory for a daemon-created working directory (ephemeral). */
export function removeClaudeProjectDir(cwd: string): boolean {
  return removePath(join(claudeConfigDir(), "projects", claudeProjectDirName(cwd)));
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(path, entry.name));
  } catch {
    return [];
  }
}

function removePath(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    rmSync(path, { recursive: true, force: true });
    return true;
  } catch (error) {
    log("warn", `app-workspaces: could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Startup: an earlier daemon of this instance that did not shut down left
 * ephemeral conversations' directories and their Claude Code projects behind.
 */
export function sweepEphemeralLeftovers(): { workspaces: number; claudeProjects: number } {
  const root = ephemeralWorkspaceRoot();
  const workspaces = listDirs(root).length;
  removePath(root);
  const prefix = claudeProjectDirName(resolve(root));
  let claudeProjects = 0;
  for (const dir of listDirs(join(claudeConfigDir(), "projects"))) {
    const name = dir.slice(dir.lastIndexOf("/") + 1);
    if ((name === prefix || name.startsWith(`${prefix}-`)) && removePath(dir)) claudeProjects++;
  }
  return { workspaces, claudeProjects };
}
