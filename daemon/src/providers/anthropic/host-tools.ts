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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolExecutor } from "../../agent";
import { CLAUDE_CODE_HOST_TOOL_SERVER, isClaudeCodeHostTool } from "../../tools/claude-code";
import { exo } from "../../tools/exo";

/** Chrono runs sleeps and waits of up to five minutes inside the call. */
const HOST_TOOL_TIMEOUT_MS = 10 * 60_000;

/** Server instructions for each offered host tool. */
const INSTRUCTIONS: Record<string, string | undefined> = {
  chrono: [
    "chrono is this conversation's scheduler. Use it instead of Bash sleep, cron, or polling loops to wait, sleep, or schedule future work.",
    "A wake with a message starts a new turn in this conversation at the scheduled time, after this turn has ended and across restarts.",
    "Sleeps and waits run inside the call for at most five minutes; for longer delays, schedule a wake with a message and end your turn.",
  ].join(" "),
  exo: `exo starts Exocortex subagents, separate from your own Agent tool.\n${exo.systemHint}`,
};

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

  const instructions = defs.flatMap(def => INSTRUCTIONS[def.name] ?? []).join("\n\n");
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
    return result ? textResult(result.output, result.isError) : textResult(`${name} returned no result.`, true);
  });

  return { type: "sdk", name: CLAUDE_CODE_HOST_TOOL_SERVER, timeout: HOST_TOOL_TIMEOUT_MS, instance: server };
}
