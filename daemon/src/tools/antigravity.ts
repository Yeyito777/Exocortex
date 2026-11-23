/**
 * Display and safety adapters for the Antigravity CLI's built-in tools.
 *
 * The gemini provider lets the CLI run its own tools (run_command,
 * read_file, replace_file_content, ...), so their calls arrive with its names
 * and input shapes (PascalCase fields such as `CommandLine`, `TargetFile`).
 * Calls with an Exocortex counterpart borrow that tool's label, color and
 * summary, and map onto it for the safety denylist. Exocortex never offers or
 * executes these tools itself.
 *
 * Host tools are the exception: Exocortex tools the CLI calls over MCP as
 * `mcp_exocortex_<name>`. Exocortex executes those, and history records them
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
import { CLAUDE_CODE_HOST_TOOL_SERVER, isClaudeCodeHostTool } from "./claude-code";
import { getRegisteredTools } from "./registry";

type Input = Record<string, unknown>;

/** How the CLI names an MCP tool: `mcp_<server>_<tool>`. A function: registry → here → claude-code is an import cycle. */
const hostToolPrefix = () => `mcp_${CLAUDE_CODE_HOST_TOOL_SERVER}_`;

/** The CLI's own subagent, scheduler and ask-the-user tools: Exocortex's exo and chrono replace them, and nobody can answer a question mid-turn. */
export const ANTIGRAVITY_REPLACED_TOOLS: Readonly<Record<string, string>> = {
  invoke_subagent: "Use the exo tool to delegate to a subagent instead.",
  define_subagent: "Use the exo tool to delegate to a subagent instead.",
  manage_subagents: "Use the exo tool to manage subagents instead.",
  browser_subagent: "Use the exo tool to delegate browser work to a subagent instead.",
  send_message: "Use the exo tool to message other conversations instead.",
  schedule: "Use the chrono tool to schedule wakes instead.",
  ask_question: "Exocortex cannot answer questions mid-turn: decide yourself, or end your turn with the question.",
  ask_permission: "Exocortex runs unattended: proceed within your instructions, or end your turn and ask.",
  ask_custom_permission: "Exocortex runs unattended: proceed within your instructions, or end your turn and ask.",
};

function str(input: Input, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function defined(fields: Input): Input {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

const PATH_KEYS = ["AbsolutePath", "TargetFile", "Path", "File", "FilePath", "DirectoryPath", "SearchPath", "SearchDirectory", "NotebookPath"];

/** An Antigravity tool call as the equivalent Exocortex tool call, or null when it has none. */
export function antigravityEquivalent(name: string, input: Input): { tool: Tool; input: Input } | null {
  switch (name) {
    case "run_command":
      return { tool: bash, input: defined({ command: str(input, "CommandLine", "Command") }) };
    case "read_file":
    case "view_file":
    case "list_dir":
      return { tool: read, input: defined({ file_path: str(input, ...PATH_KEYS) }) };
    case "write_to_file":
      return { tool: write, input: defined({ file_path: str(input, ...PATH_KEYS), content: str(input, "CodeContent", "Content") }) };
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
    case "notebook_edit":
      return { tool: edit, input: defined({ path: str(input, ...PATH_KEYS), newText: str(input, "ReplacementContent") }) };
    case "grep_search":
      return { tool: grep, input: defined({ pattern: str(input, "Query", "Pattern"), path: str(input, ...PATH_KEYS) }) };
    case "find_by_name":
      return { tool: glob, input: defined({ pattern: str(input, "Pattern", "Query"), path: str(input, ...PATH_KEYS) }) };
    case "read_url_content":
      return { tool: browse, input: defined({ url: str(input, "Url", "URL") }) };
    default:
      return null;
  }
}

/** Name to record an Antigravity tool call under: host tools take their Exocortex name. */
export function exocortexNameForAntigravity(name: string): string {
  const prefix = hostToolPrefix();
  if (!name.startsWith(prefix)) return name;
  const bare = name.slice(prefix.length);
  return isClaudeCodeHostTool(bare) ? bare : name;
}

/** Labels for calls with no Exocortex counterpart. Plain strings: the tools above are an import cycle at load time. */
const LABELS: Record<string, string> = {
  search_web: "Search",
  generate_image: "Image",
  command_status: "Command",
  send_command_input: "Command",
  invoke_subagent: "Agent",
  wait: "Wait",
  wait_5_seconds: "Wait",
};

function oneLine(value: unknown): string {
  if (typeof value !== "string") return "";
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** The most telling string input, so a call never shows just its name. */
function genericDetail(input: Input): string {
  for (const key of ["toolSummary", "Query", "Url", "Prompt", "Description", "CommandId", ...PATH_KEYS]) {
    const line = oneLine(input[key]);
    if (line) return line;
  }
  for (const value of Object.values(input)) {
    const line = oneLine(value);
    if (line) return line;
  }
  return "";
}

/** Summary for an Antigravity tool call, in its Exocortex counterpart's format when it has one. */
export function summarizeAntigravityTool(name: string, input: Input): ToolSummary {
  if (isClaudeCodeHostTool(name)) {
    const host = getRegisteredTools().find(tool => tool.name === name);
    if (host) return host.summarize(input);
  }
  if (name.startsWith("mcp_")) {
    const [, server = "mcp", ...rest] = name.split("_");
    return { label: server, detail: [rest.join("_"), genericDetail(input)].filter(Boolean).join(" ") };
  }
  const equivalent = antigravityEquivalent(name, input);
  if (equivalent) {
    const summary = equivalent.tool.summarize(equivalent.input);
    return name === "list_dir" ? { ...summary, label: "List" } : summary;
  }
  return { label: LABELS[name] ?? name, detail: genericDetail(input) };
}

/** TUI display entries for Antigravity tools styled like an Exocortex tool. */
export function getAntigravityToolDisplayInfo(): ToolDisplayInfo[] {
  const styled: [string, Tool, string?][] = [
    ["run_command", bash], ["command_status", bash, "Command"], ["send_command_input", bash, "Command"],
    ["read_file", read], ["view_file", read], ["list_dir", read, "List"],
    ["write_to_file", write],
    ["replace_file_content", edit], ["multi_replace_file_content", edit], ["sed_file", edit], ["notebook_edit", edit],
    ["grep_search", grep], ["find_by_name", glob],
    ["read_url_content", browse], ["search_web", browse, "Search"],
  ];
  return styled.map(([name, tool, label]) => ({ name, label: label ?? tool.display.label, color: tool.display.color }));
}
