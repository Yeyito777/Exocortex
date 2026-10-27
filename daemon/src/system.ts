/**
 * System prompt builders for exocortexd.
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { buildToolSystemHints } from "./tools/registry";
import type { ProviderId } from "./messages";
import { getExternalToolHints } from "./external-tools";
import { configDir } from "@exocortex/shared/paths";

/**
 * App-wide instructions come from two files, layered in this order:
 * - config/system.base.md: the tracked upstream base every install gets.
 * - config/system.md: this install's own additions (gitignored). /instructions
 *   global and set_global_instructions edit only this one.
 * Each is re-read when its mtime or size changes, so edits apply from the next
 * request without a restart.
 */
interface InstructionsFile {
  name: string;
  text: string;
  /** The file's mtime and size when it was last read; a different one means it was edited. */
  stamp: string | null;
}

const baseFile: InstructionsFile = { name: "system.base.md", text: "", stamp: null };
const personalFile: InstructionsFile = { name: "system.md", text: "", stamp: null };

function instructionsPath(file: InstructionsFile): string {
  return join(configDir(), file.name);
}

function fileStamp(file: InstructionsFile): string | null {
  try {
    const stat = statSync(instructionsPath(file));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function readInstructionsFile(file: InstructionsFile): string {
  try {
    return readFileSync(instructionsPath(file), "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function loadInstructionsFile(file: InstructionsFile): void {
  file.stamp = fileStamp(file);
  try {
    file.text = readInstructionsFile(file);
  } catch {
    file.text = "";
  }
}
loadInstructionsFile(baseFile);
loadInstructionsFile(personalFile);

/** A file's text, re-read when it has been edited. A read error keeps the last one. */
function currentText(file: InstructionsFile): string {
  const stamp = fileStamp(file);
  if (stamp !== file.stamp) {
    try {
      file.text = readInstructionsFile(file);
      file.stamp = stamp;
    } catch {
      // Keep the last good instructions.
    }
  }
  return file.text;
}

/** The tracked upstream base (config/system.base.md). */
export function getBaseInstructions(): string {
  return currentText(baseFile);
}

/** This install's own app-wide instructions (config/system.md), without the base. */
export function getUserAddendum(): string {
  return currentText(personalFile);
}

/** Everything every conversation gets: the base, then this install's additions. */
export function getGlobalInstructions(): string {
  return [getBaseInstructions(), getUserAddendum()].filter(Boolean).join("\n\n");
}

/** Reload this install's instructions before a compare-and-set operation. */
export function reloadUserAddendum(): string {
  const stamp = fileStamp(personalFile);
  const text = readInstructionsFile(personalFile);
  personalFile.text = text;
  personalFile.stamp = stamp;
  return personalFile.text;
}

function writeInstructionsFile(file: InstructionsFile, normalized: string): void {
  const path = instructionsPath(file);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, normalized ? `${normalized}\n` : "", { mode: 0o644 });
    renameSync(tmp, path);
    file.text = normalized;
    file.stamp = fileStamp(file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Persist and immediately activate this install's app-wide instructions. */
export function setUserAddendum(text: string, expectedText?: string): void {
  mkdirSync(configDir(), { recursive: true });
  if (expectedText !== undefined && readInstructionsFile(personalFile) !== expectedText) {
    throw new Error("App instructions changed since they were read");
  }
  writeInstructionsFile(personalFile, text.trim());
}

// ── Migration from a single config/system.md ────────────────────────

/** Split markdown into blocks, each starting at a top-level `# ` heading (outside code fences). */
export function splitInstructionSections(text: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = line.match(/^\s*(```|~~~)/)?.[1] ?? null;
    if (marker && (fence === null || fence === marker)) fence = fence === null ? marker : null;
    if (fence === null && !marker && line.startsWith("# ") && current.some(prior => prior.trim())) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.some(line => line.trim())) sections.push(current.join("\n"));
  return sections.map(section => section.replace(/^\s*\n/, "").trimEnd()).filter(Boolean);
}

export interface InstructionsDedupe {
  /** The personal text with base sections removed. */
  text: string;
  /** Headings (first lines) of sections dropped as identical to the base. */
  removed: string[];
  /** Headings of sections kept because they differ from the base section of the same name. */
  edited: string[];
}

/** Drop sections of `personal` that are identical to a section of `base`; edited and new ones stay. */
export function dedupeAgainstBase(personal: string, base: string): InstructionsDedupe {
  const baseSections = splitInstructionSections(base);
  const baseSet = new Set(baseSections);
  const baseHeadings = new Set(baseSections.map(section => section.split("\n")[0]));
  const kept: string[] = [];
  const removed: string[] = [];
  const edited: string[] = [];
  for (const section of splitInstructionSections(personal)) {
    const heading = section.split("\n")[0];
    if (baseSet.has(section)) removed.push(heading);
    else {
      if (baseHeadings.has(heading)) edited.push(heading);
      kept.push(section);
    }
  }
  return { text: kept.join("\n\n"), removed, edited };
}

export interface GlobalInstructionsMigration {
  /** Where the original config/system.md was copied before rewriting it; null when untouched. */
  backup: string | null;
  removed: string[];
  edited: string[];
}

/**
 * Before the base was split out, config/system.md held the base sections too.
 * Remove the ones still identical to the base so they are not sent twice,
 * after copying the original aside. Idempotent: a deduplicated file is left
 * alone, so it is safe on every start and on every clone.
 */
export function migrateGlobalInstructions(now = new Date()): GlobalInstructionsMigration {
  const base = readInstructionsFile(baseFile);
  const personal = readInstructionsFile(personalFile);
  const result = dedupeAgainstBase(personal, base);
  if (!base || !personal || result.removed.length === 0) return { backup: null, removed: [], edited: result.edited };
  const path = instructionsPath(personalFile);
  const backup = `${path}.pre-split-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.bak`;
  copyFileSync(path, backup);
  writeInstructionsFile(personalFile, result.text);
  return { backup, removed: result.removed, edited: result.edited };
}

function buildEnvironmentHeader(conversationId?: string, identity = "You are Exo, the user's assistant.", workingDirectory = process.cwd()): string {
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return [
    identity,
    "",
    "Environment:",
    `- Working directory: ${workingDirectory}`,
    `- Date: ${date}`,
    `- Platform: ${process.platform} ${process.arch}`,
    ...(conversationId ? [`- Exocortex conversation ID: ${conversationId}`] : []),
  ].join("\n");
}

export interface BuildSystemPromptOptions {
  conversationInstructions?: string;
  conversationId?: string;
  /** Effective cwd for this model/tool session. */
  workingDirectory?: string;
  /** Remaining native exo nesting budget for this conversation turn. */
  subagentMaxDepth?: number | null;
  /** Restrict tool-specific prompt hints to this explicit session allowlist. */
  toolNames?: readonly string[];
  /** The conversation's provider, for hints whose wording depends on it. */
  provider?: ProviderId;
  /** Managed external tool hints can be disabled for utility/restricted sessions. */
  includeExternalToolHints?: boolean;
  /** Session-specific behavior placed near the top of the system prompt. */
  wrapperNote?: string;
  /** Session-specific assistant identity. */
  identity?: string;
}

/** External tools, app-wide addendum and conversation instructions: context every agent runtime needs. */
function buildAdditionParts(options: { conversationInstructions?: string; includeExternalHints: boolean }): string[] {
  const parts: string[] = [];
  if (options.includeExternalHints) {
    const externalHints = getExternalToolHints();
    if (externalHints) parts.push("# External tools\n" + externalHints);
  }

  const globalInstructions = getGlobalInstructions();
  if (globalInstructions) parts.push(globalInstructions);
  if (options.conversationInstructions) parts.push("# Conversation instructions\n" + options.conversationInstructions);
  return parts;
}

function buildPromptParts(options: BuildSystemPromptOptions & {
  includeToolHints: boolean;
  includeExternalHints: boolean;
}): string[] {
  const parts = [buildEnvironmentHeader(options.conversationId, options.identity, options.workingDirectory)];

  if (options.includeToolHints) {
    const toolHints = options.toolNames?.length === 0
      ? "None: this conversation offers no tools."
      : buildToolSystemHints(options.toolNames, options.conversationId, options.provider);
    parts.push(toolHints ? `# Internal tools\n${toolHints}` : "# Internal tools");
  }

  if (options.wrapperNote) parts.push(options.wrapperNote);

  const depth = options.subagentMaxDepth;
  const hasExoTool = !options.toolNames || options.toolNames.includes("exo");
  if (hasExoTool && typeof depth === "number" && Number.isInteger(depth) && depth >= 0) {
    if (depth === 0) parts.push("This is a depth-zero turn: do not delegate further. Administration uses direct daemon IPC.");
  }

  parts.push(...buildAdditionParts(options));

  return parts;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
  return buildPromptParts({
    includeToolHints: true,
    includeExternalHints: options.includeExternalToolHints ?? true,
    ...options,
  }).join("\n\n");
}

/**
 * Text appended to Claude Code's own system prompt on anthropic turns. Claude
 * Code supplies identity, environment and tool guidance, so Exocortex adds only
 * what it cannot know: a scoped subagent's role, external tools, and the app
 * and conversation instructions.
 */
export function buildClaudeCodeSystemAppend(options: Pick<BuildSystemPromptOptions,
  "conversationInstructions" | "includeExternalToolHints" | "identity" | "wrapperNote"
> = {}): string {
  return [
    ...(options.identity ? [options.identity] : []),
    ...(options.wrapperNote ? [options.wrapperNote] : []),
    ...buildAdditionParts({
      conversationInstructions: options.conversationInstructions,
      includeExternalHints: options.includeExternalToolHints ?? true,
    }),
  ].join("\n\n");
}
