import { describe, expect, test } from "bun:test";
import { getExocortexAllowedToolNames, normalizeClaudeToolName } from "./mcp-tools";

describe("Anthropic Exocortex MCP bridge", () => {
  test("exposes allowed MCP tool names for the registered Exocortex tools", () => {
    const toolNames = getExocortexAllowedToolNames();
    expect(toolNames).toContain("mcp__exocortex__bash");
    expect(toolNames).toContain("mcp__exocortex__browse");
    expect(toolNames).toContain("mcp__exocortex__context");
  });

  test("normalizes Exocortex MCP names back to plain tool names", () => {
    expect(normalizeClaudeToolName("mcp__exocortex__bash")).toBe("bash");
    expect(normalizeClaudeToolName("mcp__exocortex__browse")).toBe("browse");
    expect(normalizeClaudeToolName("Bash")).toBe("Bash");
  });
});
