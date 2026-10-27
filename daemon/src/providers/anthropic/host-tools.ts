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
import { CLAUDE_CODE_HOST_TOOL_SERVER, isClaudeCodeHostTool } from "../../tools/claude-code";
import { exo } from "../../tools/exo";
import { CLAUDE_CODE_INLINE_CHRONO_MAX_MS } from "../../tools/chrono-limits";
import { toolText } from "../../tools/tool-text";
import { claudeSdks } from "./sdk";
import { rememberHostToolAttachments } from "./host-tool-attachments";

/** Chrono runs sleeps and waits inside the call; leave room past the longest. */
const HOST_TOOL_TIMEOUT_MS = CLAUDE_CODE_INLINE_CHRONO_MAX_MS + 10 * 60_000;

/**
 * Host tools whose MCP server instructions end with their system hint, the
 * text other providers get under # Internal tools.
 */
const INSTRUCTIONS_WITH_HINT: Record<string, () => string | undefined> = {
  exo: () => exo.systemHint,
};

/** The MCP server instructions a host tool contributes (its <tool>.mcp.md, then any shared hint), if any. */
export function hostToolInstructions(name: string): string | undefined {
  return [toolText(name, "mcp"), INSTRUCTIONS_WITH_HINT[name]?.()].filter(Boolean).join("\n") || undefined;
}

/** Whether a host tool's MCP server instructions end with its system hint. */
export function hostToolInstructionsIncludeHint(name: string): boolean {
  return Object.hasOwn(INSTRUCTIONS_WITH_HINT, name);
}

/**
 * What a Claude Code process is started with that a later turn may need
 * changed: the system prompt addition, and the host tools' descriptions and
 * server instructions (/instructions tools edits them). Compared by
 * fingerprint, never sent.
 */
export function claudeProcessPrompt(systemAppend: string, tools: readonly { name: string; description: string }[]): string {
  if (tools.length === 0) return systemAppend;
  const text = tools.map(tool => [tool.name, tool.description, hostToolInstructions(tool.name) ?? ""]);
  return `${systemAppend}\u0000${JSON.stringify(text)}`;
}

/** The Exocortex turn a host tool call runs under. */
export interface HostToolBinding {
  execute: ToolExecutor;
  signal?: AbortSignal;
}

interface ToolDef {
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

  const instructions = defs.flatMap(def => hostToolInstructions(def.name) ?? []).join("\n\n");
  const { mcpServer: { McpServer }, mcpTypes: { CallToolRequestSchema, ListToolsRequestSchema } } = claudeSdks();
  const server = new McpServer(
    { name: CLAUDE_CODE_HOST_TOOL_SERVER, version: "1.0.0" },
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

  return { type: "sdk", name: CLAUDE_CODE_HOST_TOOL_SERVER, timeout: HOST_TOOL_TIMEOUT_MS, instance: server };
}
