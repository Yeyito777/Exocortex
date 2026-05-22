/**
 * Grep tool — search file contents using ripgrep.
 *
 * Wraps rg with support for regex patterns, glob filters,
 * file type filters, context lines, and three output modes.
 */

import { constants as fsConstants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Tool, ToolResult, ToolSummary, ToolExecutionContext } from "./types";
import { cap, getString, getNumber, getBoolean, summarizeParams } from "./util";
import { log } from "../log";

// ── Constants ──────────────────────────────────────────────────────

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

const GLOB_META_RE = /[*?\[\]{}]/;

// ── Helpers ────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function existingSplitPathParts(path: string): Promise<string[]> {
  const tokens = path.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return [];
  const existing: string[] = [];
  for (const token of tokens) {
    const candidate = resolve(token);
    if (await pathExists(candidate)) existing.push(candidate);
  }
  return existing.length >= 2 ? existing : [];
}

function globPathHint(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash) || "/" : ".";
  const pattern = slash >= 0 ? path.slice(slash + 1) : path;
  return `Error: grep.path is a literal file/directory path and does not expand glob syntax.\nMove the file pattern to the glob parameter, for example:\n  path: ${JSON.stringify(dir)}\n  glob: ${JSON.stringify(pattern)}`;
}

async function runSudoTest(path: string, signal?: AbortSignal): Promise<{ ok: boolean; stderr: string; code: number }> {
  const proc = Bun.spawn(["sudo", "-n", "test", "-e", path], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TERM: "dumb" },
  });
  if (signal) {
    const onAbort = () => proc.kill();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, stderr: stderr.trim(), code };
}

async function validateSearchPath(searchPath: string, sudo: boolean, signal?: AbortSignal): Promise<ToolResult | null> {
  try {
    await lstat(searchPath);
    if (!sudo) await access(searchPath, fsConstants.R_OK);
    return null;
  } catch (err) {
    const code = errorCode(err);

    if (sudo && code !== "ENOENT") {
      const sudoCheck = await runSudoTest(searchPath, signal);
      if (sudoCheck.ok) return null;
      if (sudoCheck.stderr) {
        return { output: `sudo path validation failed: ${sudoCheck.stderr}`, isError: true };
      }
    }

    if (code === "ENOENT") {
      const splitPaths = await existingSplitPathParts(searchPath);
      if (splitPaths.length >= 2) {
        return {
          output: `Error: grep.path looks like multiple paths joined into one string.\npath is a single literal file/directory. Use a common directory with glob, or call grep separately.\nDetected existing paths:\n${splitPaths.map(p => `- ${p}`).join("\n")}`,
          isError: true,
        };
      }
      if (GLOB_META_RE.test(searchPath)) return { output: globPathHint(searchPath), isError: true };
      return { output: `Error: grep path does not exist: ${searchPath}`, isError: true };
    }

    return { output: `Error: cannot read grep path ${searchPath}: ${errorMessage(err)}`, isError: true };
  }
}

interface GrepTraversalWarning {
  path: string;
  reason: string;
}

interface ClassifiedStderr {
  traversalWarnings: GrepTraversalWarning[];
  otherLines: string[];
}

function parseRipgrepLine(line: string): { path: string; reason: string } | null {
  const loopMatch = /^rg: File system loop found: (.*)$/.exec(line);
  if (loopMatch) {
    const path = loopMatch[1].replace(/ points to an ancestor .*$/, "");
    return { path, reason: `File system loop found: ${loopMatch[1]}` };
  }
  const match = /^rg: (.*): (.*)$/.exec(line);
  if (!match) return null;
  return { path: match[1], reason: match[2] };
}

function isTraversalWarning(reason: string): boolean {
  return /Permission denied|os error 13|Too many levels of symbolic links|os error 40|File system loop|No such file or directory|os error 2|Input\/output error|os error 5/i.test(reason);
}

function classifyRipgrepStderr(stderr: string): ClassifiedStderr {
  const traversalWarnings: GrepTraversalWarning[] = [];
  const otherLines: string[] = [];
  for (const line of stderr.split("\n").map(l => l.trim()).filter(Boolean)) {
    const parsed = parseRipgrepLine(line);
    if (parsed && isTraversalWarning(parsed.reason)) traversalWarnings.push(parsed);
    else otherLines.push(line);
  }
  return { traversalWarnings, otherLines };
}

function appendTraversalWarnings(output: string, warnings: GrepTraversalWarning[]): string {
  if (warnings.length === 0) return output;
  const first = warnings.slice(0, 5).map(w => `- ${w.path}: ${w.reason}`).join("\n");
  const more = warnings.length > 5 ? `\n- ... ${warnings.length - 5} more` : "";
  return `${output}\n\n[grep skipped ${warnings.length} inaccessible/looping path${warnings.length === 1 ? "" : "s"}:\n${first}${more}\n]`;
}

function addDefaultExcludeGlobs(args: string[]): void {
  for (const dir of EXCLUDED_DIRS) {
    args.push("--glob", `!${dir}/**`);
    args.push("--glob", `!**/${dir}/**`);
  }
}

function globParts(globPattern: string): string[] {
  const parts: string[] = [];
  const tokens = globPattern.split(/\s+/);
  for (const tok of tokens) {
    if (tok.includes("{") && tok.includes("}")) parts.push(tok);
    else parts.push(...tok.split(",").filter(Boolean));
  }
  return parts.filter(Boolean);
}

// ── Execution ──────────────────────────────────────────────────────

async function executeGrep(input: Record<string, unknown>, _context?: ToolExecutionContext, signal?: AbortSignal): Promise<ToolResult> {
  const pattern = getString(input, "pattern");
  if (!pattern) return { output: "Error: missing 'pattern' parameter", isError: true };

  const searchPath = getString(input, "path") ?? process.cwd();
  const globPattern = getString(input, "glob");
  const fileType = getString(input, "type");
  const mode = getString(input, "output_mode") ?? "files_with_matches";
  const beforeCtx = getNumber(input, "before_context") ?? getNumber(input, "-B");
  const afterCtx = getNumber(input, "after_context") ?? getNumber(input, "-A");
  const aroundCtx = getNumber(input, "context") ?? getNumber(input, "-C");
  const lineNumbers = getBoolean(input, "line_numbers") ?? getBoolean(input, "-n") ?? true;
  const caseInsensitive = getBoolean(input, "ignore_case") ?? getBoolean(input, "-i") ?? false;
  const multiline = getBoolean(input, "multiline") ?? false;
  const headLimit = getNumber(input, "head_limit");
  const followSymlinks = getBoolean(input, "follow_symlinks") ?? false;
  const sudo = getBoolean(input, "sudo") ?? false;
  const noIgnore = getBoolean(input, "no_ignore") ?? false;

  const pathError = await validateSearchPath(searchPath, sudo, signal);
  if (pathError) return pathError;

  const args: string[] = ["--hidden"];
  if (noIgnore) args.push("--no-ignore");
  if (followSymlinks) args.push("--follow");

  addDefaultExcludeGlobs(args);
  args.push("--max-columns", "500");

  if (multiline) args.push("-U", "--multiline-dotall");
  if (caseInsensitive) args.push("-i");

  if (mode === "files_with_matches") args.push("-l");
  else if (mode === "count") args.push("-c");

  if (lineNumbers && mode === "content") args.push("-n");

  // Context flags (content mode only)
  if (mode === "content") {
    if (aroundCtx !== undefined) args.push("-C", aroundCtx.toString());
    else {
      if (beforeCtx !== undefined) args.push("-B", beforeCtx.toString());
      if (afterCtx !== undefined) args.push("-A", afterCtx.toString());
    }
  }

  // File type filter
  if (fileType) args.push("--type", fileType);

  // Glob filter — handle comma-separated and brace patterns
  if (globPattern) {
    for (const p of globParts(globPattern)) args.push("--glob", p);
  }

  // Pattern (use -e if it starts with a dash)
  if (pattern.startsWith("-")) args.push("-e", pattern);
  else args.push(pattern);

  args.push(searchPath);

  try {
    const command = sudo ? ["sudo", "-n", "rg", ...args] : ["rg", ...args];
    const proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TERM: "dumb" },
    });

    // Kill rg on abort
    if (signal) {
      const onAbort = () => proc.kill();
      if (signal.aborted) { onAbort(); }
      else { signal.addEventListener("abort", onAbort, { once: true }); }
    }

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    const classified = classifyRipgrepStderr(stderr);

    // rg exits 1 for no matches — not an error when stderr is clean or only
    // contains descendant traversal warnings. Non-traversal stderr on any
    // nonzero exit (including sudo -n failures that often exit 1) is a real
    // tool error. rg can exit 2 for traversal errors even when the explicit root
    // is valid; downgrade those descendant failures to warnings.
    if (exitCode !== 0 && classified.otherLines.length > 0) {
      return { output: `${sudo ? "sudo/" : ""}rg error (exit ${exitCode}): ${stderr.trim()}`, isError: true };
    }

    let lines = stdout.trimEnd().split("\n").filter(l => l !== "");

    // Apply head_limit
    if (headLimit !== undefined && headLimit > 0 && lines.length > headLimit) {
      lines = lines.slice(0, headLimit);
    }

    const baseOutput = lines.length === 0 ? "No matches found." : cap(lines.join("\n"));
    return { output: appendTraversalWarnings(baseOutput, classified.traversalWarnings), isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `grepFiles: ${msg}`);
    return { output: `Error running grep: ${msg}`, isError: true };
  }
}

// ── Summary ────────────────────────────────────────────────────────

function summarize(input: Record<string, unknown>): ToolSummary {
  const pattern = getString(input, "pattern") ?? "";
  return { label: "Grep", detail: summarizeParams(`/${pattern}/`, input, ["pattern"]) };
}

// ── Tool definition ────────────────────────────────────────────────

export const grep: Tool = {
  name: "grep",
  description: "Search file contents using ripgrep. Supports regex patterns, glob filters, file type filters, context lines, and three output modes.",
  parallelSafety: "safe",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "Literal file or directory to search in. Defaults to working directory. Use glob for file patterns; path itself is not glob-expanded." },
      glob: { type: "string", description: "Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\")" },
      type: { type: "string", description: "File type filter (e.g. \"js\", \"py\", \"rust\")" },
      output_mode: {
        type: "string",
        enum: ["content", "files_with_matches", "count"],
        description: "\"content\" shows matching lines, \"files_with_matches\" shows file paths (default), \"count\" shows match counts.",
      },
      before_context: { type: "number", description: "Lines to show before each match (content mode only)" },
      after_context: { type: "number", description: "Lines to show after each match (content mode only)" },
      context: { type: "number", description: "Lines of context around each match (content mode only)" },
      line_numbers: { type: "boolean", description: "Show line numbers (content mode only, default true)" },
      ignore_case: { type: "boolean", description: "Case insensitive search" },
      multiline: { type: "boolean", description: "Enable multiline mode where . matches newlines (default false)" },
      no_ignore: { type: "boolean", description: "Bypass ripgrep ignore files such as .gitignore (default false). Does not change symlink behavior." },
      follow_symlinks: { type: "boolean", description: "Follow symlinks while searching (default false). Leave false to avoid recursive loops." },
      sudo: { type: "boolean", description: "Use non-interactive sudo (-n) for searching when elevated traversal is required (default false)." },
      head_limit: { type: "number", description: "Limit output to first N lines/entries" },
    },
    required: ["pattern"],
  },
  systemHint: "Prefer the grep tool over grep/rg for searching file contents.",
  display: {
    label: "Grep",
    color: "#89ddff",  // cyan
  },
  summarize,
  execute: executeGrep,
};
