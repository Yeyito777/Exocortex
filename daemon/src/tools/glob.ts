/**
 * Glob tool — fast file pattern matching.
 *
 * Respects .gitignore by default: when inside a git repository, uses
 * `git ls-files` to obtain the set of tracked + untracked-but-not-ignored
 * files, then filters that list with Bun.Glob.match().
 *
 * Falls back to a safe filesystem walker with a hardcoded exclusion list when
 * git is unavailable or the directory is outside a repo.
 *
 * Pass `no_ignore: true` to bypass gitignore/git-ls-files filtering and scan
 * the filesystem directly. Hard safety exclusions, explicit excludes, and
 * symlink controls still apply.
 *
 * Supports output limiting, excludes, multiple include patterns, fuzzy path
 * queries, configurable sorting, and optional metadata output.
 */

import type { Tool, ToolResult, ToolSummary, ToolExecutionContext } from "./types";
import { cap, getString, getBoolean, summarizeParams } from "./util";
import { log } from "../log";
import { lstat, opendir, realpath, stat as fsStat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createAbortError, isAbortLikeError } from "../abort";
import { HARD_EXCLUDED_DIRS } from "./filesystem-safety";

// ── Constants ─────────────────────────────────────────────────────

const MAX_SCAN_ENTRIES = Math.max(
  1_000,
  Math.floor(Number(process.env.GLOB_MAX_SCAN_ENTRIES) || 500_000),
);
const MAX_SCAN_DIRECTORIES = Math.max(
  100,
  Math.floor(Number(process.env.GLOB_MAX_SCAN_DIRECTORIES) || 50_000),
);

type SortMode = "mtime_desc" | "mtime_asc" | "name" | "path" | "size_desc" | "size_asc" | "score_desc";

interface GlobEntry {
  path: string;
  mtimeMs: number;
  size: number;
  type: string;
  score?: number;
}

interface SkippedPath {
  path: string;
  reason: string;
}

interface ScanResult {
  files: string[];
  skipped: SkippedPath[];
}

interface TraversalPlan {
  /** Literal directory prefix shared by every include pattern. */
  prefix: string;
  /** Maximum directories to descend below prefix; null means recursive. */
  maxDirectoryDepth: number | null;
}

class GlobScanBudgetError extends Error {
  constructor(readonly visitedEntries: number, readonly visitedDirectories: number) {
    super(
      `scan budget exceeded after visiting ${visitedEntries.toLocaleString()} entries in ${visitedDirectories.toLocaleString()} directories `
      + `(limits: ${MAX_SCAN_ENTRIES.toLocaleString()} entries, ${MAX_SCAN_DIRECTORIES.toLocaleString()} directories). Narrow the path/pattern or remove no_ignore.`,
    );
    this.name = "GlobScanBudgetError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Ask git for every file that is either tracked or untracked-but-not-ignored
 * under `cwd`.  Returns `null` when git is unavailable or `cwd` is not inside
 * a repository, so the caller can fall back gracefully.
 */
async function getGitFiles(cwd: string, signal?: AbortSignal): Promise<string[] | null> {
  try {
    const proc = Bun.spawn(
      ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    // Kill git on abort
    const onAbort = () => proc.kill();
    if (signal) {
      if (signal.aborted) { onAbort(); }
      else { signal.addEventListener("abort", onAbort, { once: true }); }
    }
    let stdout: string;
    let code: number;
    try {
      stdout = await new Response(proc.stdout).text();
      code = await proc.exited;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted) throw createAbortError();
    if (code !== 0) return null;
    return stdout.trimEnd().split("\n").filter(Boolean);
  } catch (err) {
    if (signal?.aborted || isAbortLikeError(err)) throw createAbortError();
    return null;
  }
}

function getNumber(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function getStringArray(input: Record<string, unknown>, key: string): string[] {
  const v = input[key];
  if (typeof v === "string") return v.trim() ? [v] : [];
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function includePatterns(input: Record<string, unknown>, query: string | undefined): string[] {
  const primary = getString(input, "pattern");
  const patterns = unique([
    ...(primary && primary.trim() ? [primary] : []),
    ...getStringArray(input, "patterns"),
  ]);

  // A bare fuzzy query searches all files unless the caller narrows it with
  // pattern/patterns.
  if (patterns.length === 0 && query) return ["**/*"];
  return patterns;
}

const GLOB_SEGMENT_META = /[*?\[\]{}]/;

function normalizedPatternSegments(pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.split("/").filter(segment => segment.length > 0 && segment !== ".");
}

function commonPrefix(parts: string[][]): string[] {
  if (parts.length === 0) return [];
  const result: string[] = [];
  const shortest = Math.min(...parts.map(value => value.length));
  for (let i = 0; i < shortest; i++) {
    const value = parts[0][i];
    if (!parts.every(candidate => candidate[i] === value)) break;
    result.push(value);
  }
  return result;
}

/**
 * Determine the smallest safe subtree/depth needed by the include patterns.
 * In particular, a bare `*` is a root-only lookup rather than a recursive walk.
 */
function buildTraversalPlan(patterns: string[]): TraversalPlan {
  const details = patterns.map(pattern => {
    const segments = normalizedPatternSegments(pattern);
    const literalDirectories: string[] = [];
    for (const segment of segments.slice(0, -1)) {
      if (segment === ".." || GLOB_SEGMENT_META.test(segment)) break;
      literalDirectories.push(segment);
    }
    const recursive = segments.some(segment => segment === "**");
    return {
      literalDirectories,
      fileDirectoryDepth: Math.max(0, segments.length - 1),
      recursive,
    };
  });

  const prefixSegments = commonPrefix(details.map(detail => detail.literalDirectories));
  const maxDirectoryDepth = details.some(detail => detail.recursive)
    ? null
    : Math.max(0, ...details.map(detail => detail.fileDirectoryDepth - prefixSegments.length));

  return {
    prefix: prefixSegments.join("/"),
    maxDirectoryDepth,
  };
}

function anyGlobMatch(path: string, globs: Bun.Glob[]): boolean {
  return globs.some(glob => glob.match(path));
}

function fileType(stat: { isFile?: () => boolean; isDirectory?: () => boolean; isSymbolicLink?: () => boolean }): string {
  if (stat.isSymbolicLink?.()) return "symlink";
  if (stat.isDirectory?.()) return "directory";
  if (stat.isFile?.()) return "file";
  return "other";
}

function fuzzyTokenScore(token: string, target: string): number | null {
  let targetIndex = 0;
  let score = 0;
  let consecutive = 0;

  for (const char of token) {
    const foundAt = target.indexOf(char, targetIndex);
    if (foundAt === -1) return null;

    const gap = foundAt - targetIndex;
    const atBoundary = foundAt === 0 || /[\/_\-.\s]/.test(target[foundAt - 1] ?? "");

    score += 10;
    score += gap === 0 ? 8 + consecutive * 2 : Math.max(0, 6 - gap);
    if (atBoundary) score += 5;

    consecutive = gap === 0 ? consecutive + 1 : 0;
    targetIndex = foundAt + 1;
  }

  if (target.includes(token)) score += 35;
  if (basename(target).includes(token)) score += 15;

  return score;
}

function fuzzyScore(query: string, path: string): number | null {
  const normalizedPath = path.toLowerCase();
  const normalizedBase = basename(normalizedPath);
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let score = 0;
  for (const token of tokens) {
    const pathScore = fuzzyTokenScore(token, normalizedPath);
    if (pathScore === null) return null;
    score += pathScore;
    if (normalizedBase.includes(token)) score += 20;
  }

  const joinedQuery = tokens.join("");
  if (normalizedPath.includes(joinedQuery)) score += 40;
  if (normalizedBase.includes(joinedQuery)) score += 25;

  // Prefer concise matches when scores are otherwise similar.
  score -= normalizedPath.length * 0.05;
  return score;
}

function sortEntries(entries: GlobEntry[], mode: SortMode): void {
  const byPath = (a: GlobEntry, b: GlobEntry) => a.path.localeCompare(b.path);
  const byName = (a: GlobEntry, b: GlobEntry) => basename(a.path).localeCompare(basename(b.path)) || byPath(a, b);

  entries.sort((a, b) => {
    switch (mode) {
      case "mtime_asc": return a.mtimeMs - b.mtimeMs || byPath(a, b);
      case "name": return byName(a, b);
      case "path": return byPath(a, b);
      case "size_desc": return b.size - a.size || byPath(a, b);
      case "size_asc": return a.size - b.size || byPath(a, b);
      case "score_desc": return (b.score ?? 0) - (a.score ?? 0) || b.mtimeMs - a.mtimeMs || byPath(a, b);
      case "mtime_desc":
      default: return b.mtimeMs - a.mtimeMs || byPath(a, b);
    }
  });
}

function formatMetadataEntry(entry: GlobEntry): string {
  return JSON.stringify({
    path: entry.path,
    size: entry.size,
    modified: entry.mtimeMs > 0 ? new Date(entry.mtimeMs).toISOString() : null,
    type: entry.type,
    ...(entry.score !== undefined ? { score: Number(entry.score.toFixed(2)) } : {}),
  });
}

function errorReason(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return err instanceof Error ? err.message : String(err);
}

function excludedByDefault(rel: string): boolean {
  const parts = rel.split("/").filter(Boolean);
  return parts.some(part => HARD_EXCLUDED_DIRS.includes(part));
}

function matchesExclude(rel: string, excludeGlobs: Bun.Glob[], isDirectory = false): boolean {
  if (excludeGlobs.length === 0) return false;
  if (anyGlobMatch(rel, excludeGlobs)) return true;
  // Directory excludes are commonly written as "foo/**"; test a virtual child
  // so we can prune before entering that directory instead of filtering after.
  if (isDirectory && anyGlobMatch(`${rel}/__glob_prune_probe__`, excludeGlobs)) return true;
  return false;
}

function shouldPruneDirectory(rel: string, excludeGlobs: Bun.Glob[]): boolean {
  if (rel.length === 0) return false;
  // `no_ignore` bypasses VCS ignore files, not Exocortex's hard traversal
  // exclusions. A caller can still inspect one of these directories by making
  // it the explicit scan root (whose relative path is empty here).
  if (excludedByDefault(rel)) return true;
  return matchesExclude(rel, excludeGlobs, true);
}

function appendWarning(output: string, skipped: SkippedPath[], metadata = false): string {
  if (skipped.length === 0) return output;
  if (metadata) {
    const warningLines = skipped.slice(0, 20).map(item => JSON.stringify({ warning: "glob skipped inaccessible/looping path", path: item.path, reason: item.reason }));
    const more = skipped.length > warningLines.length
      ? [JSON.stringify({ warning: "glob skipped additional inaccessible/looping paths", count: skipped.length - warningLines.length })]
      : [];
    return `${output}\n${[...warningLines, ...more].join("\n")}`;
  }
  const first = skipped.slice(0, 5).map(item => `- ${item.path}: ${item.reason}`).join("\n");
  const more = skipped.length > 5 ? `\n- ... ${skipped.length - 5} more` : "";
  return `${output}\n\n[glob skipped ${skipped.length} inaccessible/looping path${skipped.length === 1 ? "" : "s"}:\n${first}${more}\n]`;
}

async function safeFilesystemScan(
  cwd: string,
  plan: TraversalPlan,
  excludeGlobs: Bun.Glob[],
  followSymlinks: boolean,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const root = resolve(cwd);
  const files: string[] = [];
  const skipped: SkippedPath[] = [];
  const seenDirectories = new Set<string>();
  let visitedEntries = 0;
  let visitedDirectories = 0;

  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error(`path is not a directory: ${cwd}`);
  seenDirectories.add(await realpath(root));

  const enforceBudget = () => {
    if (visitedEntries > MAX_SCAN_ENTRIES || visitedDirectories > MAX_SCAN_DIRECTORIES) {
      throw new GlobScanBudgetError(visitedEntries, visitedDirectories);
    }
  };

  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    signal?.throwIfAborted?.();
    if (shouldPruneDirectory(rel, excludeGlobs)) return;
    visitedDirectories++;
    enforceBudget();

    let dir;
    try {
      dir = await opendir(abs);
    } catch (err) {
      if (rel === "") throw new Error(`cannot read directory ${cwd}: ${errorReason(err)}`);
      skipped.push({ path: rel || ".", reason: errorReason(err) });
      return;
    }

    try {
      for await (const dirent of dir) {
        signal?.throwIfAborted?.();
        visitedEntries++;
        enforceBudget();
        const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
        const childAbs = join(abs, dirent.name);
        if (matchesExclude(childRel, excludeGlobs, dirent.isDirectory())) continue;
        if (excludedByDefault(childRel)) continue;

        if (dirent.isDirectory()) {
          if (plan.maxDirectoryDepth === null || depth < plan.maxDirectoryDepth) {
            await walk(childAbs, childRel, depth + 1);
          }
          continue;
        }

        if (dirent.isSymbolicLink()) {
          if (!followSymlinks) {
            files.push(childRel);
            continue;
          }
          try {
            const targetStat = await fsStat(childAbs);
            if (targetStat.isDirectory()) {
              if (plan.maxDirectoryDepth !== null && depth >= plan.maxDirectoryDepth) continue;
              const targetReal = await realpath(childAbs);
              if (seenDirectories.has(targetReal)) {
                skipped.push({ path: childRel, reason: "symlink cycle" });
                continue;
              }
              seenDirectories.add(targetReal);
              await walk(childAbs, childRel, depth + 1);
            } else if (targetStat.isFile() || targetStat.isSymbolicLink()) {
              files.push(childRel);
            }
          } catch (err) {
            if (signal?.aborted || err instanceof GlobScanBudgetError || isAbortLikeError(err)) throw err;
            skipped.push({ path: childRel, reason: errorReason(err) });
          }
          continue;
        }

        if (dirent.isFile()) files.push(childRel);
      }
    } catch (err) {
      if (signal?.aborted || err instanceof GlobScanBudgetError || isAbortLikeError(err)) throw err;
      skipped.push({ path: rel || ".", reason: errorReason(err) });
    }
  };

  const scanRoot = plan.prefix ? join(root, plan.prefix) : root;
  if (plan.prefix) {
    try {
      const prefixStat = await lstat(scanRoot);
      if (!prefixStat.isDirectory()) return { files, skipped };
      seenDirectories.add(await realpath(scanRoot));
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
        return { files, skipped };
      }
      throw err;
    }
  }
  await walk(scanRoot, plan.prefix, 0);
  return { files, skipped };
}

function findPruneArgs(root: string, excludePatterns: string[]): string[] {
  const args: string[] = ["("];
  let clauses = 0;
  const addOr = () => { if (clauses++ > 0) args.push("-o"); };

  HARD_EXCLUDED_DIRS.forEach((dir) => {
    addOr();
    args.push("-name", dir);
  });

  for (const pattern of excludePatterns) {
    const normalized = pattern.replace(/^\.\//, "");
    const withoutTrailingChildren = normalized.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
    const candidates = unique([
      normalized,
      withoutTrailingChildren,
    ]).filter(Boolean);
    for (const candidate of candidates) {
      addOr();
      args.push("-path", `${root}/${candidate.replace(/\*\*/g, "*")}`);
    }
  }

  if (clauses === 0) return [];
  args.push(")", "-prune", "-o");
  return args;
}

async function sudoFilesystemScan(
  cwd: string,
  excludePatterns: string[],
  followSymlinks: boolean,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const root = resolve(cwd);
  const args = ["-n", "find", ...(followSymlinks ? ["-L"] : []), root, "-mindepth", "1", ...findPruneArgs(root, excludePatterns), "-type", "f", "-printf", "%P\\0"];
  const proc = Bun.spawn(["sudo", ...args], { stdout: "pipe", stderr: "pipe" });
  const onAbort = () => proc.kill();
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  let stdout: string;
  let stderr: string;
  let code: number;
  try {
    [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  if (signal?.aborted) throw createAbortError();

  if (code !== 0) {
    const msg = stderr.trim() || `sudo find exited with code ${code}`;
    throw new Error(`sudo glob scan failed: ${msg}`);
  }

  const files = stdout.split("\0").filter(Boolean);
  if (files.length > MAX_SCAN_ENTRIES) {
    throw new GlobScanBudgetError(files.length, 0);
  }
  const skipped = stderr.trim()
    ? stderr.trim().split("\n").slice(0, 20).map(line => ({ path: "sudo find", reason: line }))
    : [];
  return { files, skipped };
}

// ── Execution ─────────────────────────────────────────────────────

export async function executeGlobInProcess(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const query = getString(input, "query")?.trim();
  const patterns = includePatterns(input, query);
  if (patterns.length === 0) return { output: "Error: missing 'pattern', 'patterns', or 'query' parameter", isError: true };

  const cwd = getString(input, "path") ?? process.cwd();
  const noIgnore = getBoolean(input, "no_ignore") ?? false;
  const followSymlinks = getBoolean(input, "follow_symlinks") ?? false;
  const useSudo = getBoolean(input, "sudo") ?? false;
  const excludePatterns = getStringArray(input, "exclude");
  const excludeGlobs = excludePatterns.map(pattern => new Bun.Glob(pattern));
  const limitInput = getNumber(input, "limit");
  const limit = limitInput !== undefined && limitInput > 0 ? Math.floor(limitInput) : undefined;
  const requestedSort = getString(input, "sort") as SortMode | undefined;
  const validSorts = new Set<SortMode>(["mtime_desc", "mtime_asc", "name", "path", "size_desc", "size_asc", "score_desc"]);
  const sort = requestedSort && validSorts.has(requestedSort) ? requestedSort : (query ? "score_desc" : "mtime_desc");
  const metadata = getBoolean(input, "metadata") ?? false;
  const traversalPlan = buildTraversalPlan(patterns);

  try {
    signal?.throwIfAborted?.();
    const globs = patterns.map(pattern => new Bun.Glob(pattern));

    // --- Collect candidate paths --------------------------------

    let matched: string[];
    let skipped: SkippedPath[] = [];

    if (!noIgnore) {
      const gitFiles = await getGitFiles(cwd, signal);
      if (gitFiles) {
        // Fast path: filter the git-known file list with the glob patterns.
        matched = gitFiles.filter(f => !excludedByDefault(f) && anyGlobMatch(f, globs) && !anyGlobMatch(f, excludeGlobs));
      } else {
        // Fallback: safe full scan, pruning common junk directories before
        // entering them and skipping unreadable/looping descendants.
        const scan = useSudo
          ? await sudoFilesystemScan(cwd, excludePatterns, followSymlinks, signal)
          : await safeFilesystemScan(cwd, traversalPlan, excludeGlobs, followSymlinks, signal);
        skipped = scan.skipped;
        matched = scan.files.filter(f => anyGlobMatch(f, globs) && !matchesExclude(f, excludeGlobs));
      }
    } else {
      // Raw filesystem scan. no_ignore bypasses gitignore/git-ls-files only;
      // symlink recursion is controlled solely by follow_symlinks.
      const scan = useSudo
        ? await sudoFilesystemScan(cwd, excludePatterns, followSymlinks, signal)
        : await safeFilesystemScan(cwd, traversalPlan, excludeGlobs, followSymlinks, signal);
      skipped = scan.skipped;
      matched = scan.files.filter(f => anyGlobMatch(f, globs) && !matchesExclude(f, excludeGlobs));
    }

    if (query) {
      matched = matched.filter(rel => fuzzyScore(query, rel) !== null);
    }

    if (matched.length > MAX_SCAN_ENTRIES) {
      throw new GlobScanBudgetError(matched.length, 0);
    }

    // --- Stat & sort --------------------------------------------

    let entries: GlobEntry[] = [];

    // Path/name ordering does not require file metadata. Sort and apply the
    // output limit before statting so `limit: 200` performs at most 200 stats.
    const preSorted = sort === "path" || sort === "name";
    if (sort === "path") {
      matched.sort((a, b) => a.localeCompare(b));
    } else if (sort === "name") {
      matched.sort((a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b));
    }
    if (preSorted && limit !== undefined) matched = matched.slice(0, limit);

    for (const rel of matched) {
      signal?.throwIfAborted?.();
      if (preSorted && !metadata) {
        entries.push({
          path: rel,
          mtimeMs: 0,
          size: 0,
          type: "file",
          ...(query ? { score: fuzzyScore(query, rel) ?? 0 } : {}),
        });
        continue;
      }
      try {
        const stat = await Bun.file(join(cwd, rel)).stat();
        entries.push({
          path: rel,
          mtimeMs: stat?.mtimeMs ?? 0,
          size: stat?.size ?? 0,
          type: fileType(stat),
          ...(query ? { score: fuzzyScore(query, rel) ?? 0 } : {}),
        });
      } catch {
        entries.push({
          path: rel,
          mtimeMs: 0,
          size: 0,
          type: "unknown",
          ...(query ? { score: fuzzyScore(query, rel) ?? 0 } : {}),
        });
      }
    }

    if (!preSorted) sortEntries(entries, sort);

    if (!preSorted && limit !== undefined) entries = entries.slice(0, limit);

    if (entries.length === 0) {
      return { output: appendWarning(query ? "No files matched the pattern/query." : "No files matched the pattern.", skipped, metadata), isError: false };
    }

    const content = entries.map(e => metadata ? formatMetadataEntry(e) : e.path).join("\n");
    return { output: cap(appendWarning(content, skipped, metadata)), isError: false };
  } catch (err) {
    if (signal?.aborted || isAbortLikeError(err)) throw createAbortError();
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `globFiles: ${patterns.join(", ")}: ${msg}`);
    return { output: `Error globbing "${patterns.join(", ")}": ${msg}`, isError: true };
  }
}

/**
 * Glob can traverse attacker/model-selected directory trees. Keep that work out
 * of the daemon process so a runtime bug, synchronous filesystem stall, or
 * memory spike cannot block the orchestration event loop. The registry deadline
 * aborts this wrapper, which kills the runner's whole process group.
 */
async function executeGlob(input: Record<string, unknown>, _context?: ToolExecutionContext, signal?: AbortSignal): Promise<ToolResult> {
  if (signal?.aborted) throw createAbortError();

  const runner = join(import.meta.dir, "glob-runner.ts");
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([process.execPath, runner], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
      env: { ...process.env },
    });
  } catch (err) {
    return { output: `Error starting isolated glob runner: ${errorReason(err)}`, isError: true };
  }

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let terminating = false;
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    try {
      if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGTERM");
      else proc.kill();
    } catch {
      try { proc.kill(); } catch { /* already exited */ }
    }
    killTimer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill(9);
      } catch { /* already exited */ }
    }, 1_000);
    killTimer.unref?.();
  };

  const onAbort = () => terminate();
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  }

  try {
    const serialized = JSON.stringify(input);
    const stdin = proc.stdin;
    stdin.write(serialized);
    stdin.end();

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);

    if (signal?.aborted) throw createAbortError();
    if (exitCode !== 0) {
      return {
        output: `Isolated glob runner failed (exit ${exitCode}): ${stderr.trim().slice(0, 2_000) || "no error output"}`,
        isError: true,
      };
    }

    try {
      const parsed = JSON.parse(stdout) as Partial<ToolResult>;
      if (typeof parsed.output !== "string" || typeof parsed.isError !== "boolean") {
        throw new Error("invalid result envelope");
      }
      return { output: parsed.output, isError: parsed.isError };
    } catch (err) {
      return {
        output: `Invalid isolated glob runner response: ${errorReason(err)}${stderr.trim() ? `\n${stderr.trim().slice(0, 2_000)}` : ""}`,
        isError: true,
      };
    }
  } catch (err) {
    terminate();
    if (signal?.aborted || isAbortLikeError(err)) throw createAbortError();
    return { output: `Isolated glob runner error: ${errorReason(err)}`, isError: true };
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    if (killTimer) clearTimeout(killTimer);
  }
}

// ── Summary ───────────────────────────────────────────────────────

function summarize(input: Record<string, unknown>): ToolSummary {
  const query = getString(input, "query");
  const patterns = getStringArray(input, "patterns");
  const pattern = getString(input, "pattern");
  const primary = pattern ?? (patterns.length > 0 ? patterns.join(",") : (query ? `~${query}` : ""));
  const skip = ["pattern"];
  if (!pattern) skip.push("patterns");
  if (!pattern && patterns.length === 0) skip.push("query");
  return { label: "Glob", detail: summarizeParams(primary, input, skip) };
}

// ── Tool definition ───────────────────────────────────────────────

export const glob: Tool = {
  name: "glob",
  description: "Fast file pattern matching. Supports glob patterns like \"**/*.ts\" or \"src/**/*.tsx\", multiple include patterns, excludes, fuzzy path queries, limits, sorting, and optional metadata output.",
  parallelSafety: "safe",
  defaultTimeoutMs: 30_000,
  resourceClass: "filesystem_scan",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The glob pattern to match files against" },
      patterns: { type: "array", items: { type: "string" }, description: "Additional glob patterns to include. Use this instead of or alongside pattern for multiple includes." },
      path: { type: "string", description: "Directory to search in. Defaults to working directory." },
      no_ignore: { type: "boolean", description: "Bypass .gitignore/git-ls-files filtering and scan the filesystem directly (default false). Hard safety exclusions and symlink controls still apply; target an excluded directory directly when needed." },
      follow_symlinks: { type: "boolean", description: "Follow symlinked directories during filesystem scans (default false). Leave false to avoid recursive loops." },
      sudo: { type: "boolean", description: "Use non-interactive sudo (-n) for filesystem scans when elevated traversal is required (default false)." },
      exclude: { type: "array", items: { type: "string" }, description: "Glob patterns to exclude from results (e.g. [\"**/node_modules/**\", \"**/*.d.ts\"])." },
      query: { type: "string", description: "Fuzzy path query. If supplied, candidates are filtered/scored by fuzzy match; omit pattern(s) to search all files." },
      limit: { type: "number", description: "Return at most this many results after filtering and sorting." },
      sort: {
        type: "string",
        enum: ["mtime_desc", "mtime_asc", "name", "path", "size_desc", "size_asc", "score_desc"],
        description: "Sort order. Defaults to mtime_desc, or score_desc when query is supplied.",
      },
      metadata: { type: "boolean", description: "Return JSON lines with path, size, modified time, type, and fuzzy score when available instead of plain paths." },
    },
  },
  systemHint: "Prefer the glob tool over find/ls for finding files by name pattern. Keep the path as narrow as practical; avoid broad no_ignore scans when a specific directory will do.",
  display: {
    label: "Glob",
    color: "#ffcb6b",  // warm yellow
  },
  summarize,
  execute: executeGlob,
};
