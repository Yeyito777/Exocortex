/**
 * Patch tool — Codex-style apply_patch implementation.
 *
 * Applies a stripped-down, file-oriented patch format:
 *
 * *** Begin Patch
 * *** Add File: path
 * +contents
 * *** Update File: path
 * @@ optional context
 * -old
 * +new
 * *** Delete File: path
 * *** End Patch
 */

import { dirname, isAbsolute, resolve } from "path";
import { mkdir, rm, stat, writeFile } from "fs/promises";
import type { Tool, ToolExecutionContext, ToolResult, ToolSummary } from "./types";
import { getString, summarizeParams } from "./util";
import { isWindows } from "@exocortex/shared/paths";
import { log } from "../log";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

interface AddFileHunk {
  kind: "add";
  path: string;
  contents: string;
}

interface DeleteFileHunk {
  kind: "delete";
  path: string;
}

interface UpdateChunk {
  changeContext: string | null;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

interface UpdateFileHunk {
  kind: "update";
  path: string;
  movePath: string | null;
  chunks: UpdateChunk[];
}

type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

interface ParsedPatch {
  hunks: Hunk[];
  normalizedInput: string;
}

interface AffectedPaths {
  added: string[];
  modified: string[];
  deleted: string[];
  movedFrom: string[];
  uncertainPath: string | null;
}

class PatchParseError extends Error {
  constructor(message: string, readonly lineNumber?: number) {
    super(lineNumber == null ? message : `line ${lineNumber}: ${message}`);
    this.name = "PatchParseError";
  }
}

class PatchAbortedError extends Error {
  constructor() {
    super("Patch execution stopped");
    this.name = "PatchAbortedError";
  }
}

function throwIfPatchAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PatchAbortedError();
}

function isAbsolutePatchPath(path: string): boolean {
  return isWindows ? /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") : isAbsolute(path);
}

function validatePatchPath(path: string, lineNumber: number): string {
  const trimmed = path.trim();
  if (!trimmed) throw new PatchParseError("patch path must not be empty", lineNumber);
  if (trimmed.includes("\0")) throw new PatchParseError(`patch path contains a NUL byte: ${trimmed}`, lineNumber);
  if (isAbsolutePatchPath(trimmed)) {
    throw new PatchParseError(`patch paths must be relative, got absolute path: ${trimmed}`, lineNumber);
  }
  return trimmed;
}

function splitPatchLines(input: string): string[] {
  return input.trim().split(/\r?\n/);
}

function checkPatchBoundariesStrict(lines: string[]): { patchLines: string[]; bodyLines: string[] } {
  const first = lines[0]?.trim();
  const last = lines[lines.length - 1]?.trim();
  if (first !== BEGIN_PATCH_MARKER) {
    throw new PatchParseError(`The first line of the patch must be '${BEGIN_PATCH_MARKER}'`);
  }
  if (last !== END_PATCH_MARKER) {
    throw new PatchParseError(`The last line of the patch must be '${END_PATCH_MARKER}'`);
  }
  return { patchLines: lines, bodyLines: lines.slice(1, -1) };
}

function checkPatchBoundaries(inputLines: string[]): { patchLines: string[]; bodyLines: string[] } {
  try {
    return checkPatchBoundariesStrict(inputLines);
  } catch (strictError) {
    const first = inputLines[0];
    const last = inputLines[inputLines.length - 1];
    if (
      inputLines.length >= 4 &&
      (first === "<<EOF" || first === "<<'EOF'" || first === "<<\"EOF\"") &&
      last?.endsWith("EOF")
    ) {
      return checkPatchBoundariesStrict(inputLines.slice(1, -1));
    }
    throw strictError;
  }
}

function parsePatch(input: string): ParsedPatch {
  const lines = splitPatchLines(input);
  const { patchLines, bodyLines } = checkPatchBoundaries(lines);
  const hunks: Hunk[] = [];
  let index = 0;
  let lineNumber = 2;

  while (index < bodyLines.length) {
    const [hunk, consumed] = parseOneHunk(bodyLines.slice(index), lineNumber);
    hunks.push(hunk);
    index += consumed;
    lineNumber += consumed;
  }

  return { hunks, normalizedInput: patchLines.join("\n") };
}

function parseOneHunk(lines: string[], lineNumber: number): [Hunk, number] {
  const firstLine = lines[0]?.trim() ?? "";

  if (firstLine.startsWith(ADD_FILE_MARKER)) {
    const path = validatePatchPath(firstLine.slice(ADD_FILE_MARKER.length), lineNumber);
    let contents = "";
    let consumed = 1;
    for (const line of lines.slice(1)) {
      if (!line.startsWith("+")) break;
      contents += `${line.slice(1)}\n`;
      consumed++;
    }
    return [{ kind: "add", path, contents }, consumed];
  }

  if (firstLine.startsWith(DELETE_FILE_MARKER)) {
    const path = validatePatchPath(firstLine.slice(DELETE_FILE_MARKER.length), lineNumber);
    return [{ kind: "delete", path }, 1];
  }

  if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
    const path = validatePatchPath(firstLine.slice(UPDATE_FILE_MARKER.length), lineNumber);
    let remaining = lines.slice(1);
    let consumed = 1;
    let movePath: string | null = null;

    if (remaining[0]?.startsWith(MOVE_TO_MARKER)) {
      movePath = validatePatchPath(remaining[0].slice(MOVE_TO_MARKER.length), lineNumber + consumed);
      remaining = remaining.slice(1);
      consumed++;
    }

    const chunks: UpdateChunk[] = [];
    while (remaining.length > 0) {
      if ((remaining[0] ?? "").trim() === "") {
        remaining = remaining.slice(1);
        consumed++;
        continue;
      }
      if ((remaining[0] ?? "").startsWith("*")) break;

      const [chunk, chunkLines] = parseUpdateFileChunk(
        remaining,
        lineNumber + consumed,
        chunks.length === 0,
      );
      chunks.push(chunk);
      remaining = remaining.slice(chunkLines);
      consumed += chunkLines;
    }

    if (chunks.length === 0) {
      throw new PatchParseError(`Update file hunk for path '${path}' is empty`, lineNumber);
    }

    return [{ kind: "update", path, movePath, chunks }, consumed];
  }

  throw new PatchParseError(
    `'${firstLine}' is not a valid hunk header. Valid hunk headers: '${ADD_FILE_MARKER}{path}', '${DELETE_FILE_MARKER}{path}', '${UPDATE_FILE_MARKER}{path}'`,
    lineNumber,
  );
}

function parseUpdateFileChunk(lines: string[], lineNumber: number, allowMissingContext: boolean): [UpdateChunk, number] {
  if (lines.length === 0) {
    throw new PatchParseError("Update hunk does not contain any lines", lineNumber);
  }

  let changeContext: string | null = null;
  let startIndex = 0;
  const first = lines[0] ?? "";
  if (first === EMPTY_CHANGE_CONTEXT_MARKER) {
    startIndex = 1;
  } else if (first.startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = first.slice(CHANGE_CONTEXT_MARKER.length);
    startIndex = 1;
  } else if (!allowMissingContext) {
    throw new PatchParseError(`Expected update hunk to start with a @@ context marker, got: '${first}'`, lineNumber);
  }

  if (startIndex >= lines.length) {
    throw new PatchParseError("Update hunk does not contain any lines", lineNumber + 1);
  }

  const chunk: UpdateChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
  };

  let parsedLines = 0;
  for (const line of lines.slice(startIndex)) {
    if (line === EOF_MARKER) {
      if (parsedLines === 0) {
        throw new PatchParseError("Update hunk does not contain any lines", lineNumber + 1);
      }
      chunk.isEndOfFile = true;
      parsedLines++;
      break;
    }

    const marker = line[0];
    if (marker == null) {
      chunk.oldLines.push("");
      chunk.newLines.push("");
    } else if (marker === " ") {
      chunk.oldLines.push(line.slice(1));
      chunk.newLines.push(line.slice(1));
    } else if (marker === "+") {
      chunk.newLines.push(line.slice(1));
    } else if (marker === "-") {
      chunk.oldLines.push(line.slice(1));
    } else {
      if (parsedLines === 0) {
        throw new PatchParseError(
          `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
          lineNumber + 1,
        );
      }
      break;
    }
    parsedLines++;
  }

  return [chunk, parsedLines + startIndex];
}

function normalizeForFuzzyMatch(value: string): string {
  return value.trim().replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F\u3000]/g, " ");
}

function sequenceMatches(lines: string[], pattern: string[], index: number, mode: "exact" | "rstrip" | "trim" | "unicode"): boolean {
  for (let offset = 0; offset < pattern.length; offset++) {
    const lhs = lines[index + offset] ?? "";
    const rhs = pattern[offset] ?? "";
    if (mode === "exact" && lhs !== rhs) return false;
    if (mode === "rstrip" && lhs.trimEnd() !== rhs.trimEnd()) return false;
    if (mode === "trim" && lhs.trim() !== rhs.trim()) return false;
    if (mode === "unicode" && normalizeForFuzzyMatch(lhs) !== normalizeForFuzzyMatch(rhs)) return false;
  }
  return true;
}

function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;

  const maxStart = lines.length - pattern.length;
  const searchStart = eof ? maxStart : Math.min(start, maxStart);
  for (const mode of ["exact", "rstrip", "trim", "unicode"] as const) {
    for (let i = searchStart; i <= maxStart; i++) {
      if (sequenceMatches(lines, pattern, i, mode)) return i;
    }
  }
  return null;
}

function computeReplacements(originalLines: string[], path: string, chunks: UpdateChunk[]): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext != null) {
      const contextIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (contextIndex == null) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${path}`);
      }
      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex = originalLines.at(-1) === "" ? originalLines.length - 1 : originalLines.length;
      replacements.push([insertionIndex, 0, chunk.newLines]);
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

    if (found == null && pattern.at(-1) === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice.at(-1) === "") newSlice = newSlice.slice(0, -1);
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found == null) {
      throw new Error(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`);
    }

    replacements.push([found, pattern.length, newSlice]);
    lineIndex = found + pattern.length;
  }

  return replacements.sort((lhs, rhs) => lhs[0] - rhs[0]);
}

function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
  const result = [...lines];
  for (const [start, oldLength, newLines] of [...replacements].reverse()) {
    result.splice(start, oldLength, ...newLines);
  }
  return result;
}

async function readFileText(path: string): Promise<string> {
  return await Bun.file(path).text();
}

async function ensureParentDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

async function writeText(
  path: string,
  content: string,
  signal?: AbortSignal,
  onWriteStart?: () => void,
): Promise<void> {
  throwIfPatchAborted(signal);
  await ensureParentDirectory(path);
  throwIfPatchAborted(signal);
  onWriteStart?.();
  await writeFile(path, content, "utf8");
}

function resolvePatchPath(cwd: string, patchPath: string): string {
  return resolve(cwd, patchPath);
}

async function deriveUpdatedContents(path: string, chunks: UpdateChunk[], signal?: AbortSignal): Promise<string> {
  throwIfPatchAborted(signal);
  const originalContents = await readFileText(path);
  throwIfPatchAborted(signal);
  const originalLines = originalContents.split("\n");
  if (originalLines.at(-1) === "") originalLines.pop();
  const replacements = computeReplacements(originalLines, path, chunks);
  const newLines = applyReplacements(originalLines, replacements);
  if (newLines.at(-1) !== "") newLines.push("");
  return newLines.join("\n");
}

async function applyHunks(
  hunks: Hunk[],
  cwd: string,
  affected: AffectedPaths,
  signal?: AbortSignal,
): Promise<void> {
  if (hunks.length === 0) throw new Error("No files were modified.");

  for (const hunk of hunks) {
    throwIfPatchAborted(signal);
    const absPath = resolvePatchPath(cwd, hunk.path);
    if (hunk.kind === "add") {
      await writeText(absPath, hunk.contents, signal, () => { affected.uncertainPath = hunk.path; });
      affected.uncertainPath = null;
      affected.added.push(hunk.path);
      throwIfPatchAborted(signal);
      continue;
    }

    if (hunk.kind === "delete") {
      const metadata = await stat(absPath);
      if (metadata.isDirectory()) throw new Error(`Failed to delete file ${absPath}: path is a directory`);
      throwIfPatchAborted(signal);
      affected.uncertainPath = hunk.path;
      await rm(absPath, { recursive: false, force: false });
      affected.uncertainPath = null;
      affected.deleted.push(hunk.path);
      throwIfPatchAborted(signal);
      continue;
    }

    const newContents = await deriveUpdatedContents(absPath, hunk.chunks, signal);
    throwIfPatchAborted(signal);
    if (hunk.movePath != null) {
      const destAbs = resolvePatchPath(cwd, hunk.movePath);
      await writeText(destAbs, newContents, signal, () => { affected.uncertainPath = hunk.movePath; });
      affected.uncertainPath = null;
      affected.modified.push(hunk.movePath);
      throwIfPatchAborted(signal);
      const metadata = await stat(absPath);
      if (metadata.isDirectory()) throw new Error(`Failed to remove original ${absPath}: path is a directory`);
      throwIfPatchAborted(signal);
      affected.uncertainPath = hunk.path;
      await rm(absPath, { recursive: false, force: false });
      affected.uncertainPath = null;
      affected.movedFrom.push(hunk.path);
      throwIfPatchAborted(signal);
    } else {
      await writeText(absPath, newContents, signal, () => { affected.uncertainPath = hunk.path; });
      affected.uncertainPath = null;
      affected.modified.push(hunk.path);
      throwIfPatchAborted(signal);
    }
  }
}

function formatSummary(affected: AffectedPaths): string {
  const lines = ["Success. Updated the following files:"];
  for (const path of affected.added) lines.push(`A ${path}`);
  for (const path of affected.modified) lines.push(`M ${path}`);
  for (const path of affected.deleted) lines.push(`D ${path}`);
  return lines.join("\n");
}

function hasAffectedPaths(affected: AffectedPaths): boolean {
  return affected.added.length > 0
    || affected.modified.length > 0
    || affected.deleted.length > 0
    || affected.movedFrom.length > 0;
}

function formatPartialSummary(affected: AffectedPaths): string {
  if (!hasAffectedPaths(affected)) return "No files were changed before the patch stopped.";
  const lines = ["Changes already applied before the patch stopped:"];
  for (const path of affected.added) lines.push(`A ${path}`);
  for (const path of affected.modified) lines.push(`M ${path}`);
  for (const path of affected.deleted) lines.push(`D ${path}`);
  for (const path of affected.movedFrom) lines.push(`D ${path}`);
  return lines.join("\n");
}

function formatUncertainMutation(affected: AffectedPaths): string {
  return affected.uncertainPath == null
    ? ""
    : `The failing filesystem operation may also have modified:\n? ${affected.uncertainPath}`;
}

async function executePatch(
  input: Record<string, unknown>,
  _context?: ToolExecutionContext,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const patchInput = getString(input, "input");
  const cwdInput = getString(input, "cwd") ?? process.cwd();

  if (!patchInput) return { output: "Error: missing 'input' parameter", isError: true };
  if (!cwdInput) return { output: "Error: missing 'cwd' parameter", isError: true };
  if (!isAbsolutePatchPath(cwdInput)) {
    return { output: `Error: cwd must be absolute, got: ${cwdInput}`, isError: true };
  }

  const affected: AffectedPaths = {
    added: [],
    modified: [],
    deleted: [],
    movedFrom: [],
    uncertainPath: null,
  };
  try {
    const parsed = parsePatch(patchInput);
    await applyHunks(parsed.hunks, cwdInput, affected, signal);
    return { output: formatSummary(affected), isError: false };
  } catch (err) {
    const partialSummary = formatPartialSummary(affected);
    if (err instanceof PatchAbortedError) {
      return { output: partialSummary, isError: true };
    }
    const msg = err instanceof Error ? err.message : String(err);
    log("error", `patch: ${msg}`);
    const details = [
      hasAffectedPaths(affected) ? partialSummary : "",
      formatUncertainMutation(affected),
    ].filter(Boolean);
    const detailSuffix = details.length > 0 ? `\n\n${details.join("\n\n")}` : "";
    return { output: `Error applying patch: ${msg}${detailSuffix}`, isError: true };
  }
}

function summarize(input: Record<string, unknown>): ToolSummary {
  const cwd = getString(input, "cwd") ?? "";
  return { label: "Patch", detail: summarizeParams(cwd, input, ["cwd", "input"]) };
}

const PATCH_DESCRIPTION = `Use the patch tool to edit files with a Codex-style apply_patch format. The input is the entire patch text.

Patch envelope:
*** Begin Patch
[one or more file sections]
*** End Patch

File sections:
*** Add File: <relative path>      create/write a file; following lines must start with +
*** Delete File: <relative path>   delete a file
*** Update File: <relative path>   update a file in place; may be followed by *** Move to: <relative path>

Update hunks start with @@ optionally followed by a context line, then lines prefixed with space (context), - (old), or + (new). Use about 3 lines of context around each change. File references must be relative, never absolute.`;

export const patch: Tool = {
  name: "patch",
  description: PATCH_DESCRIPTION,
  parallelSafety: "exclusive",
  defaultTimeoutMs: 30_000,
  settleOnAbort: true,
  inputSchema: {
    type: "object",
    properties: {
      input: { type: "string", description: "The entire contents of the patch, including *** Begin Patch and *** End Patch" },
      cwd: { type: "string", description: "Absolute working directory used to resolve relative patch paths (defaults to the agent working directory)" },
    },
    required: ["input"],
  },
  systemHint: "Prefer the patch tool for multi-file edits, file creates/deletes/renames, or structured changes. Use relative paths inside the patch; do not use absolute paths in patch file headers.",
  display: {
    label: "Patch",
    color: "#c3e88d",  // soft lime green
  },
  summarize,
  execute: executePatch,
};

export const patchInternalsForTest = {
  parsePatch,
  seekSequence,
};
