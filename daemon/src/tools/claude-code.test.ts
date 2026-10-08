import { describe, expect, test } from "bun:test";
import { exocortexToolName, getClaudeCodeToolDisplayInfo, summarizeClaudeCodeTool } from "./claude-code";
import { getToolDisplayInfo, summarizeTool } from "./registry";
import { bash } from "./bash";
import { read } from "./read";
import { chrono } from "./chrono";

describe("Claude Code tool display", () => {
  test("Bash keeps the full command like Exocortex bash and drops the description", () => {
    const input = { command: "cd /tmp\ngmail search newer_than:1d", description: "Search mail", timeout: 60000 };
    expect(summarizeClaudeCodeTool("Bash", input)).toEqual({ label: "$", detail: "cd /tmp\ngmail search newer_than:1d --timeout 60000" });
  });

  test("file and search tools use their Exocortex counterpart's summary", () => {
    expect(summarizeClaudeCodeTool("Read", { file_path: "/a.ts", offset: 10, limit: 5 })).toEqual({ label: "Read", detail: "/a.ts --offset 10 --limit 5" });
    expect(summarizeClaudeCodeTool("Edit", { file_path: "/a.ts", old_string: "x", new_string: "y", replace_all: true })).toEqual({ label: "Edit", detail: "/a.ts --replace_all" });
    expect(summarizeClaudeCodeTool("Write", { file_path: "/a.ts", content: "body" })).toEqual({ label: "Write", detail: "/a.ts" });
    expect(summarizeClaudeCodeTool("Grep", { pattern: "foo", path: "src", "-i": true })).toEqual({ label: "Grep", detail: "/foo/ --path src -i" });
    expect(summarizeClaudeCodeTool("WebFetch", { url: "https://x.dev", prompt: "summarize" })).toEqual({ label: "Browse", detail: "https://x.dev" });
  });

  test("tools without a counterpart get a generic one-line summary", () => {
    expect(summarizeClaudeCodeTool("WebSearch", { query: "bun test" })).toEqual({ label: "Search", detail: "bun test" });
    expect(summarizeClaudeCodeTool("ToolSearch", { query: "select:Monitor" })).toEqual({ label: "ToolSearch", detail: "select:Monitor" });
    expect(summarizeClaudeCodeTool("mcp__x__y", {})).toEqual({ label: "mcp__x__y", detail: "" });
  });

  test("reloaded history summarizes Claude Code calls the same way as the live stream", () => {
    const input = { file_path: "/a.ts" };
    expect(summarizeTool("Read", input)).toEqual(summarizeClaudeCodeTool("Read", input));
  });

  test("host tools called over MCP are recorded and summarized as the Exocortex tool", () => {
    expect(exocortexToolName("mcp__exocortex__chrono")).toBe("chrono");
    expect(exocortexToolName("mcp__exocortex__bash")).toBe("mcp__exocortex__bash");
    expect(exocortexToolName("mcp__other__chrono")).toBe("mcp__other__chrono");
    expect(exocortexToolName("Bash")).toBe("Bash");
    const input = { action: "sleep", duration: "30s" };
    expect(summarizeClaudeCodeTool("chrono", input)).toEqual(chrono.summarize(input));
  });

  test("display entries borrow the counterpart's label and color", () => {
    const info = getClaudeCodeToolDisplayInfo();
    expect(info.find(tool => tool.name === "Bash")).toEqual({ name: "Bash", ...bash.display });
    expect(info.find(tool => tool.name === "Read")).toEqual({ name: "Read", ...read.display });
    expect(getToolDisplayInfo().some(tool => tool.name === "Bash")).toBe(true);
  });
});
