/**
 * Edit tool — exact targeted text replacement in files.
 *
 * Edits one file with one or more unique, non-overlapping text replacements.
 * Each oldText is matched against the original file contents, not against the
 * incrementally edited result. Line ending differences may be matched without
 * rewriting any bytes outside the selected spans; Unicode is never normalized.
 */

import { constants } from "fs";
import { access, readFile, writeFile } from "fs/promises";
import { isAbsolute, resolve } from "path";
import type { Tool, ToolResult, ToolSummary, ToolExecutionContext } from "./types";
import { cap, getString, summarizeParams } from "./util";
import { log } from "../log";

const CONTEXT_LINES = 4;
const MAX_SNIPPET_LINES = 120;

interface EditReplacement {
  oldText: string;
  newText: string;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

interface AppliedEditsResult {
  baseContent: string;
  newContent: string;
  matches: MatchedEdit[];
}

type PreparedEditInput = {
  path: string;
  edits: EditReplacement[];
};

const fileMutationQueues = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBom(text: string): { bom: string; text: string } {
  return text.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: text.slice(1) }
    : { bom: "", text };
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
    );
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
  );
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  );
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) return new Error(`oldText must not be empty in ${path}.`);
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

function parseEditArray(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function normalizeEditValue(value: unknown): EditReplacement | null {
  if (!isRecord(value)) return null;
  return typeof value.oldText === "string" && typeof value.newText === "string"
    ? { oldText: value.oldText, newText: value.newText }
    : null;
}

function prepareEditArguments(input: Record<string, unknown>): PreparedEditInput {
  const path = getString(input, "path");
  if (!path) throw new Error("Edit tool input is invalid. path must be a non-empty string.");

  const rawEdits = parseEditArray(input.edits);
  const edits: EditReplacement[] = [];
  if (Array.isArray(rawEdits)) {
    for (let i = 0; i < rawEdits.length; i++) {
      const edit = normalizeEditValue(rawEdits[i]);
      if (edit == null) {
        throw new Error(`Edit tool input is invalid. edits[${i}] must have string oldText and newText.`);
      }
      edits.push(edit);
    }
  } else if (rawEdits != null) {
    throw new Error("Edit tool input is invalid. edits must be an array of replacements.");
  }

  // Pi-compatible legacy shape used by a few models: { path, oldText, newText }.
  if (typeof input.oldText === "string" && typeof input.newText === "string") {
    edits.push({ oldText: input.oldText, newText: input.newText });
  }

  if (edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }

  return { path, edits };
}

function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: EditReplacement[],
  path: string,
): AppliedEditsResult {
  const normalizedEdits = edits.map(edit => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw getEmptyOldTextError(path, i, normalizedEdits.length);
    }
  }

  // The public contract is exact replacement. Never normalize the entire file
  // as a fuzzy-match fallback: that silently rewrites unrelated source text.
  const baseContent = normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const matchIndex = baseContent.indexOf(edit.oldText);
    if (matchIndex < 0) throw getNotFoundError(path, i, normalizedEdits.length);

    let occurrences = 0;
    for (let at = matchIndex; at >= 0; at = baseContent.indexOf(edit.oldText, at + 1)) occurrences++;
    if (occurrences > 1) throw getDuplicateError(path, i, normalizedEdits.length, occurrences);

    matchedEdits.push({
      editIndex: i,
      matchIndex,
      matchLength: edit.oldText.length,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  let newContent = baseContent;
  for (let i = matchedEdits.length - 1; i >= 0; i--) {
    const edit = matchedEdits[i];
    newContent =
      newContent.substring(0, edit.matchIndex) +
      edit.newText +
      newContent.substring(edit.matchIndex + edit.matchLength);
  }

  if (baseContent === newContent) throw getNoChangeError(path, normalizedEdits.length);
  return { baseContent, newContent, matches: matchedEdits };
}

function resolveEditPath(path: string, cwd: string): string {
  if (path.includes("\0")) throw new Error("path must not contain a NUL byte.");
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function withFileMutationQueue<T>(absolutePath: string, run: () => Promise<T>): Promise<T> {
  const previous = fileMutationQueues.get(absolutePath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(resolveNext => {
    release = resolveNext;
  });
  const queued = previous.catch(() => {}).then(() => next);
  fileMutationQueues.set(absolutePath, queued);

  await previous.catch(() => {});
  try {
    return await run();
  } finally {
    release();
    if (fileMutationQueues.get(absolutePath) === queued) {
      fileMutationQueues.delete(absolutePath);
    }
  }
}

function findFirstChangedLine(oldLines: string[], newLines: string[]): number | undefined {
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
    if (oldLines[i] !== newLines[i]) return i;
  }
  return undefined;
}

function findLastChangedLine(oldLines: string[], newLines: string[]): number {
  const oldLen = oldLines.length;
  const newLen = newLines.length;
  for (let i = 0; i < Math.max(oldLen, newLen); i++) {
    if (oldLines[oldLen - 1 - i] !== newLines[newLen - 1 - i]) {
      return Math.max(0, newLen - 1 - i);
    }
  }
  return 0;
}

function formatChangedExcerpt(baseContent: string, newContent: string): string {
  const oldLines = baseContent.split("\n");
  const newLines = newContent.split("\n");
  const firstChanged = findFirstChangedLine(oldLines, newLines);
  if (firstChanged == null) return "";
  const lastChanged = findLastChangedLine(oldLines, newLines);
  const snippetStart = Math.max(0, firstChanged - CONTEXT_LINES);
  const desiredEnd = Math.min(newLines.length, lastChanged + CONTEXT_LINES + 1);
  const snippetEnd = Math.min(desiredEnd, snippetStart + MAX_SNIPPET_LINES);
  const maxNumWidth = String(snippetEnd).length;
  const formatted = newLines.slice(snippetStart, snippetEnd).map((line, i) => {
    const lineNum = String(snippetStart + i + 1).padStart(maxNumWidth);
    return `${lineNum}\t${line}`;
  });

  const omitted = desiredEnd > snippetEnd ? `\n... (${desiredEnd - snippetEnd} more changed-context lines omitted)` : "";
  return `Changed excerpt:\n${formatted.join("\n")}${omitted}`;
}

async function executeEdit(
  input: Record<string, unknown>,
  context?: ToolExecutionContext,
  signal?: AbortSignal,
): Promise<ToolResult> {
  let prepared: PreparedEditInput;
  let absolutePath = "";
  try {
    prepared = prepareEditArguments(input);
    absolutePath = resolveEditPath(prepared.path, context?.cwd ?? process.cwd());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Error: ${msg}`, isError: true };
  }

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new Error("Operation aborted");
  };

  try {
    return await withFileMutationQueue(absolutePath, async () => {
      throwIfAborted();
      try {
        await access(absolutePath, constants.R_OK | constants.W_OK);
      } catch (error: unknown) {
        throwIfAborted();
        const code = error instanceof Error && "code" in error ? ` Error code: ${String(error.code)}.` : "";
        throw new Error(`Could not edit file: ${prepared.path}.${code}`);
      }
      throwIfAborted();

      const buffer = await readFile(absolutePath);
      const rawContent = buffer.toString("utf-8");
      throwIfAborted();

      const { bom, text: content } = stripBom(rawContent);
      const originalEnding = detectLineEnding(content);
      const normalizedContent = normalizeToLF(content);
      const { matches } = applyEditsToNormalizedContent(
        normalizedContent,
        prepared.edits,
        prepared.path,
      );
      throwIfAborted();

      // Map normalized LF positions back to the original byte-preserving JS
      // string positions, including mixed CRLF/LF and lone CR terminators.
      const sourcePositions: number[] = [];
      for (let at = 0; at < content.length; at++) {
        sourcePositions.push(at);
        if (content[at] === "\r" && content[at + 1] === "\n") at++;
      }
      sourcePositions.push(content.length);
      let newContent = content;
      for (const match of [...matches].reverse()) {
        const start = sourcePositions[match.matchIndex];
        const end = sourcePositions[match.matchIndex + match.matchLength];
        const removed = content.slice(start, end);
        const ending = removed.includes("\n") ? detectLineEnding(removed) : originalEnding;
        newContent = newContent.slice(0, start) + restoreLineEndings(match.newText, ending) + newContent.slice(end);
      }
      const finalContent = bom + newContent;
      await writeFile(absolutePath, finalContent, "utf-8");
      throwIfAborted();

      const excerpt = formatChangedExcerpt(content, newContent);
      const output = `Successfully replaced ${prepared.edits.length} block(s) in ${prepared.path}.${excerpt ? `\n${excerpt}` : ""}`;
      return { output: cap(output), isError: false };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `editFile: ${absolutePath || "<unknown>"}: ${msg}`);
    return { output: `Error editing ${prepared.path}: ${msg}`, isError: true };
  }
}

function summarize(input: Record<string, unknown>): ToolSummary {
  const path = getString(input, "path") ?? "";
  return { label: "Edit", detail: summarizeParams(path, input, ["path", "edits", "oldText", "newText"]) };
}

export const edit: Tool = {
  name: "edit",
  description:
    "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
  parallelSafety: "exclusive",
  defaultTimeoutMs: 30_000,
  settleOnAbort: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
      edits: {
        type: "array",
        description:
          "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            oldText: {
              type: "string",
              description:
                "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
            },
            newText: { type: "string", description: "Replacement text for this targeted edit." },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
    additionalProperties: false,
  },
  systemHint:
    "Prefer the edit tool over sed/awk for modifying existing files. Use one edit call with multiple edits[] entries for separate changes in the same file; each oldText must be unique and matched against the original file.",
  display: {
    label: "Edit",
    color: "#f0ab78",
  },
  summarize,
  execute: executeEdit,
};

export const editInternalsForTest = {
  applyEditsToNormalizedContent,
  prepareEditArguments,
};
