/**
 * Edit tool — exact string replacement in files.
 *
 * Replaces the first occurrence of old_string with new_string.
 * Safety: rejects if multiple matches found (unless replace_all).
 * Returns a snippet of the changed area with line numbers.
 */

import type { Tool, ToolResult, ToolSummary } from "./types";
import { getString, getBoolean, summarizeParams } from "./util";
import { isWindows } from "@exocortex/shared/paths";
import { log } from "../log";

// ── Constants ──────────────────────────────────────────────────────

const CONTEXT_LINES = 4;

// ── Execution ──────────────────────────────────────────────────────

async function executeEdit(input: Record<string, unknown>): Promise<ToolResult> {
  const filePath = getString(input, "file_path");
  const oldString = getString(input, "old_string");
  const newString = getString(input, "new_string");
  const replaceAll = getBoolean(input, "replace_all") ?? false;

  if (!filePath) return { output: "Error: missing 'file_path' parameter", isError: true };
  if (oldString == null) return { output: "Error: missing 'old_string' parameter", isError: true };
  if (newString == null) return { output: "Error: missing 'new_string' parameter", isError: true };
  const isAbsolute = isWindows ? /^[A-Za-z]:[\\\/]/.test(filePath) : filePath.startsWith("/");
  if (!isAbsolute) {
    return { output: `Error: file_path must be absolute, got: ${filePath}`, isError: true };
  }
  if (oldString === newString) {
    return { output: "Error: old_string and new_string are identical, no edit needed.", isError: true };
  }

  try {
    const file = Bun.file(filePath);
    if (!await file.exists()) {
      return { output: `Error: file not found: ${filePath}`, isError: true };
    }

    const original = await file.text();

    // Check how many matches exist
    const matches = original.split(oldString).length - 1;
    if (matches === 0) {
      return { output: `Error: old_string not found in ${filePath}. Make sure the string matches exactly, including whitespace and indentation.`, isError: true };
    }
    if (matches > 1 && !replaceAll) {
      return { output: `Error: found ${matches} matches of old_string in ${filePath}. For safety, only one occurrence is allowed at a time. Add more surrounding context to make the match unique, or set replace_all to true.`, isError: true };
    }

    let updated: string;
    if (replaceAll) {
      updated = original.replaceAll(oldString, newString);
    } else {
      // When deleting (newString is empty), consume trailing newline if applicable
      if (newString === "" && !oldString.endsWith("\n") && original.includes(oldString + "\n")) {
        updated = original.replace(oldString + "\n", () => newString);
      } else {
        updated = original.replace(oldString, () => newString);
      }
    }

    if (updated === original) {
      return { output: "Error: edit produced no changes.", isError: true };
    }

    await Bun.write(filePath, updated);

    // Build a snippet showing the changed area with context
    const updatedLines = updated.split("\n");
    const originalLines = original.split("\n");

    // Find the first line that differs
    let firstChanged = 0;
    for (let i = 0; i < Math.max(originalLines.length, updatedLines.length); i++) {
      if (originalLines[i] !== updatedLines[i]) {
        firstChanged = i;
        break;
      }
    }

    // Find the last line that differs (scan from end)
    let lastChanged = updatedLines.length - 1;
    const origLen = originalLines.length;
    const updLen = updatedLines.length;
    for (let i = 0; i < Math.max(origLen, updLen); i++) {
      if (originalLines[origLen - 1 - i] !== updatedLines[updLen - 1 - i]) {
        lastChanged = updLen - 1 - i;
        break;
      }
    }

    const snippetStart = Math.max(0, firstChanged - CONTEXT_LINES);
    const snippetEnd = Math.min(updatedLines.length, lastChanged + CONTEXT_LINES + 1);
    const snippet = updatedLines.slice(snippetStart, snippetEnd);
    const maxNumWidth = String(snippetEnd).length;
    const formatted = snippet.map((line, i) => {
      const lineNum = String(snippetStart + i + 1).padStart(maxNumWidth);
      return `${lineNum}\t${line}`;
    });

    const replacements = replaceAll ? ` (${matches} replacements)` : "";
    const content = `Edited ${filePath}${replacements}\n${formatted.join("\n")}`;
    return { output: content, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `editFile: ${filePath}: ${msg}`);
    return { output: `Error editing ${filePath}: ${msg}`, isError: true };
  }
}

// ── Summary ────────────────────────────────────────────────────────

function summarize(input: Record<string, unknown>): ToolSummary {
  const filePath = getString(input, "file_path") ?? "";
  return { label: "Edit", detail: summarizeParams(filePath, input, ["file_path", "old_string", "new_string"]) };
}

// ── Tool definition ────────────────────────────────────────────────

export const edit: Tool = {
  name: "edit",
  description: "Performs exact string replacement in a file. Replaces the first occurrence of old_string with new_string. The old_string must match exactly (including whitespace/indentation). If old_string appears more than once, add more surrounding context to make it unique, or set replace_all to true.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to edit" },
      old_string: { type: "string", description: "The exact text to find and replace" },
      new_string: { type: "string", description: "The replacement text" },
      replace_all: { type: "boolean", description: "Replace all occurrences instead of just the first (default false)" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  systemHint: "Prefer the edit tool over sed/awk for modifying existing files.",
  display: {
    label: "Edit",
    color: "#f0ab78",  // warm orange
  },
  summarize,
  execute: executeEdit,
};
