/**
 * Glob tool — fast file pattern matching.
 *
 * Respects .gitignore by default: when inside a git repository, uses
 * `git ls-files` to obtain the set of tracked + untracked-but-not-ignored
 * files, then filters that list with Bun.Glob.match().
 *
 * Falls back to Bun.Glob.scan() with a hardcoded exclusion list when
 * git is unavailable or the directory is outside a repo.
 *
 * Pass `no_ignore: true` to bypass all filtering and scan the raw filesystem.
 *
 * Supports output limiting, excludes, multiple include patterns, fuzzy path
 * queries, configurable sorting, and optional metadata output.
 */

import type { Tool, ToolResult, ToolSummary, ToolExecutionContext } from "./types";
import { cap, getString, getBoolean, summarizeParams } from "./util";
import { log } from "../log";
import { basename, join } from "node:path";

// ── Constants ─────────────────────────────────────────────────────

/** Directories to skip in the non-git fallback path (mirrors grep tool). */
const EXCLUDED_DIRS = [".git", ".svn", ".hg", ".bzr", "node_modules"];

type SortMode = "mtime_desc" | "mtime_asc" | "name" | "path" | "size_desc" | "size_asc" | "score_desc";

interface GlobEntry {
  path: string;
  mtimeMs: number;
  size: number;
  type: string;
  score?: number;
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

// ── Execution ─────────────────────────────────────────────────────

async function executeGlob(input: Record<string, unknown>, _context?: ToolExecutionContext, signal?: AbortSignal): Promise<ToolResult> {
  const query = getString(input, "query")?.trim();
  const patterns = includePatterns(input, query);
  if (patterns.length === 0) return { output: "Error: missing 'pattern', 'patterns', or 'query' parameter", isError: true };

  const cwd = getString(input, "path") ?? process.cwd();
  const noIgnore = getBoolean(input, "no_ignore") ?? false;
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

    if (noIgnore) {
      // Raw filesystem scan — no filtering at all.
      const matches = new Set<string>();
      for (const glob of globs) {
        for await (const entry of glob.scan({ cwd, onlyFiles: true, followSymlinks: true })) {
          if (!anyGlobMatch(entry, excludeGlobs)) matches.add(entry);
        }
      }
      matched = [...matches];
    } else {
      const gitFiles = await getGitFiles(cwd, signal);
      if (gitFiles) {
        // Fast path: filter the git-known file list with the glob patterns.
        matched = gitFiles.filter(f => anyGlobMatch(f, globs) && !anyGlobMatch(f, excludeGlobs));
      } else {
        // Fallback: full scan, skipping common junk directories.
        const matches = new Set<string>();
        for (const glob of globs) {
          for await (const entry of glob.scan({ cwd, onlyFiles: true, followSymlinks: true })) {
            const skip = EXCLUDED_DIRS.some(d => entry === d || entry.startsWith(d + "/"));
            if (!skip && !anyGlobMatch(entry, excludeGlobs)) matches.add(entry);
          }
        }
        matched = [...matches];
      }
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
      return { output: query ? "No files matched the pattern/query." : "No files matched the pattern.", isError: false };
    }

    const content = entries.map(e => metadata ? formatMetadataEntry(e) : e.path).join("\n");
    return { output: cap(content), isError: false };
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
      no_ignore: { type: "boolean", description: "Bypass .gitignore filtering and scan all files (default false)." },
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
