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
 * the filesystem directly. Explicit excludes and symlink controls still apply.
 *
 * Supports output limiting, excludes, multiple include patterns, fuzzy path
 * queries, configurable sorting, and optional metadata output.
 */

import type { Tool, ToolResult, ToolSummary, ToolExecutionContext } from "./types";
import { cap, getString, getBoolean, summarizeParams } from "./util";
import { log } from "../log";
import { lstat, opendir, realpath, stat as fsStat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

// ── Constants ─────────────────────────────────────────────────────

/** Directories to skip in the non-git fallback path (mirrors grep tool). */
const EXCLUDED_DIRS = [
  ".git",
  ".svn",
  ".hg",
  ".bzr",
  "node_modules",
  "dosdevices",
  "pfx",
  "wineprefix",
  "lost+found",
];

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
    if (signal) {
      const onAbort = () => proc.kill();
      if (signal.aborted) { onAbort(); }
      else { signal.addEventListener("abort", onAbort, { once: true }); }
    }
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    return stdout.trimEnd().split("\n").filter(Boolean);
  } catch {
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
  return parts.some(part => EXCLUDED_DIRS.includes(part));
}

function matchesExclude(rel: string, excludeGlobs: Bun.Glob[], isDirectory = false): boolean {
  if (excludeGlobs.length === 0) return false;
  if (anyGlobMatch(rel, excludeGlobs)) return true;
  // Directory excludes are commonly written as "foo/**"; test a virtual child
  // so we can prune before entering that directory instead of filtering after.
  if (isDirectory && anyGlobMatch(`${rel}/__glob_prune_probe__`, excludeGlobs)) return true;
  return false;
}

function shouldPruneDirectory(rel: string, noIgnore: boolean, excludeGlobs: Bun.Glob[]): boolean {
  if (rel.length === 0) return false;
  if (!noIgnore && excludedByDefault(rel)) return true;
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
  noIgnore: boolean,
  excludeGlobs: Bun.Glob[],
  followSymlinks: boolean,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const root = resolve(cwd);
  const files: string[] = [];
  const skipped: SkippedPath[] = [];
  const seenDirectories = new Set<string>();

  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error(`path is not a directory: ${cwd}`);
  seenDirectories.add(await realpath(root));

  const walk = async (abs: string, rel: string): Promise<void> => {
    signal?.throwIfAborted?.();
    if (shouldPruneDirectory(rel, noIgnore, excludeGlobs)) return;

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
        const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
        const childAbs = join(abs, dirent.name);
        if (matchesExclude(childRel, excludeGlobs, dirent.isDirectory())) continue;
        if (!noIgnore && excludedByDefault(childRel)) continue;

        if (dirent.isDirectory()) {
          await walk(childAbs, childRel);
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
              const targetReal = await realpath(childAbs);
              if (seenDirectories.has(targetReal)) {
                skipped.push({ path: childRel, reason: "symlink cycle" });
                continue;
              }
              seenDirectories.add(targetReal);
              await walk(childAbs, childRel);
            } else if (targetStat.isFile() || targetStat.isSymbolicLink()) {
              files.push(childRel);
            }
          } catch (err) {
            skipped.push({ path: childRel, reason: errorReason(err) });
          }
          continue;
        }

        if (dirent.isFile()) files.push(childRel);
      }
    } catch (err) {
      skipped.push({ path: rel || ".", reason: errorReason(err) });
    }
  };

  await walk(root, "");
  return { files, skipped };
}

function findPruneArgs(root: string, noIgnore: boolean, excludePatterns: string[]): string[] {
  const args: string[] = ["("];
  let clauses = 0;
  const addOr = () => { if (clauses++ > 0) args.push("-o"); };

  EXCLUDED_DIRS.forEach((dir, index) => {
    if (noIgnore) return;
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
  noIgnore: boolean,
  excludePatterns: string[],
  followSymlinks: boolean,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const root = resolve(cwd);
  const args = ["-n", "find", ...(followSymlinks ? ["-L"] : []), root, ...findPruneArgs(root, noIgnore, excludePatterns), "-type", "f", "-printf", "%P\\0"];
  const proc = Bun.spawn(["sudo", ...args], { stdout: "pipe", stderr: "pipe" });
  if (signal) {
    const onAbort = () => proc.kill();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    const msg = stderr.trim() || `sudo find exited with code ${code}`;
    throw new Error(`sudo glob scan failed: ${msg}`);
  }

  const files = stdout.split("\0").filter(Boolean);
  const skipped = stderr.trim()
    ? stderr.trim().split("\n").slice(0, 20).map(line => ({ path: "sudo find", reason: line }))
    : [];
  return { files, skipped };
}

// ── Execution ─────────────────────────────────────────────────────

async function executeGlob(input: Record<string, unknown>, _context?: ToolExecutionContext, signal?: AbortSignal): Promise<ToolResult> {
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

  try {
    const globs = patterns.map(pattern => new Bun.Glob(pattern));

    // --- Collect candidate paths --------------------------------

    let matched: string[];
    let skipped: SkippedPath[] = [];

    if (!noIgnore) {
      const gitFiles = await getGitFiles(cwd, signal);
      if (gitFiles) {
        // Fast path: filter the git-known file list with the glob patterns.
        matched = gitFiles.filter(f => anyGlobMatch(f, globs) && !anyGlobMatch(f, excludeGlobs));
      } else {
        // Fallback: safe full scan, pruning common junk directories before
        // entering them and skipping unreadable/looping descendants.
        const scan = useSudo
          ? await sudoFilesystemScan(cwd, noIgnore, excludePatterns, followSymlinks, signal)
          : await safeFilesystemScan(cwd, noIgnore, excludeGlobs, followSymlinks, signal);
        skipped = scan.skipped;
        matched = scan.files.filter(f => anyGlobMatch(f, globs) && !matchesExclude(f, excludeGlobs));
      }
    } else {
      // Raw filesystem scan. no_ignore bypasses gitignore/git-ls-files only;
      // symlink recursion is controlled solely by follow_symlinks.
      const scan = useSudo
        ? await sudoFilesystemScan(cwd, noIgnore, excludePatterns, followSymlinks, signal)
        : await safeFilesystemScan(cwd, noIgnore, excludeGlobs, followSymlinks, signal);
      skipped = scan.skipped;
      matched = scan.files.filter(f => anyGlobMatch(f, globs) && !matchesExclude(f, excludeGlobs));
    }

    if (query) {
      matched = matched.filter(rel => fuzzyScore(query, rel) !== null);
    }

    // --- Stat & sort --------------------------------------------

    let entries: GlobEntry[] = [];

    for (const rel of matched) {
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

    sortEntries(entries, sort);

    if (limit !== undefined) entries = entries.slice(0, limit);

    if (entries.length === 0) {
      return { output: appendWarning(query ? "No files matched the pattern/query." : "No files matched the pattern.", skipped, metadata), isError: false };
    }

    const content = entries.map(e => metadata ? formatMetadataEntry(e) : e.path).join("\n");
    return { output: cap(appendWarning(content, skipped, metadata)), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `globFiles: ${patterns.join(", ")}: ${msg}`);
    return { output: `Error globbing "${patterns.join(", ")}": ${msg}`, isError: true };
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
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The glob pattern to match files against" },
      patterns: { type: "array", items: { type: "string" }, description: "Additional glob patterns to include. Use this instead of or alongside pattern for multiple includes." },
      path: { type: "string", description: "Directory to search in. Defaults to working directory." },
      no_ignore: { type: "boolean", description: "Bypass .gitignore/git-ls-files filtering and scan the filesystem directly (default false). Does not change symlink behavior." },
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
  systemHint: "Prefer the glob tool over find/ls for finding files by name pattern.",
  display: {
    label: "Glob",
    color: "#ffcb6b",  // warm yellow
  },
  summarize,
  execute: executeGlob,
};
