/**
 * Claude Code session files Exocortex no longer needs, and keeping the ones it
 * does.
 *
 * Every new Claude Code process forks its conversation's session (api.ts):
 * Claude Code copies the transcript up to the resume point into a new file
 * (same entry uuids, new session id). A busy conversation therefore leaves one
 * full copy per process, 25-40 MB each for a long one. Only a few stay useful:
 * the session the next turn resumes, and for an unwind (which resumes an
 * earlier point), any file that still holds that point on the chain Claude
 * Code loads. A Claude Code compaction cuts that chain, so points from before
 * one live only in a file forked before it.
 *
 * The prune keeps, per conversation, the fewest files that hold every resume
 * point its history records, newest first, and deletes the rest of the
 * conversation's files once they are a day old. A pruned session whose points
 * a kept file holds gets an alias (`claude-session-aliases.json`): resuming
 * it resumes the kept file at the same entry, which has the same transcript up
 * to there (api.ts). Only this instance's own conversation workspaces' project
 * directories are touched; session subdirectories (tool results, subagent
 * transcripts) stay, since later transcripts name their files.
 *
 * Claude Code's own age sweep (cleanupPeriodDays, 30 days by default) would
 * delete a session an idle conversation still resumes from, so Exocortex sets
 * a long period where none is set (ensureClaudeTranscriptRetention).
 */

import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/** A resume point Exocortex recorded on a message (AnthropicAssistantProviderData). */
export interface RecordedResumePoint {
  sessionId: string;
  resumeAt: string;
  cwd: string;
}

/** A conversation the store holds (soft-deleted ones too: undo brings them back) and its points, oldest first. */
export interface ConversationResumePoints {
  convId: string;
  points: RecordedResumePoint[];
}

export interface SessionPruneInput {
  conversations: ConversationResumePoints[];
  /** Each Claude configuration directory's `projects/`; the same directory twice (a linked account) counts once. */
  projectsRoots: string[];
  /** This instance's conversation workspaces: only their project directories are touched. */
  workspacesRoot: string;
  /** Sessions a running process holds. */
  protectedSessions?: ReadonlySet<string>;
  now?: number;
  /** Files written more recently than this are never deleted. */
  graceMs?: number;
  /** A conversation no longer in the store loses its directory once nothing in it is newer than this. */
  goneGraceMs?: number;
}

export type PruneReason = "superseded" | "unreferenced" | "conversation-gone";

export interface PruneCandidate {
  path: string;
  bytes: number;
  mtimeMs: number;
  reason: PruneReason;
  /** A whole project directory (conversation-gone). */
  directory?: boolean;
}

export interface SessionPrunePlan {
  scanned: { dirs: number; files: number; bytes: number };
  keep: { files: number; bytes: number };
  remove: PruneCandidate[];
  /** Too recent, or held by a running process. */
  held: { files: number; bytes: number };
  /** Pruned (or already missing) session -> kept session holding all of its points. */
  aliases: Record<string, string>;
  /** Conversations with points outside this instance's workspaces: not touched. */
  outOfScope: { conversations: number; points: number };
}

/** In the instance's data directory: pruned session -> kept session that holds its points. */
export const CLAUDE_SESSION_ALIASES_FILE = "claude-session-aliases.json";

export const DEFAULT_PRUNE_GRACE_MS = 24 * 60 * 60_000;
export const DEFAULT_GONE_GRACE_MS = 7 * 24 * 60 * 60_000;
/** Exocortex conversation ids (`<ms>-<6 chars>`); a directory whose name ends otherwise is not one of its workspaces. */
const CONVERSATION_ID_RE = /^\d{10,}-[a-z0-9]{6}$/;
const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/** Claude Code's name for a working directory's project directory (its `projects/<name>`). */
export function claudeProjectDirName(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) return name;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = (hash << 5) - hash + cwd.charCodeAt(i) | 0;
  return `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/**
 * The entries Claude Code loads when it resumes this file: the chain from its
 * last main-thread entry back to the start or a compaction boundary.
 */
export function loadableChain(path: string): Set<string> {
  const parent = new Map<string, string | null>();
  let last: string | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let entry: { uuid?: unknown; parentUuid?: unknown; isSidechain?: unknown };
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry.uuid !== "string" || entry.isSidechain === true) continue;
    parent.set(entry.uuid, typeof entry.parentUuid === "string" ? entry.parentUuid : null);
    last = entry.uuid;
  }
  const chain = new Set<string>();
  for (let uuid = last; uuid && !chain.has(uuid); uuid = parent.get(uuid) ?? null) chain.add(uuid);
  return chain;
}

interface SessionFile {
  path: string;
  bytes: number;
  mtimeMs: number;
}

function sessionFiles(dir: string): Map<string, SessionFile[]> {
  const files = new Map<string, SessionFile[]>();
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return files; }
  for (const name of names) {
    if (!SESSION_FILE_RE.test(name)) continue;
    const path = join(dir, name);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (!stat.isFile()) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    files.set(sessionId, [...(files.get(sessionId) ?? []), { path, bytes: stat.size, mtimeMs: stat.mtimeMs }]);
  }
  return files;
}

/** The newest file's mtime under `path` (directories' own mtimes do not count). */
function newestMtime(path: string): number {
  let newest = 0;
  const visit = (current: string) => {
    let stat;
    try { stat = lstatSync(current); } catch { return; }
    if (!stat.isDirectory()) {
      newest = Math.max(newest, stat.mtimeMs);
      return;
    }
    for (const name of readdirSync(current)) visit(join(current, name));
  };
  visit(path);
  return newest;
}

/**
 * The fewest files that hold one history's points, newest first: the file of
 * its latest point (the next turn's), then the file of each older point no
 * kept file holds on its loaded chain. Every other session the history names
 * gets an alias when one kept file holds all of its points.
 */
function coverHistory(
  points: RecordedResumePoint[],
  files: Map<string, SessionFile[]>,
  chainOf: (sessionId: string) => Set<string>,
): { kept: Set<string>; aliases: Map<string, string> } {
  const kept: string[] = [];
  const covers = new Map<string, Set<string | null>>();
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    let cover = kept.find(sessionId => chainOf(sessionId).has(point.resumeAt)) ?? null;
    if (!cover && files.has(point.sessionId)) {
      // A point before a compaction in its own file resumes from nowhere; the file stays anyway.
      if (!kept.includes(point.sessionId)) kept.push(point.sessionId);
      cover = point.sessionId;
    }
    covers.set(point.sessionId, new Set([...(covers.get(point.sessionId) ?? []), cover]));
  }
  const aliases = new Map<string, string>();
  for (const [sessionId, targets] of covers) {
    if (kept.includes(sessionId) || targets.size !== 1) continue;
    const target = [...targets][0];
    if (target) aliases.set(sessionId, target);
  }
  return { kept: new Set(kept), aliases };
}

/** Claude Code started by the Agent SDK wrote this file (an Exocortex turn), not an interactive `claude`. */
function writtenByAgentSdk(path: string): boolean {
  let head = "";
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      head = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
  return head.includes('"entrypoint":"sdk-ts"') && !head.includes('"entrypoint":"cli"');
}

/** Decide what to keep, alias and delete. Reads the project directories; changes nothing. */
export function planClaudeSessionPrune(input: SessionPruneInput): SessionPrunePlan {
  const now = input.now ?? Date.now();
  const grace = input.graceMs ?? DEFAULT_PRUNE_GRACE_MS;
  const goneGrace = input.goneGraceMs ?? DEFAULT_GONE_GRACE_MS;
  const protectedSessions = input.protectedSessions ?? new Set<string>();
  const plan: SessionPrunePlan = {
    scanned: { dirs: 0, files: 0, bytes: 0 },
    keep: { files: 0, bytes: 0 },
    remove: [],
    held: { files: 0, bytes: 0 },
    aliases: {},
    outOfScope: { conversations: 0, points: 0 },
  };
  const roots = [...new Set(input.projectsRoots.filter(root => existsSync(root)).map(root => realpathSync(root)))];
  const workspacePrefix = claudeProjectDirName(`${input.workspacesRoot.replace(/\/+$/, "")}/`);

  // Every conversation's points, by the project directory they resume in (one
  // conversation's cwd can be another's workspace), each list oldest first.
  const byDir = new Map<string, RecordedResumePoint[][]>();
  const known = new Set<string>();
  const referenced = new Set<string>();
  const inScope = (dirName: string) => dirName.startsWith(workspacePrefix) && CONVERSATION_ID_RE.test(dirName.slice(workspacePrefix.length));
  for (const conversation of input.conversations) {
    known.add(conversation.convId);
    const groups = new Map<string, RecordedResumePoint[]>();
    for (const point of conversation.points) {
      referenced.add(point.sessionId);
      const dirName = claudeProjectDirName(point.cwd);
      groups.set(dirName, [...(groups.get(dirName) ?? []), point]);
    }
    let outside = 0;
    for (const [dirName, points] of groups) {
      if (!inScope(dirName)) { outside += points.length; continue; }
      byDir.set(dirName, [...(byDir.get(dirName) ?? []), points]);
    }
    if (outside > 0) {
      plan.outOfScope.conversations++;
      plan.outOfScope.points += outside;
    }
  }

  for (const root of roots) {
    let dirs: string[] = [];
    try { dirs = readdirSync(root); } catch { continue; }
    for (const dirName of dirs) {
      if (!inScope(dirName)) continue;
      const convId = dirName.slice(workspacePrefix.length);
      const dir = join(root, dirName);
      try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
      plan.scanned.dirs++;
      const files = sessionFiles(dir);
      const all = [...files.values()].flat();
      const allBytes = all.reduce((sum, file) => sum + file.bytes, 0);
      plan.scanned.files += all.length;
      plan.scanned.bytes += allBytes;
      const histories = byDir.get(dirName) ?? [];

      if (!known.has(convId) && histories.length === 0) {
        // Deleted for good (not even in the trash): the whole directory goes once it is quiet.
        const newest = newestMtime(dir);
        if (now - newest >= goneGrace) plan.remove.push({ path: dir, bytes: allBytes, mtimeMs: newest, reason: "conversation-gone", directory: true });
        else {
          plan.held.files += all.length;
          plan.held.bytes += allBytes;
        }
        continue;
      }

      const chains = new Map<string, Set<string>>();
      const chainOf = (sessionId: string) => {
        let chain = chains.get(sessionId);
        if (!chain) chains.set(sessionId, chain = loadableChain(files.get(sessionId)![0].path));
        return chain;
      };
      const keep = new Set<string>();
      const aliasTargets = new Map<string, Set<string>>();
      for (const points of histories) {
        const { kept, aliases } = coverHistory(points, files, chainOf);
        for (const sessionId of kept) keep.add(sessionId);
        for (const [sessionId, target] of aliases) aliasTargets.set(sessionId, new Set([...(aliasTargets.get(sessionId) ?? []), target]));
      }
      for (const [sessionId, targets] of aliasTargets) {
        if (keep.has(sessionId)) continue;
        // Two histories that would resume it from different files: keep it instead.
        if (targets.size === 1) plan.aliases[sessionId] = [...targets][0];
        else if (files.has(sessionId)) keep.add(sessionId);
      }
      for (const sessionId of keep) delete plan.aliases[sessionId];

      for (const [sessionId, located] of files) {
        for (const file of located) {
          const isReferenced = referenced.has(sessionId);
          if (keep.has(sessionId) || (!isReferenced && !writtenByAgentSdk(file.path))) {
            plan.keep.files++;
            plan.keep.bytes += file.bytes;
          } else if (protectedSessions.has(sessionId) || now - file.mtimeMs < grace) {
            plan.held.files++;
            plan.held.bytes += file.bytes;
          } else {
            plan.remove.push({ ...file, reason: isReferenced ? "superseded" : "unreferenced" });
          }
        }
      }
    }
  }
  return plan;
}

export interface SessionPruneResult {
  removedFiles: number;
  removedBytes: number;
  skipped: number;
  errors: string[];
}

/**
 * Delete what the plan found, after writing its aliases: a resume never finds
 * its file gone without one. A file written or a directory touched since the
 * plan was made stays.
 */
export function applyClaudeSessionPrune(plan: SessionPrunePlan, aliasesPath: string, protectedSessions: ReadonlySet<string> = new Set()): SessionPruneResult {
  writeClaudeSessionAliases(aliasesPath, plan.aliases);
  const result: SessionPruneResult = { removedFiles: 0, removedBytes: 0, skipped: 0, errors: [] };
  for (const candidate of plan.remove) {
    try {
      if (candidate.directory) {
        if (!existsSync(candidate.path) || newestMtime(candidate.path) > candidate.mtimeMs) { result.skipped++; continue; }
        const files = readdirSync(candidate.path).filter(name => name.endsWith(".jsonl")).length;
        rmSync(candidate.path, { recursive: true, force: true });
        result.removedFiles += files;
        result.removedBytes += candidate.bytes;
        continue;
      }
      const sessionId = candidate.path.split("/").pop()!.slice(0, -".jsonl".length);
      let stat;
      try { stat = lstatSync(candidate.path); } catch { result.skipped++; continue; }
      if (!stat.isFile() || stat.mtimeMs !== candidate.mtimeMs || protectedSessions.has(sessionId)) { result.skipped++; continue; }
      unlinkSync(candidate.path);
      result.removedFiles++;
      result.removedBytes += candidate.bytes;
    } catch (error) {
      result.errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

interface AliasesFile {
  version: 1;
  aliases: Record<string, string>;
}

export function writeClaudeSessionAliases(path: string, aliases: Record<string, string>): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, aliases } satisfies AliasesFile) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

let aliasCache: { path: string; mtimeMs: number; aliases: Record<string, string> } | null = null;

/** The kept session a pruned one's points live in, if the prune recorded one. */
export function claudeSessionAlias(path: string, sessionId: string): string | null {
  let mtimeMs: number;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return null; }
  if (aliasCache?.path !== path || aliasCache.mtimeMs !== mtimeMs) {
    let aliases: Record<string, string> = {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AliasesFile>;
      if (parsed.version === 1 && parsed.aliases && typeof parsed.aliases === "object") aliases = parsed.aliases;
    } catch { /* unreadable: no aliases */ }
    aliasCache = { path, mtimeMs, aliases };
  }
  const alias = aliasCache.aliases[sessionId];
  return typeof alias === "string" ? alias : null;
}

/** Days Claude Code keeps transcripts in the configuration directories Exocortex uses, where none is set. */
export const EXOCORTEX_CLEANUP_PERIOD_DAYS = 3650;

export type RetentionOutcome = "set" | "already-set" | "unreadable";

/**
 * Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by
 * default) from every project directory, sessions an idle conversation still
 * resumes from included. Exocortex prunes its own conversations' files
 * instead, so where a configuration directory's settings name no period, it
 * sets a long one. An explicit value is the owner's and stays. Linked
 * accounts share one settings file, which is written once.
 */
export function ensureClaudeTranscriptRetention(configDirs: string[]): Array<{ path: string; outcome: RetentionOutcome; detail?: string }> {
  const seen = new Set<string>();
  const results: Array<{ path: string; outcome: RetentionOutcome; detail?: string }> = [];
  for (const configDir of configDirs) {
    const link = join(configDir, "settings.json");
    let path = link;
    try { path = realpathSync(link); } catch { /* not there yet */ }
    if (seen.has(path)) continue;
    seen.add(path);
    let settings: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not a JSON object");
        settings = parsed as Record<string, unknown>;
      } catch (error) {
        results.push({ path, outcome: "unreadable", detail: error instanceof Error ? error.message : String(error) });
        continue;
      }
    } else if (!existsSync(configDir)) {
      continue;
    }
    if (settings.cleanupPeriodDays !== undefined) {
      results.push({ path, outcome: "already-set", detail: String(settings.cleanupPeriodDays) });
      continue;
    }
    const tmp = join(dirname(path), `.settings.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ ...settings, cleanupPeriodDays: EXOCORTEX_CLEANUP_PERIOD_DAYS }, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    results.push({ path, outcome: "set" });
  }
  return results;
}
