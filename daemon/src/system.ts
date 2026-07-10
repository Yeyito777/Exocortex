/**
 * System prompt builders for exocortexd.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { buildToolSystemHints } from "./tools/registry";
import { getExternalToolHints } from "./external-tools";
import { configDir } from "@exocortex/shared/paths";

let _userAddendum = "";

function loadUserAddendum(): void {
  try {
    _userAddendum = readFileSync(join(configDir(), "system.md"), "utf8").trim();
  } catch {
    _userAddendum = "";
  }
}
loadUserAddendum();

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
