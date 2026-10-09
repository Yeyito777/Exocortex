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

import { parseMcpToolName, type ToolDisplayInfo } from "@exocortex/shared/messages";
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
import { summarizeParams } from "./util";

type Input = Record<string, unknown>;

interface ClaudeCodeTool {
  /** Exocortex tool whose color the call borrows, and its label unless `label` is set. */
  like?: Tool;
  label?: string;
  /** Rewrite the input into `like`'s shape and use its summary. */
  input?: (input: Input) => Input;
  /** The call's detail, naming tasks by `titleOf`; with neither this nor `input`, a generic one. */
  detail?: (input: Input, titleOf: (id: unknown) => string) => string;
}

/** Titles of Claude Code tasks by id (agent ids included), to name the task a call addresses. */
export type ClaudeCodeTaskTitles = ReadonlyMap<string, string>;

let claudeCodeTools: Map<string, ClaudeCodeTool> | undefined;

export const CLAUDE_CODE_HOST_TOOL_SERVER = "exocortex";
const HOST_TOOL_PREFIX = `mcp__${CLAUDE_CODE_HOST_TOOL_SERVER}__`;
const HOST_TOOLS: readonly string[] = ["chrono", "goal", "exo"];

export function isClaudeCodeHostTool(name: string): boolean {
  return HOST_TOOLS.includes(name);
}

/** Name to record a Claude Code tool call under: host tools take their Exocortex name. */
export function exocortexToolName(claudeCodeName: string): string {
  const name = claudeCodeName.startsWith(HOST_TOOL_PREFIX) ? claudeCodeName.slice(HOST_TOOL_PREFIX.length) : "";
  return isClaudeCodeHostTool(name) ? name : claudeCodeName;
}

/** A string input value on one line, capped. */
function oneLine(value: unknown): string {
  if (typeof value !== "string") return "";
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** `primary` followed by the set flags, like Exocortex tool summaries. */
function withFlags(primary: string, flags: Input): string {
  return summarizeParams(primary, flags, []).trim();
}

/** Claude Code's Bash input in Exocortex bash's terms: a timeout in seconds, `background`. */
function bashInput({ command, timeout, run_in_background }: Input): Input {
  return {
    command,
    timeout_seconds: typeof timeout === "number" ? timeout / 1000 : undefined,
    background: run_in_background,
  };
}

function agentDetail({ description, prompt, name, subagent_type, model, isolation, run_in_background }: Input): string {
  return withFlags(oneLine(description) || oneLine(prompt), {
    name,
    subagent_type: subagent_type === "general-purpose" ? undefined : subagent_type,
    model,
    isolation,
    background: run_in_background,
  });
}

function workflowDetail({ name, scriptPath, script }: Input): string {
  const metaName = typeof script === "string" ? /\bname:\s*['"`]([^'"`]+)['"`]/.exec(script)?.[1] : undefined;
  return oneLine(name) || oneLine(scriptPath) || oneLine(metaName);
}

// Built on first use: browse → llm → anthropic provider → here is an import cycle.
function getClaudeCodeTools(): Map<string, ClaudeCodeTool> {
  return claudeCodeTools ??= new Map<string, ClaudeCodeTool>([
    ["Bash", { like: bash, input: bashInput }],
    ["Read", { like: read, input: input => input }],
    ["Write", { like: write, input: input => input }],
    ["Edit", { like: edit, input: ({ file_path, replace_all }) => ({ path: file_path, replace_all }) }],
    ["MultiEdit", { like: edit, input: ({ file_path }) => ({ path: file_path }) }],
    ["NotebookEdit", { like: edit, input: ({ notebook_path, cell_id, edit_mode }) => ({ path: notebook_path, cell_id, edit_mode }) }],
    ["Grep", { like: grep, input: input => input }],
    ["Glob", { like: glob, input: input => input }],
    ["WebFetch", { like: browse, input: ({ url }) => ({ url }) }],
    ["WebSearch", { like: browse, label: "Search" }],
    ["Monitor", {
      like: bash,
      label: "Monitor",
      detail: ({ description, command, ws }) => oneLine(description) || oneLine(command) || oneLine((ws as Input | undefined)?.url),
    }],
    ["Agent", { like: exo, label: "Agent", detail: agentDetail }],
    ["Task", { like: exo, label: "Agent", detail: agentDetail }],
    ["SendMessage", {
      like: exo,
      label: "Message",
      detail: ({ to, summary, message, notify_when_idle }, titleOf) =>
        withFlags(oneLine(summary) || oneLine(typeof message === "string" ? message.split("\n")[0] : undefined), {
          to: titleOf(to) || undefined,
          notify_when_idle,
        }),
    }],
    ["ListAgents", { like: exo, label: "ListAgents" }],
    ["Workflow", { like: exo, label: "Workflow", detail: workflowDetail }],
    ["TaskStop", { detail: ({ task_id, shell_id }, titleOf) => titleOf(task_id) || titleOf(shell_id) }],
    ["KillShell", { detail: ({ shell_id }, titleOf) => titleOf(shell_id) }],
    ["TaskOutput", { detail: ({ task_id, ...flags }, titleOf) => withFlags(titleOf(task_id), flags) }],
    ["BashOutput", { detail: ({ bash_id, ...flags }, titleOf) => withFlags(titleOf(bash_id), flags) }],
    ["Skill", { detail: ({ skill, args }) => [oneLine(skill), oneLine(args)].filter(Boolean).join(" ") }],
    ["LSP", {
      detail: ({ operation, filePath, line, character, query }) =>
        [oneLine(operation), filePath ? `${oneLine(filePath)}:${line}:${character}` : "", oneLine(query)].filter(Boolean).join(" "),
    }],
  ]);
}

const DETAIL_KEYS = [
  "description", "command", "file_path", "notebook_path", "pattern", "url", "query", "prompt", "skill", "path",
  "subject", "summary", "message", "name", "task_id", "action",
];

/** The most telling string input, so a call never shows just its name. */
function genericDetail(input: Input): string {
  for (const key of DETAIL_KEYS) {
    const line = oneLine(input[key]);
    if (line) return line;
  }
  for (const value of Object.values(input)) {
    const line = oneLine(value);
    if (line) return line;
  }
  return "";
}

/**
 * Summary for a Claude Code tool call, in its Exocortex counterpart's format
 * when it has one. With `taskTitles`, a call addressing a task names it.
 */
export function summarizeClaudeCodeTool(name: string, input: Input, taskTitles?: ClaudeCodeTaskTitles): ToolSummary {
  const host = isClaudeCodeHostTool(name) ? getRegisteredTools().find(tool => tool.name === name) : undefined;
  if (host) return host.summarize(input);
  const mcp = parseMcpToolName(name);
  if (mcp) return { label: mcp.label, detail: [mcp.tool, genericDetail(input)].filter(Boolean).join(" ") };
  const tool = getClaudeCodeTools().get(name);
  const label = tool?.label ?? tool?.like?.display.label ?? name;
  if (tool?.like && tool.input) return { ...tool.like.summarize(tool.input(input)), label };
  const titleOf = (id: unknown) => oneLine(typeof id === "string" ? taskTitles?.get(id) ?? id : id);
  return { label, detail: tool?.detail ? tool.detail(input, titleOf) : genericDetail(input) };
}

/** Claude Code tools that answer with a JSON status whose `message` says what happened. */
const STATUS_RESULT_TOOLS = new Set(["SendMessage", "TaskStop", "KillShell"]);

/** A Claude Code tool's result as text, like an Exocortex tool's, rather than a JSON status. */
export function claudeCodeResultText(name: string, output: string): string {
  if (!STATUS_RESULT_TOOLS.has(name)) return output;
  try {
    const message = (JSON.parse(output) as Input | null)?.message;
    return typeof message === "string" && message ? message : output;
  } catch {
    return output;
  }
}

/** TUI display entries for Claude Code tools styled like an Exocortex tool. */
export function getClaudeCodeToolDisplayInfo(): ToolDisplayInfo[] {
  return [...getClaudeCodeTools()].flatMap(([name, tool]) => tool.like ? [{
    name,
    label: tool.label ?? tool.like.display.label,
    color: tool.like.display.color,
  }] : []);
}
