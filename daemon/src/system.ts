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

function buildEnvironmentHeader(): string {
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
  ].join("\n");
}

function buildPromptParts(options: {
  includeToolHints: boolean;
  includeExternalHints: boolean;
  conversationInstructions?: string;
  wrapperNote?: string;
}): string[] {
  const parts = [buildEnvironmentHeader()];

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

export function buildSystemPrompt(conversationInstructions?: string): string {
  return buildPromptParts({
    includeToolHints: true,
    includeExternalHints: true,
    conversationInstructions,
  }).join("\n\n");
}

export function buildAnthropicSystemPrompt(conversationInstructions?: string): string {
  return buildPromptParts({
    includeToolHints: true,
    includeExternalHints: true,
    conversationInstructions,
    wrapperNote: [
      "# Runtime",
      "You are Exo, operating through Exocortex with Anthropic as the model backend.",
      "Use the Exocortex tools and shell-accessible CLIs explicitly described in this prompt.",
      "Do not assume Claude Code's built-in tools like Bash, Read, Edit, WebSearch, WebFetch, or ToolSearch exist unless they are explicitly present in your tool list.",
      "Follow the Exocortex tool semantics and names described in your tool list and system instructions.",
      "Keep your responses compatible with a terminal-style coding assistant.",
    ].join("\n"),
  }).join("\n\n");
}
