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
 * conversation's files once they are a day old, into a quarantine beside
 * `projects/` that is purged after QUARANTINE_DAYS (restoreQuarantine undoes
 * a day). A pruned session whose points
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

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from "fs";
import { basename, dirname, join, relative } from "path";

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
  /** The aliases earlier prunes recorded (claude-session-aliases.json). */
  previousAliases?: Readonly<Record<string, string>>;
  now?: number;
  /** Files written more recently than this are never deleted. */
  graceMs?: number;
  /** A conversation no longer in the store loses its directory once nothing in it is newer than this. */
  goneGraceMs?: number;
}

export type PruneReason = "superseded" | "unreferenced" | "conversation-gone";

export interface PruneCandidate {
  path: string;
  /** The `projects/` directory it is in (its quarantine sits beside it). */
  root: string;
  bytes: number;
  mtimeMs: number;
  reason: PruneReason;
  /** A whole project directory (conversation-gone). */
  directory?: boolean;
}

export interface SessionPrunePlan {
  /** The `projects/` directories scanned (real paths). */
  roots: string[];
  scanned: { dirs: number; files: number; bytes: number };
  keep: { files: number; bytes: number };
  remove: PruneCandidate[];
  /** Too recent, or held by a running process. */
  held: { files: number; bytes: number };
  /** Pruned (or already missing) session -> kept session holding all of its points. */
  aliases: Record<string, string>;
  /** Sessions whose files stay (kept, held, or not Exocortex's). */
  remaining: Set<string>;
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
 * The entries Claude Code loads when it resumes this file, each with a hash
 * of its whole ancestry. That chain runs from the file's newest leaf back to
 * its start, or, once the file holds a compaction, from the newest entry
 * descending from its last compaction boundary back to that boundary (the
 * compacting process's own file ends with the command's entries on the old
 * chain, which Claude Code does not resume). Two files give the model the
 * same history up to an entry only when its hashes match: a compaction
 * re-parents the entries it preserves, so a later file can hold an earlier
 * file's entry under a different history. With `wanted`, only those entries
 * are returned.
 */
export function chainAncestry(path: string, wanted?: ReadonlySet<string>): Map<string, string> {
  const parent = new Map<string, string | null>();
  const order: string[] = [];
  let boundary: string | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let entry: { uuid?: unknown; parentUuid?: unknown; isSidechain?: unknown; type?: unknown; subtype?: unknown };
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry.uuid !== "string" || entry.isSidechain === true) continue;
    parent.set(entry.uuid, typeof entry.parentUuid === "string" ? entry.parentUuid : null);
    order.push(entry.uuid);
    if (entry.type === "system" && entry.subtype === "compact_boundary") boundary = entry.uuid;
  }
  const walk = (leaf: string | undefined) => {
    const chain: string[] = [];
    const seen = new Set<string>();
    for (let uuid: string | null = leaf ?? null; uuid && !seen.has(uuid); uuid = parent.get(uuid) ?? null) {
      seen.add(uuid);
      chain.push(uuid);
    }
    return chain;
  };
  let chain = walk(order.at(-1));
  if (boundary && !chain.includes(boundary)) {
    chain = [];
    for (let i = order.length - 1; i >= 0; i--) {
      const candidate = walk(order[i]);
      if (candidate.at(-1) === boundary) { chain = candidate; break; }
    }
  }
  const ancestry = new Map<string, string>();
  let hash = "";
  for (let i = chain.length - 1; i >= 0; i--) {
    hash = Bun.hash(`${hash}:${chain[i]}`).toString(36);
    if (!wanted || wanted.has(chain[i])) ancestry.set(chain[i], hash);
  }
  return ancestry;
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
 * its latest point (the next turn's), then for each older point, its own file
 * unless a kept file gives the same history up to it. A session the history
 * names that is not kept gets an alias when one kept file holds all of its
 * points. A session whose file an earlier prune moved is judged through the
 * file its alias named, while that file is still here.
 */
function coverHistory(
  points: RecordedResumePoint[],
  files: Map<string, SessionFile[]>,
  ancestryOf: (sessionId: string) => Map<string, string>,
  previousAliases: Readonly<Record<string, string>>,
): { kept: Set<string>; aliases: Map<string, string> } {
  const kept: string[] = [];
  const covers = new Map<string, Set<string | null>>();
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    const previous = previousAliases[point.sessionId];
    const reference = files.has(point.sessionId) ? point.sessionId : previous && files.has(previous) ? previous : null;
    const history = reference ? ancestryOf(reference).get(point.resumeAt) ?? null : null;
    let cover = history ? kept.find(sessionId => ancestryOf(sessionId).get(point.resumeAt) === history) ?? null : null;
    if (!cover && reference) {
      // Nothing kept gives this history: keep the file that does. A point before a
      // compaction in its own file resumes from nowhere; that file stays anyway.
      if (!kept.includes(reference)) kept.push(reference);
      cover = reference;
    }
    covers.set(point.sessionId, new Set([...(covers.get(point.sessionId) ?? []), cover]));
  }
  const aliases = new Map<string, string>();
  for (const [sessionId, targets] of covers) {
    if (kept.includes(sessionId) || targets.size !== 1) continue;
    const target = [...targets][0];
    if (target && target !== sessionId) aliases.set(sessionId, target);
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
    roots: [],
    scanned: { dirs: 0, files: 0, bytes: 0 },
    keep: { files: 0, bytes: 0 },
    remove: [],
    held: { files: 0, bytes: 0 },
    aliases: {},
    remaining: new Set(),
    outOfScope: { conversations: 0, points: 0 },
  };
  const roots = [...new Set(input.projectsRoots.filter(root => existsSync(root)).map(root => realpathSync(root)))];
  plan.roots = roots;
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
        if (now - newest >= goneGrace) plan.remove.push({ path: dir, root, bytes: allBytes, mtimeMs: newest, reason: "conversation-gone", directory: true });
        else {
          plan.held.files += all.length;
          plan.held.bytes += allBytes;
          for (const sessionId of files.keys()) plan.remaining.add(sessionId);
        }
        continue;
      }

      const wanted = new Set(histories.flat().map(point => point.resumeAt));
      const ancestries = new Map<string, Map<string, string>>();
      const ancestryOf = (sessionId: string) => {
        let ancestry = ancestries.get(sessionId);
        if (!ancestry) ancestries.set(sessionId, ancestry = chainAncestry(files.get(sessionId)![0].path, wanted));
        return ancestry;
      };
      const keep = new Set<string>();
      const aliasTargets = new Map<string, Set<string>>();
      for (const points of histories) {
        const { kept, aliases } = coverHistory(points, files, ancestryOf, input.previousAliases ?? {});
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
            plan.remaining.add(sessionId);
          } else if (protectedSessions.has(sessionId) || now - file.mtimeMs < grace) {
            plan.held.files++;
            plan.held.bytes += file.bytes;
            plan.remaining.add(sessionId);
          } else {
            plan.remove.push({ ...file, root, reason: isReferenced ? "superseded" : "unreferenced" });
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
  /** Where this run's files went, per projects root. */
  quarantined: string[];
  /** Quarantine days purged for good (older than the retention). */
  purged: string[];
}

/** Pruned files wait here a while (beside `projects/`, outside it), so a prune can be undone. */
export const QUARANTINE_DIR = "exocortex-prune-quarantine";
export const QUARANTINE_DAYS = 7;

export function quarantineRoot(projectsRoot: string): string {
  return join(dirname(projectsRoot), QUARANTINE_DIR);
}

function day(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** A free path: `path`, else `path.1`, `path.2`, … */
function freePath(path: string): string {
  if (!existsSync(path)) return path;
  for (let n = 1; ; n++) if (!existsSync(`${path}.${n}`)) return `${path}.${n}`;
}

/**
 * Move what the plan found into the quarantine (a rename: same filesystem,
 * mtimes kept), after writing its aliases, so a resume never finds its file
 * gone without one. A file written or a directory touched since the plan
 * stays. Quarantine days older than QUARANTINE_DAYS are then purged.
 */
export function applyClaudeSessionPrune(
  plan: SessionPrunePlan,
  aliasesPath: string,
  protectedSessions: ReadonlySet<string> = new Set(),
  now = Date.now(),
): SessionPruneResult {
  writeClaudeSessionAliases(aliasesPath, mergedAliases(aliasesPath, plan));
  const result: SessionPruneResult = { removedFiles: 0, removedBytes: 0, skipped: 0, errors: [], quarantined: [], purged: [] };
  const today = day(now);
  for (const candidate of plan.remove) {
    try {
      const target = freePath(join(quarantineRoot(candidate.root), today, relative(candidate.root, candidate.path)));
      if (candidate.directory) {
        if (!existsSync(candidate.path) || newestMtime(candidate.path) > candidate.mtimeMs) { result.skipped++; continue; }
        const files = readdirSync(candidate.path).filter(name => name.endsWith(".jsonl")).length;
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        renameSync(candidate.path, target);
        result.removedFiles += files;
      } else {
        const sessionId = basename(candidate.path).slice(0, -".jsonl".length);
        let stat;
        try { stat = lstatSync(candidate.path); } catch { result.skipped++; continue; }
        if (!stat.isFile() || stat.mtimeMs !== candidate.mtimeMs || protectedSessions.has(sessionId)) { result.skipped++; continue; }
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        renameSync(candidate.path, target);
        result.removedFiles++;
      }
      result.removedBytes += candidate.bytes;
      const dayDir = join(quarantineRoot(candidate.root), today);
      if (!result.quarantined.includes(dayDir)) result.quarantined.push(dayDir);
    } catch (error) {
      result.errors.push(`${candidate.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const root of plan.roots) result.purged.push(...purgeQuarantine(quarantineRoot(root), now));
  return result;
}

/** Delete quarantine days older than `days`. */
export function purgeQuarantine(root: string, now = Date.now(), days = QUARANTINE_DAYS): string[] {
  const purged: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return purged; }
  const cutoff = day(now - days * 24 * 60 * 60_000);
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name) || name >= cutoff) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    purged.push(join(root, name));
  }
  return purged;
}

/** Move one quarantine day's files back where they were; a file that exists there again stays in the quarantine. */
export function restoreQuarantine(projectsRoot: string, date: string): { restored: number; conflicts: string[] } {
  const source = join(quarantineRoot(projectsRoot), date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !existsSync(source)) throw new Error(`No quarantine for ${date} in ${quarantineRoot(projectsRoot)}`);
  const result = { restored: 0, conflicts: [] as string[] };
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) {
        visit(path);
        try { rmdirSync(path); } catch { /* conflicts left in it */ }
        continue;
      }
      const target = join(projectsRoot, relative(source, path));
      if (existsSync(target)) { result.conflicts.push(target); continue; }
      mkdirSync(dirname(target), { recursive: true });
      renameSync(path, target);
      result.restored++;
    }
  };
  visit(source);
  try { rmdirSync(source); } catch { /* conflicts left in it */ }
  return result;
}

interface AliasesFile {
  version: 1;
  aliases: Record<string, string>;
}

export function readAliases(path: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AliasesFile>;
    return parsed.version === 1 && parsed.aliases && typeof parsed.aliases === "object" ? parsed.aliases : {};
  } catch {
    return {};
  }
}

/**
 * This run's aliases plus every earlier one still useful: its session's file
 * is gone and its target's stays. So an alias outlives the history that named
 * it, and goes only with its target.
 */
function mergedAliases(path: string, plan: SessionPrunePlan): Record<string, string> {
  const removed = new Set(plan.remove.filter(candidate => !candidate.directory).map(candidate => basename(candidate.path).slice(0, -".jsonl".length)));
  const merged: Record<string, string> = {};
  for (const [sessionId, target] of Object.entries(readAliases(path))) {
    if (typeof target !== "string" || plan.remaining.has(sessionId) && !removed.has(sessionId)) continue;
    if (plan.remaining.has(target) && !removed.has(target)) merged[sessionId] = target;
  }
  return { ...merged, ...plan.aliases };
}

/** Written whole and synced before it replaces the old file, so a crash leaves one or the other. */
export function writeClaudeSessionAliases(path: string, aliases: Record<string, string>): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify({ version: 1, aliases } satisfies AliasesFile) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

let aliasCache: { path: string; version: string; aliases: Record<string, string> } | null = null;

/** The kept session a pruned one's points live in, if the prune recorded one. */
export function claudeSessionAlias(path: string, sessionId: string): string | null {
  let version: string;
  try {
    const stat = statSync(path);
    // Each write is a new file renamed into place: a new inode.
    version = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
  if (aliasCache?.path !== path || aliasCache.version !== version) aliasCache = { path, version, aliases: readAliases(path) };
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
