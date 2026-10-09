import { describe, expect, test } from "bun:test";
import { claudeCodeResultText, exocortexToolName, getClaudeCodeToolDisplayInfo, summarizeClaudeCodeTool } from "./claude-code";
import { getToolDisplayInfo, summarizeTool } from "./registry";
import { bash } from "./bash";
import { read } from "./read";
import { chrono } from "./chrono";
import { exo } from "./exo";

describe("Claude Code tool display", () => {
  test("Bash keeps the full command like Exocortex bash and drops the description", () => {
    const input = { command: "cd /tmp\ngmail search newer_than:1d", description: "Search mail", timeout: 60000 };
    expect(summarizeClaudeCodeTool("Bash", input)).toEqual({ label: "$", detail: "cd /tmp\ngmail search newer_than:1d --timeout_seconds 60" });
    expect(summarizeClaudeCodeTool("Bash", { command: "sleep 150", run_in_background: true }))
      .toEqual(bash.summarize({ command: "sleep 150", background: true }));
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
    expect(summarizeClaudeCodeTool("EnterWorktree", { name: "fix" })).toEqual({ label: "EnterWorktree", detail: "fix" });
    expect(summarizeClaudeCodeTool("ExitPlanMode", {})).toEqual({ label: "ExitPlanMode", detail: "" });
  });

  test("agent tools read like Exocortex subagent calls", () => {
    expect(summarizeClaudeCodeTool("Agent", {
      description: "Resume JS engine core", prompt: "You are resuming…", subagent_type: "general-purpose", run_in_background: true,
    })).toEqual({ label: "Agent", detail: "Resume JS engine core --background" });
    expect(summarizeClaudeCodeTool("Agent", { description: "Find callers", prompt: "…", subagent_type: "Explore" }))
      .toEqual({ label: "Agent", detail: "Find callers --subagent_type Explore" });
    expect(summarizeClaudeCodeTool("SendMessage", { to: "a2770869e8f93ef5d", summary: "Wrap up and stop for now", message: "From the lead: …" }))
      .toEqual({ label: "Message", detail: "Wrap up and stop for now --to a2770869e8f93ef5d" });
    expect(summarizeClaudeCodeTool("SendMessage", { to: "main", message: "Tests pass.\nDetails follow." }))
      .toEqual({ label: "Message", detail: "Tests pass. --to main" });
    expect(summarizeClaudeCodeTool("SendMessage", { to: "worker", notify_when_idle: true }))
      .toEqual({ label: "Message", detail: "--to worker --notify_when_idle" });
    expect(summarizeClaudeCodeTool("TaskStop", { task_id: "b8u2nm9qr" })).toEqual({ label: "TaskStop", detail: "b8u2nm9qr" });
    expect(summarizeClaudeCodeTool("Monitor", { description: "errors in deploy.log", command: "tail -f deploy.log", timeout_ms: 300000 }))
      .toEqual({ label: "Monitor", detail: "errors in deploy.log" });
  });

  test("JSON status results read as the message they carry", () => {
    const queued = JSON.stringify({ success: true, message: "Message queued for delivery to worker at its next tool round.", pin: { id: "worker" } });
    expect(claudeCodeResultText("SendMessage", queued)).toBe("Message queued for delivery to worker at its next tool round.");
    expect(claudeCodeResultText("TaskStop", JSON.stringify({ message: "Successfully stopped task: b1 (sleep 20)", task_id: "b1" })))
      .toBe("Successfully stopped task: b1 (sleep 20)");
    expect(claudeCodeResultText("SendMessage", "Error: no agent named worker")).toBe("Error: no agent named worker");
    expect(claudeCodeResultText("Bash", queued)).toBe(queued);
  });

  test("MCP tools are labeled by their server and lead with the tool", () => {
    expect(summarizeClaudeCodeTool("mcp__claude_ai_Claude_Docs__batch", { batch: [] })).toEqual({ label: "Claude Docs", detail: "batch" });
    expect(summarizeClaudeCodeTool("mcp__github__create_issue", { title: "Crash on start" })).toEqual({ label: "github", detail: "create_issue Crash on start" });
  });

  test("reloaded history summarizes Claude Code calls the same way as the live stream", () => {
    const input = { file_path: "/a.ts" };
    expect(summarizeTool("Read", input)).toEqual(summarizeClaudeCodeTool("Read", input));
  });

  test("host tools called over MCP are recorded and summarized as the Exocortex tool", () => {
    expect(exocortexToolName("mcp__exocortex__chrono")).toBe("chrono");
    expect(exocortexToolName("mcp__exocortex__goal")).toBe("goal");
    expect(exocortexToolName("mcp__exocortex__exo")).toBe("exo");
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
    expect(info.find(tool => tool.name === "SendMessage")).toEqual({ name: "SendMessage", label: "Message", color: exo.display.color });
    expect(info.some(tool => tool.name === "TaskStop")).toBe(false);
    expect(getToolDisplayInfo().some(tool => tool.name === "Bash")).toBe(true);
  });
});
