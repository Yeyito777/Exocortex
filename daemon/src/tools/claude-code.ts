/**
 * Display adapters for Claude Code's built-in tools.
 *
 * The anthropic provider lets Claude Code run its own tools, so those calls
 * arrive with Claude Code's names and input shapes. Calls with an Exocortex
 * counterpart borrow that tool's label, color and summary so they render the
 * same way, both live and when history is reloaded. These are display entries
 * only; Exocortex never offers or executes them.
 *
 * Host tools are the exception: Exocortex tools Claude Code calls over MCP as
 * `mcp__exocortex__<name>`. Exocortex executes those, and history records them
 * under their own name.
 */

import type { ToolDisplayInfo } from "@exocortex/shared/messages";
import type { Tool, ToolSummary } from "./types";
import { bash } from "./bash";
import { read } from "./read";
import { write } from "./write";
import { edit } from "./edit";
import { grep } from "./grep";
import { glob } from "./glob";
import { browse } from "./browse";
import { exo } from "./exo";
import { getRegisteredTools } from "./registry";

type Input = Record<string, unknown>;

interface ClaudeCodeTool {
  /** Exocortex tool whose label and color the call borrows. */
  like: Tool;
  label?: string;
  /** Rewrite the input into `like`'s shape and use its summary; omit for a generic summary. */
  input?: (input: Input) => Input;
}

let claudeCodeTools: Map<string, ClaudeCodeTool> | undefined;

export const CLAUDE_CODE_HOST_TOOL_SERVER = "exocortex";
const HOST_TOOL_PREFIX = `mcp__${CLAUDE_CODE_HOST_TOOL_SERVER}__`;
const HOST_TOOLS: readonly string[] = ["chrono"];

export function isClaudeCodeHostTool(name: string): boolean {
  return HOST_TOOLS.includes(name);
}

/** Name to record a Claude Code tool call under: host tools take their Exocortex name. */
export function exocortexToolName(claudeCodeName: string): string {
  const name = claudeCodeName.startsWith(HOST_TOOL_PREFIX) ? claudeCodeName.slice(HOST_TOOL_PREFIX.length) : "";
  return isClaudeCodeHostTool(name) ? name : claudeCodeName;
}

// Built on first use: browse → llm → anthropic provider → here is an import cycle.
function getClaudeCodeTools(): Map<string, ClaudeCodeTool> {
  return claudeCodeTools ??= new Map<string, ClaudeCodeTool>([
    ["Bash", { like: bash, input: ({ command, timeout, run_in_background }) => ({ command, timeout, run_in_background }) }],
    ["Read", { like: read, input: input => input }],
    ["Write", { like: write, input: input => input }],
    ["Edit", { like: edit, input: ({ file_path, replace_all }) => ({ path: file_path, replace_all }) }],
    ["MultiEdit", { like: edit, input: ({ file_path }) => ({ path: file_path }) }],
    ["NotebookEdit", { like: edit, input: ({ notebook_path, cell_id, edit_mode }) => ({ path: notebook_path, cell_id, edit_mode }) }],
    ["Grep", { like: grep, input: input => input }],
    ["Glob", { like: glob, input: input => input }],
    ["WebFetch", { like: browse, input: ({ url }) => ({ url }) }],
    ["WebSearch", { like: browse, label: "Search" }],
    ["Agent", { like: exo, label: "Agent" }],
    ["Task", { like: exo, label: "Agent" }],
  ]);
}

const DETAIL_KEYS = ["description", "command", "file_path", "notebook_path", "pattern", "url", "query", "prompt", "skill", "path"];

function genericDetail(input: Input): string {
  for (const key of DETAIL_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const line = value.replace(/\s+/g, " ").trim();
    return line.length > 120 ? `${line.slice(0, 119)}…` : line;
  }
  return "";
}

/** Summary for a Claude Code tool call, in its Exocortex counterpart's format when it has one. */
export function summarizeClaudeCodeTool(name: string, input: Input): ToolSummary {
  const host = isClaudeCodeHostTool(name) ? getRegisteredTools().find(tool => tool.name === name) : undefined;
  if (host) return host.summarize(input);
  const tool = getClaudeCodeTools().get(name);
  const label = tool?.label ?? tool?.like.display.label ?? name;
  if (tool?.input) return { ...tool.like.summarize(tool.input(input)), label };
  return { label, detail: genericDetail(input) };
}

/** TUI display entries for Claude Code tools that have an Exocortex counterpart. */
export function getClaudeCodeToolDisplayInfo(): ToolDisplayInfo[] {
  return [...getClaudeCodeTools()].map(([name, tool]) => ({
    name,
    label: tool.label ?? tool.like.display.label,
    color: tool.like.display.color,
  }));
}
