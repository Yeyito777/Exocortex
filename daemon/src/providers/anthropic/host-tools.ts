/**
 * Exocortex tools offered to Claude Code as an in-process MCP server.
 *
 * Claude Code sees them as `mcp__exocortex__<name>`. Calls run through the
 * Exocortex tool executor of the turn showing them, so they keep the
 * conversation context, safety checks and Tasks UI entries they get under
 * other providers. A Claude Code process can outlive a turn (see session.ts),
 * so the executor is looked up per call.
 */

import { randomUUID } from "node:crypto";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolExecutor } from "../../agent";
import { CLAUDE_CODE_APP_TOOL_SERVER, CLAUDE_CODE_HOST_TOOL_SERVER, isClaudeCodeHostTool } from "../../tools/claude-code";
import { CLAUDE_CODE_INLINE_CHRONO_MAX_MS } from "../../tools/chrono-limits";
import { toolText } from "../../tools/tool-text";
import { claudeSdks } from "./sdk";
import { rememberHostToolAttachments } from "./host-tool-attachments";

/** Chrono runs sleeps and waits inside the call; leave room past the longest. */
const HOST_TOOL_TIMEOUT_MS = CLAUDE_CODE_INLINE_CHRONO_MAX_MS + 10 * 60_000;

/** A host tool's hint, which Claude Code gets as part of the MCP server instructions, if it has one. */
export function hostToolInstructions(name: string): string | undefined {
  return toolText(name, "hint", "anthropic") || undefined;
}

/** The MCP server instructions: each offered host tool's hint under its name, as # Internal tools does elsewhere. */
export function hostToolServerInstructions(tools: readonly { name: string }[]): string {
  return tools.flatMap(tool => {
    const hint = hostToolInstructions(tool.name);
    return hint ? [`### ${tool.name}\n${hint}`] : [];
  }).join("\n\n");
}

/**
 * What a Claude Code process is started with that a later turn may need
 * changed: the system prompt addition, and the host tools' descriptions and
 * server instructions (/instructions tools edits them). Compared by
 * fingerprint, never sent.
 */
export function claudeProcessPrompt(systemAppend: string, tools: readonly { name: string; description: string }[]): string {
  if (tools.length === 0) return systemAppend;
  const text = tools.map(tool => [tool.name, tool.description]);
  return `${systemAppend}\u0000${JSON.stringify([text, hostToolServerInstructions(tools)])}`;
}

/** The Exocortex turn a host tool call runs under. */
export interface HostToolBinding {
  execute: ToolExecutor;
  signal?: AbortSignal;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

function isToolDef(value: unknown): value is ToolDef {
  const def = value as ToolDef | null;
  return typeof def?.name === "string" && typeof def.description === "string" && typeof def.input_schema === "object" && def.input_schema !== null;
}

function textResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

/** The host tools in an Exocortex tool surface. */
export function hostToolDefs(tools: unknown[] | undefined): ToolDef[] {
  return (tools ?? []).filter(isToolDef).filter(def => isClaudeCodeHostTool(def.name))
    .map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/** MCP server for the host tools in the Exocortex tool surface, or null if there are none. */
export function createHostToolServer(
  tools: unknown[] | undefined,
  binding: (() => Promise<HostToolBinding>) | null,
): McpSdkServerConfigWithInstance | null {
  const defs = hostToolDefs(tools);
  if (!binding || defs.length === 0) return null;
  return createToolServer(CLAUDE_CODE_HOST_TOOL_SERVER, defs, hostToolServerInstructions(defs), binding);
}

/**
 * MCP server for an app conversation's own tools (docs/app-api.md), or null
 * if it has none. Calls run through the turn's executor like host tools,
 * which forwards them to the app.
 */
export function createAppToolServer(
  defs: readonly ToolDef[],
  binding: (() => Promise<HostToolBinding>) | null,
): McpSdkServerConfigWithInstance | null {
  if (!binding || defs.length === 0) return null;
  return createToolServer(CLAUDE_CODE_APP_TOOL_SERVER, defs, "", binding);
}

function createToolServer(
  name: string,
  defs: readonly ToolDef[],
  instructions: string,
  binding: () => Promise<HostToolBinding>,
): McpSdkServerConfigWithInstance {
  const { mcpServer: { McpServer }, mcpTypes: { CallToolRequestSchema, ListToolsRequestSchema } } = claudeSdks();
  const server = new McpServer(
    { name, version: "1.0.0" },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
  );
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: defs.map(def => ({
      name: def.name,
      description: def.description,
      inputSchema: def.input_schema as { type: "object" },
      // Keep it in the model's tool list instead of behind Claude Code's tool search.
      _meta: { "anthropic/alwaysLoad": true },
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name } = request.params;
    if (!defs.some(def => def.name === name)) return textResult(`Unknown tool: ${name}`, true);
    // Reuse Claude Code's tool_use id so Tasks UI entries match the recorded call.
    const toolUseId = request.params._meta?.["claudecode/toolUseId"];
    const id = typeof toolUseId === "string" && toolUseId ? toolUseId : `exocortex-${randomUUID()}`;
    let turn: HostToolBinding;
    try {
      turn = await binding();
    } catch (error) {
      return textResult(error instanceof Error ? error.message : String(error), true);
    }
    const [result] = await turn.execute(
      [{ id, name, input: request.params.arguments ?? {} }],
      turn.signal ? AbortSignal.any([turn.signal, extra.signal]) : extra.signal,
    );
    if (result?.attachments?.length) rememberHostToolAttachments(id, result.attachments);
    return result ? textResult(result.output, result.isError) : textResult(`${name} returned no result.`, true);
  });

  return { type: "sdk", name, timeout: HOST_TOOL_TIMEOUT_MS, instance: server };
}
