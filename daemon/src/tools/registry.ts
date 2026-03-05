/**
 * Tool registry — collects all tools and provides accessors.
 *
 * Adding a new tool: import it, add to TOOLS array. Done.
 */

import type { Tool, ToolResult, ToolSummary } from "./types";
import type { ToolDisplayInfo } from "@exocortex/shared/messages";
import type { ApiToolCall } from "../api";
import { bash } from "./bash";
import { read } from "./read";
import { write } from "./write";
import { glob } from "./glob";

// ── Registry ───────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  bash,
  read,
  write,
  glob,
];

const toolMap = new Map<string, Tool>(TOOLS.map(t => [t.name, t]));

// ── API tool definitions (sent to Anthropic) ───────────────────────

export function getToolDefs(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  return TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

// ── Display info (sent to TUI on connect) ──────────────────────────

export function getToolDisplayInfo(): ToolDisplayInfo[] {
  return TOOLS.map(t => ({
    name: t.name,
    label: t.display.label,
    color: t.display.color,
  }));
}

// ── System prompt hints ────────────────────────────────────────────

export function buildToolSystemHints(): string {
  return TOOLS
    .filter(t => t.systemHint)
    .map(t => t.systemHint!)
    .join("\n");
}

// ── Summarize a tool call ──────────────────────────────────────────

export function summarizeTool(name: string, input: Record<string, unknown>): ToolSummary {
  const tool = toolMap.get(name);
  if (!tool) return { label: name, detail: "" };
  return tool.summarize(input);
}

// ── Build executor (injected into the agent loop) ──────────────────

export interface ExecResult {
  toolCallId: string;
  toolName: string;
  output: string;
  isError: boolean;
  image?: { mediaType: string; base64: string };
}

export function buildExecutor(): (calls: ApiToolCall[]) => Promise<ExecResult[]> {
  return async (calls) => {
    const results: ExecResult[] = [];
    for (const call of calls) {
      const tool = toolMap.get(call.name);
      let result: ToolResult;
      if (!tool) {
        result = { output: `Unknown tool: ${call.name}`, isError: true };
      } else {
        try {
          result = await tool.execute(call.input);
        } catch (err) {
          result = { output: `Tool error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }
      results.push({
        toolCallId: call.id,
        toolName: call.name,
        output: result.output,
        isError: result.isError,
        image: result.image,
      });
    }
    return results;
  };
}
