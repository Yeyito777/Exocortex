/**
 * Write tool — write content to a file.
 *
 * Creates the file if it doesn't exist, overwrites if it does.
 * Parent directories are created automatically.
 * Requires absolute paths.
 */

import { dirname } from "path";
import type { Tool, ToolResult, ToolSummary } from "./types";
import { getString, summarizeParams } from "./util";
import { isWindows } from "@exocortex/shared/paths";
import { log } from "../log";

// ── Execution ──────────────────────────────────────────────────────

async function executeWrite(input: Record<string, unknown>): Promise<ToolResult> {
  const filePath = getString(input, "file_path");
  const content = getString(input, "content");

  if (!filePath) return { output: "Error: missing 'file_path' parameter", isError: true };
  if (content == null) return { output: "Error: missing 'content' parameter", isError: true };
  const isAbsolute = isWindows ? /^[A-Za-z]:[\\\/]/.test(filePath) : filePath.startsWith("/");
  if (!isAbsolute) {
    return { output: `Error: file_path must be absolute, got: ${filePath}`, isError: true };
  }

  try {
    const file = Bun.file(filePath);
    const existed = await file.exists();

    // Create parent directories if needed
    const dir = dirname(filePath);
    if (dir && dir !== filePath) {
      const { mkdirSync } = await import("fs");
      try { mkdirSync(dir, { recursive: true }); } catch { /* directory may already exist */ }
    }

    await Bun.write(filePath, content);

    const lines = content.split("\n").length;
    const bytes = Buffer.byteLength(content, "utf-8");
    const action = existed ? "Updated" : "Created";
    return { output: `${action} ${filePath} (${lines} lines, ${bytes} bytes)`, isError: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `writeFile: ${filePath}: ${msg}`);
    return { output: `Error writing ${filePath}: ${msg}`, isError: true };
  }
}

// ── Summary ────────────────────────────────────────────────────────

function summarize(input: Record<string, unknown>): ToolSummary {
  const filePath = getString(input, "file_path") ?? "";
  return { label: "Write", detail: summarizeParams(filePath, input, ["file_path", "content"]) };
}

// ── Tool definition ────────────────────────────────────────────────

export const write: Tool = {
  name: "write",
  description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Parent directories are created automatically.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to write" },
      content: { type: "string", description: "The content to write to the file" },
    },
    required: ["file_path", "content"],
  },
  display: {
    label: "Write",
    color: "#c792ea",  // soft purple
  },
  summarize,
  execute: executeWrite,
};
