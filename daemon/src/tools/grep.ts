/**
 * Grep tool — search file contents using ripgrep.
 *
 * Wraps rg with support for regex patterns, glob filters,
 * file type filters, context lines, and three output modes.
 */

import type { Tool, ToolResult, ToolSummary } from "./types";
import { cap, getString, getNumber, getBoolean, summarizeParams } from "./util";
import { log } from "../log";

// ── Constants ──────────────────────────────────────────────────────

const EXCLUDED_DIRS = [".git", ".svn", ".hg", ".bzr"];

// ── Execution ──────────────────────────────────────────────────────

async function executeGrep(input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
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

  const args: string[] = ["--hidden"];

  // Exclude VCS directories
  for (const dir of EXCLUDED_DIRS) args.push("--glob", `!${dir}`);

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

  // Pattern (use -e if it starts with a dash)
  if (pattern.startsWith("-")) args.push("-e", pattern);
  else args.push(pattern);

  // File type filter
  if (fileType) args.push("--type", fileType);

  // Glob filter — handle comma-separated and brace patterns
  if (globPattern) {
    const parts: string[] = [];
    const tokens = globPattern.split(/\s+/);
    for (const tok of tokens) {
      if (tok.includes("{") && tok.includes("}")) parts.push(tok);
      else parts.push(...tok.split(",").filter(Boolean));
    }
    for (const p of parts.filter(Boolean)) args.push("--glob", p);
  }

  args.push(searchPath);

  try {
    const proc = Bun.spawn(["rg", ...args], {
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

    // rg exits 1 for no matches — not an error
    if (exitCode > 1) {
      return { output: `rg error (exit ${exitCode}): ${stderr.trim()}`, isError: true };
    }

    let lines = stdout.trimEnd().split("\n").filter(l => l !== "");

    if (lines.length === 0) {
      return { output: "No matches found.", isError: false };
    }

    // Apply head_limit
    if (headLimit !== undefined && headLimit > 0 && lines.length > headLimit) {
      lines = lines.slice(0, headLimit);
    }

    return { output: cap(lines.join("\n")), isError: false };
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
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for" },
      path: { type: "string", description: "File or directory to search in. Defaults to working directory." },
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
