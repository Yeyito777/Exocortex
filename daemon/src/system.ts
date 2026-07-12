/**
 * System prompt builders for exocortexd.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { buildToolSystemHints } from "./tools/registry";
import { getExternalToolHints } from "./external-tools";
import { configDir } from "@exocortex/shared/paths";

let _userAddendum = "";

function userAddendumPath(): string {
  return join(configDir(), "system.md");
}

function readUserAddendumFile(): string {
  try {
    return readFileSync(userAddendumPath(), "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function loadUserAddendum(): void {
  try {
    _userAddendum = readUserAddendumFile();
  } catch {
    _userAddendum = "";
  }
}
loadUserAddendum();

export function getUserAddendum(): string {
  return _userAddendum;
}

/** Reload the app-wide addendum before a compare-and-set operation. */
export function reloadUserAddendum(): string {
  const text = readUserAddendumFile();
  _userAddendum = text;
  return _userAddendum;
}

/** Persist and immediately activate the app-wide user instruction addendum. */
export function setUserAddendum(text: string, expectedText?: string): void {
  const normalized = text.trim();
  const path = userAddendumPath();
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(configDir(), { recursive: true });
  if (expectedText !== undefined && readUserAddendumFile() !== expectedText) {
    throw new Error("App instructions changed since they were read");
  }
  try {
    writeFileSync(tmp, normalized ? `${normalized}\n` : "", { mode: 0o644 });
    renameSync(tmp, path);
    _userAddendum = normalized;
  } finally {
    rmSync(tmp, { force: true });
  }
}

function buildEnvironmentHeader(conversationId?: string): string {
  const cwd = process.cwd();
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return [
    "You are Exo, the user's assistant.",
    "",
    "Environment:",
    `- Working directory: ${cwd}`,
    `- Date: ${date}`,
    `- Platform: ${process.platform} ${process.arch}`,
    ...(conversationId ? [`- Exocortex conversation ID: ${conversationId}`] : []),
  ].join("\n");
}

export interface BuildSystemPromptOptions {
  conversationInstructions?: string;
  conversationId?: string;
}

function buildPromptParts(options: BuildSystemPromptOptions & {
  includeToolHints: boolean;
  includeExternalHints: boolean;
  wrapperNote?: string;
}): string[] {
  const parts = [buildEnvironmentHeader(options.conversationId)];

  if (options.wrapperNote) parts.push(options.wrapperNote);

  if (options.includeToolHints) {
    const toolHints = buildToolSystemHints();
    if (toolHints) parts.push(toolHints);
  }

  if (options.includeExternalHints) {
    const externalHints = getExternalToolHints();
    if (externalHints) parts.push("# External tools\n" + externalHints);
  }

  if (_userAddendum) parts.push(_userAddendum);
  if (options.conversationInstructions) parts.push("# Conversation instructions\n" + options.conversationInstructions);

  return parts;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
  return buildPromptParts({
    includeToolHints: true,
    includeExternalHints: true,
    ...options,
  }).join("\n\n");
}
