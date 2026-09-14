/**
 * System prompt builders for exocortexd.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { buildToolSystemHints } from "./tools/registry";
import { getExternalToolHints, getExternalToolHintsForNames } from "./external-tools";
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
  /** Managed external tool hints can be disabled for utility/restricted sessions. */
  includeExternalToolHints?: boolean;
  /** Restrict external manifest hints to this exact resolved allowlist. */
  externalToolNames?: readonly string[];
  /** Session-specific behavior placed near the top of the system prompt. */
  wrapperNote?: string;
  /** Session-specific assistant identity. */
  identity?: string;
}

function buildPromptParts(options: BuildSystemPromptOptions & {
  includeToolHints: boolean;
  includeExternalHints: boolean;
}): string[] {
  const parts = [buildEnvironmentHeader(options.conversationId, options.identity, options.workingDirectory)];

  if (options.includeToolHints) {
    const toolHints = buildToolSystemHints(options.toolNames, options.conversationId, options.subagentMaxDepth);
    parts.push(toolHints ? `# Internal tools\n${toolHints}` : "# Internal tools");
  }

  if (options.wrapperNote) parts.push(options.wrapperNote);

  const depth = options.subagentMaxDepth;
  const hasExoTool = !options.toolNames || options.toolNames.includes("exo");
  if (hasExoTool && typeof depth === "number" && Number.isInteger(depth) && depth >= 0) {
    parts.push(depth === 0
      ? "This turn's remaining native exo subagent depth is 0. Use exo only for your own tasks (tasks, stop_task, or commands/task info|stop). No delegation or unrelated administration is available."
      : `This turn's remaining native exo subagent depth is ${depth}. A child turn may receive at most max_depth=${depth - 1}.`);
  }

  if (options.includeExternalHints) {
    const externalHints = options.externalToolNames === undefined
      ? getExternalToolHints()
      : getExternalToolHintsForNames(options.externalToolNames);
    if (externalHints) parts.push("# External tools\n" + externalHints);
  }

  if (_userAddendum) parts.push(_userAddendum);
  if (options.conversationInstructions) parts.push("# Conversation instructions\n" + options.conversationInstructions);

  // User addenda and external manifests may still use the older tool names.
  const names = new Set(options.toolNames);
  if (options.toolNames) parts.push([
    "# Effective tool guidance",
    `Available internal tools: ${options.toolNames.join(", ") || "(none)"}.`,
    ...(names.has("exec_command") ? [
      "Legacy references to the bash tool mean exec_command (cmd/workdir, yield_time_ms). External CLIs remain ordinary shell commands.",
      "Read/search text with exec_command and standard commands. Literal stdin can be passed with a quoted heredoc.",
    ] : []),
    ...(names.has("write_stdin") ? ["Use write_stdin only with an existing session_id to supply input or collect output."] : []),
    ...(names.has("read") ? ["Read local text with read."] : []),
    ...(names.has("glob") ? ["Find local paths with glob."] : []),
    ...(names.has("grep") ? ["Search local text with grep."] : []),
    ...(names.has("view_image") ? ["Inspect local images with view_image."] : []),
    ...(names.has("apply_patch") ? ["Edit files using raw apply_patch."] : []),
    ...(!names.has("exec_command") && !names.has("bash") ? [
      "No shell executor is available. Do not substitute unrestricted shell execution for restricted research tools.",
    ] : []),
    "Only use tools present in this effective selection; older documentation may mention unavailable tools.",
  ].join("\n"));

  return parts;
}

export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
  return buildPromptParts({
    includeToolHints: true,
    includeExternalHints: options.includeExternalToolHints ?? true,
    ...options,
  }).join("\n\n");
}
