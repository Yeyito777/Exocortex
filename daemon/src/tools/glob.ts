/**
 * Glob tool — fast file pattern matching.
 *
 * Uses Bun.Glob for async iteration. Returns matching file paths
 * sorted by modification time (most recent first).
 */

import type { Tool, ToolResult, ToolSummary } from "./types";
import { log } from "../log";

// ── Constants ──────────────────────────────────────────────────────

const MAX_OUTPUT_CHARS = 30_000;

function cap(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) +
    `\n... output truncated (showed ${MAX_OUTPUT_CHARS} of ${text.length} characters)`;
}

// ── Execution ──────────────────────────────────────────────────────

async function executeGlob(input: Record<string, unknown>): Promise<ToolResult> {
  const pattern = input.pattern as string;
  if (!pattern) return { output: "Error: missing 'pattern' parameter", isError: true };

  const cwd = (input.path as string) ?? process.cwd();

  try {
    const glob = new Bun.Glob(pattern);
    const entries: { path: string; mtimeMs: number }[] = [];

    for await (const entry of glob.scan({ cwd, onlyFiles: true, followSymlinks: true })) {
      try {
        const full = cwd + "/" + entry;
        const stat = await Bun.file(full).stat();
        entries.push({ path: entry, mtimeMs: stat?.mtimeMs ?? 0 });
      } catch {
        entries.push({ path: entry, mtimeMs: 0 });
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

// ── Summary ────────────────────────────────────────────────────────

function summarize(input: Record<string, unknown>): ToolSummary {
  const pattern = (input.pattern as string) ?? "";
  return { label: "Glob", detail: pattern };
}

// ── Tool definition ────────────────────────────────────────────────

export const glob: Tool = {
  name: "glob",
  description: "Fast file pattern matching. Supports glob patterns like \"**/*.ts\" or \"src/**/*.tsx\". Returns matching file paths sorted by modification time (most recent first).",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The glob pattern to match files against" },
      path: { type: "string", description: "Directory to search in. Defaults to working directory." },
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
