import { randomUUID } from "crypto";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getRegisteredTools } from "../../tools/registry";
import type { Tool } from "../../tools/types";
import type { StreamToolExecutionResult, StreamToolExecutor } from "../types";

const EXOCORTEX_MCP_SERVER_NAME = "exocortex";
const EXOCORTEX_MCP_TOOL_NAME_PREFIX = `mcp__${EXOCORTEX_MCP_SERVER_NAME}__`;

type McpExecutor = StreamToolExecutor;

function getRegisteredExocortexTools(): Tool[] {
  return getRegisteredTools();
}

function toZodProperty(schema: Record<string, unknown>, required: boolean): z.ZodTypeAny {
  const type = schema.type;
  const description = typeof schema.description === "string" ? schema.description : undefined;
  const enumValues = Array.isArray(schema.enum) ? schema.enum.filter((value): value is string => typeof value === "string") : null;

  let base: z.ZodTypeAny;
  if (enumValues && enumValues.length > 0) {
    base = z.enum(enumValues as [string, ...string[]]);
  } else if (type === "string") {
    base = z.string();
  } else if (type === "number" || type === "integer") {
    base = z.number();
  } else if (type === "boolean") {
    base = z.boolean();
  } else {
    base = z.any();
  }

  if (description) base = base.describe(description);
  return required ? base : base.optional();
}

function toZodShape(inputSchema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const properties = inputSchema.properties && typeof inputSchema.properties === "object"
    ? inputSchema.properties as Record<string, Record<string, unknown>>
    : {};
  const requiredSet = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((value): value is string => typeof value === "string")
      : [],
  );

  return Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => [name, toZodProperty(schema, requiredSet.has(name))]),
  );
}

function toMcpCallToolResult(result: StreamToolExecutionResult): {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError: boolean;
} {
  return {
    content: [
      { type: "text", text: result.output },
      ...(result.image
        ? [{ type: "image" as const, data: result.image.base64, mimeType: result.image.mediaType }]
        : []),
    ],
    isError: result.isError,
  };
}

function buildMcpToolDefinition(definition: Tool, execute: McpExecutor) {
  return tool(
    definition.name,
    definition.description,
    toZodShape(definition.inputSchema),
    async (args) => toMcpCallToolResult(await execute({
      id: randomUUID(),
      name: definition.name,
      input: args as Record<string, unknown>,
    })),
  );
}

export function createExocortexMcpServer(execute: McpExecutor): McpSdkServerConfigWithInstance {
  const tools = getRegisteredExocortexTools();
  return createSdkMcpServer({
    name: EXOCORTEX_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: tools.map((toolDef) => buildMcpToolDefinition(toolDef, execute)),
  });
}

export function getExocortexAllowedToolNames(): string[] {
  return getRegisteredExocortexTools().map((toolDef) => `${EXOCORTEX_MCP_TOOL_NAME_PREFIX}${toolDef.name}`);
}

/**
 * MCP tool names are fully qualified in Claude's runtime context
 * (`mcp__exocortex__bash`). We normalize them back to the plain Exocortex
 * tool names for the UI, persisted conversation blocks, and summaries.
 */
export function normalizeClaudeToolName(name: string): string {
  return name.startsWith(EXOCORTEX_MCP_TOOL_NAME_PREFIX) ? name.slice(EXOCORTEX_MCP_TOOL_NAME_PREFIX.length) : name;
}
