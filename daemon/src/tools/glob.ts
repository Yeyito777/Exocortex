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
 * Returns matching file paths sorted by modification time (most recent first).
 */

import type { Tool, ToolResult, ToolSummary } from "./types";
import { cap, getString, getBoolean, summarizeParams } from "./util";
import { log } from "../log";

// ── Constants ─────────────────────────────────────────────────────

/** Directories to skip in the non-git fallback path (mirrors grep tool). */
const EXCLUDED_DIRS = [".git", ".svn", ".hg", ".bzr", "node_modules"];

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

// ── Execution ─────────────────────────────────────────────────────

async function executeGlob(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
  const pattern = getString(input, "pattern");
  if (!pattern) return { output: "Error: missing 'pattern' parameter", isError: true };

  const cwd = getString(input, "path") ?? process.cwd();
  const noIgnore = getBoolean(input, "no_ignore") ?? false;

  try {
    const glob = new Bun.Glob(pattern);

    // --- Collect candidate paths --------------------------------

    let matched: string[];

    if (noIgnore) {
      // Raw filesystem scan — no filtering at all.
      matched = [];
      for await (const entry of glob.scan({ cwd, onlyFiles: true, followSymlinks: true })) {
        matched.push(entry);
      }
    } else {
      const gitFiles = await getGitFiles(cwd, signal);
      if (gitFiles) {
        // Fast path: filter the git-known file list with the glob pattern.
        matched = gitFiles.filter(f => glob.match(f));
      } else {
        // Fallback: full scan, skipping common junk directories.
        matched = [];
        for await (const entry of glob.scan({ cwd, onlyFiles: true, followSymlinks: true })) {
          const skip = EXCLUDED_DIRS.some(d => entry === d || entry.startsWith(d + "/"));
          if (!skip) matched.push(entry);
        }
      }
    }

    // --- Stat & sort by mtime -----------------------------------

    const entries: { path: string; mtimeMs: number }[] = [];

    for (const rel of matched) {
      try {
        const stat = await Bun.file(cwd + "/" + rel).stat();
        entries.push({ path: rel, mtimeMs: stat?.mtimeMs ?? 0 });
      } catch {
        entries.push({ path: rel, mtimeMs: 0 });
      }
    }

    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (entries.length === 0) {
      return { output: "No files matched the pattern.", isError: false };
    }

    const content = entries.map(e => e.path).join("\n");
    return { output: cap(content), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `globFiles: ${pattern}: ${msg}`);
    return { output: `Error globbing "${pattern}": ${msg}`, isError: true };
  }
}

// ── Summary ───────────────────────────────────────────────────────

function summarize(input: Record<string, unknown>): ToolSummary {
  const pattern = getString(input, "pattern") ?? "";
  return { label: "Glob", detail: summarizeParams(pattern, input, ["pattern"]) };
}

// ── Tool definition ───────────────────────────────────────────────

export const glob: Tool = {
  name: "glob",
  description: "Fast file pattern matching. Supports glob patterns like \"**/*.ts\" or \"src/**/*.tsx\". Returns matching file paths sorted by modification time (most recent first).",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The glob pattern to match files against" },
      path: { type: "string", description: "Directory to search in. Defaults to working directory." },
      no_ignore: { type: "boolean", description: "Bypass .gitignore filtering and scan all files (default false)." },
    },
    required: ["pattern"],
  },
  systemHint: "Prefer the glob tool over find/ls for finding files by name pattern.",
  display: {
    label: "Glob",
    color: "#ffcb6b",  // warm yellow
  },
  summarize,
  execute: executeGlob,
};
