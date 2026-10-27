/**
 * Model-facing tool prose, kept as plain text files beside the code.
 *
 * Each built-in tool has two texts in daemon/src/tools/text/, editable from
 * /instructions tools: <tool>.description.md, its schema description, and
 * <tool>.hint.md, its hint: under # Internal tools in the system prompt, or
 * the exocortex MCP server's instructions under Claude Code. Files are re-read
 * when they change: the next turn of any conversation gets the new text
 * without a restart. A missing or empty file means no text (no hint).
 *
 * Values computed at runtime appear as explicit {{name}} placeholders. Each
 * tool declares its own (toolTextSource), which may differ by provider where
 * the wording must; every tool also gets {{repoRoot}}.
 */

import { readFileSync, statSync } from "fs";
import { join } from "path";
import { repoRoot } from "@exocortex/shared/paths";
import type { ProviderId } from "../messages";

export type ToolTextKind = "description" | "hint";

export const TOOL_TEXT_KINDS: readonly ToolTextKind[] = ["description", "hint"];

/** Placeholder values for a tool's text, by name ({{name}} in the files). */
export type ToolTextValues = Record<string, string>;

const DEFAULT_TEXT_DIR = join(import.meta.dir, "text");
let textDirOverride: string | null = null;

/** Where the text files live: this checkout's daemon/src/tools/text, or EXOCORTEX_TOOL_TEXT_DIR (tests). */
export function toolTextDir(): string {
  return textDirOverride ?? (process.env.EXOCORTEX_TOOL_TEXT_DIR?.trim() || DEFAULT_TEXT_DIR);
}

/** Point the loader at another directory for a test; returns the restore callback. */
export function setToolTextDirForTest(dir: string | null): () => void {
  const previous = textDirOverride;
  textDirOverride = dir;
  cache.clear();
  return () => {
    textDirOverride = previous;
    cache.clear();
  };
}

export function toolTextPath(tool: string, kind: ToolTextKind): string {
  return join(toolTextDir(), `${tool}.${kind}.md`);
}

interface CachedText {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  text: string;
}

const cache = new Map<string, CachedText>();

/** A file as stored: its text without trailing newlines, "" when missing. Re-read when it changes. */
export function readToolTextFile(path: string): string {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    cache.delete(path);
    return "";
  }
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs && cached.size === stat.size) return cached.text;
  let text: string;
  try {
    text = readFileSync(path, "utf-8").replace(/\n+$/, "");
  } catch {
    return cached?.text ?? "";
  }
  cache.set(path, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, text });
  return text;
}

/** Forget a file's cached text (after writing it). */
export function invalidateToolText(path?: string): void {
  if (path) cache.delete(path);
  else cache.clear();
}

/** The placeholder token for a value name. */
export function toolTextToken(name: string): string {
  return `{{${name}}}`;
}

/** Replace each {{name}} with its value; unknown placeholders stay as written. */
export function expandToolText(template: string, values: ToolTextValues): string {
  return template.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (token, name: string) =>
    Object.hasOwn(values, name) ? values[name] : token);
}

type ValuesFor = (provider?: ProviderId) => ToolTextValues;

const valueSources = new Map<string, ValuesFor>();

/** The placeholder values a tool's text expands with on `provider`. */
export function toolTextValues(tool: string, provider?: ProviderId): ToolTextValues {
  return { repoRoot: repoRoot(), ...valueSources.get(tool)?.(provider) };
}

export interface ToolTextSource {
  /** The expanded text of one of the tool's files ("" when it has none). */
  text(kind: ToolTextKind, provider?: ProviderId): string;
  /** The schema description. */
  description(provider?: ProviderId): string;
  /** The hint, or undefined when the tool has none. */
  hint(provider?: ProviderId): string | undefined;
}

/** A tool's text files, expanded with its own placeholder values (besides {{repoRoot}}). */
export function toolTextSource(tool: string, values?: ValuesFor): ToolTextSource {
  if (values) valueSources.set(tool, values);
  const text = (kind: ToolTextKind, provider?: ProviderId) =>
    expandToolText(readToolTextFile(toolTextPath(tool, kind)), toolTextValues(tool, provider));
  return {
    text,
    description: provider => text("description", provider),
    hint: provider => text("hint", provider) || undefined,
  };
}

/** One of a tool's files, expanded with its placeholder values. */
export function toolText(tool: string, kind: ToolTextKind, provider?: ProviderId): string {
  return expandToolText(readToolTextFile(toolTextPath(tool, kind)), toolTextValues(tool, provider));
}
