#!/usr/bin/env bun
/**
 * A stand-in for `agy acp` in tests: enough ACP to drive GeminiProcess.
 *
 * session/prompt behaves by the prompt's text:
 * - "host <tool> <json>": calls that tool on the session's MCP server (the
 *   real mcp-bridge.ts), announced as `mcp_exocortex_<tool>` like the CLI.
 * - "shell": a run_command tool round, then a reply.
 * - "slow": waits for session/cancel and ends `cancelled`.
 * - anything else: thinks, then echoes it back.
 */

export {};

if (process.argv.includes("--version")) {
  console.log("1.5.14");
  process.exit(0);
}
if (process.argv.includes("models")) {
  if (process.env.FAKE_AGY_SIGNED_OUT) {
    console.log("Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.");
    process.exit(1);
  }
  console.log(["Fetching available models...", "gemini-4-neon-high\tGemini 4 Neon (High)", "gemini-4-neon-low\tGemini 4 Neon (Low)", "gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)", "claude-opus-5-5-high\tClaude Opus 5.5 (High)"].join("\n"));
  process.exit(0);
}

type Json = Record<string, unknown>;
const out = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (sessionId: string, body: Json) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });

const sessions = new Map<string, { mcp: Json[]; model: string; level: string }>();
let cancelled: (() => void) | null = null;

function configOptions(model: string, level: string): Json[] {
  return [
    { id: "model", type: "select", currentValue: model, options: [{ value: "gemini-4-neon" }, { value: "gemini-4-hydrogen" }] },
    { id: "thought_level", type: "select", currentValue: level, options: [{ value: "low" }, { value: "high" }] },
  ];
}

async function callMcp(server: Json, tool: string, args: Json): Promise<string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  for (const entry of (server.env as { name: string; value: string }[]) ?? []) env[entry.name] = entry.value;
  const proc = Bun.spawn([String(server.command), ...((server.args as string[]) ?? [])], { env, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  let buffer = "";
  const next = async (): Promise<Json> => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return JSON.parse(line) as Json;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("MCP server closed");
      buffer += new TextDecoder().decode(value);
    }
  };
  const send = (message: Json) => { proc.stdin.write(`${JSON.stringify(message)}\n`); proc.stdin.flush(); };
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  await next();
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listed = await next();
  const names = (((listed.result as Json).tools as Json[]) ?? []).map(t => t.name);
  if (!names.includes(tool)) throw new Error(`no ${tool} in ${names.join(",")}`);
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool, arguments: { ...args, toolSummary: "added by the CLI" } } });
  const called = await next();
  proc.kill();
  return (((called.result as Json).content as Json[])[0].text as string);
}

async function prompt(id: unknown, params: Json): Promise<void> {
  const sessionId = String(params.sessionId);
  const session = sessions.get(sessionId)!;
  const text = ((params.prompt as Json[]).find(b => b.type === "text")?.text as string | undefined) ?? "";
  const images = (params.prompt as Json[]).filter(b => b.type === "image").length;
  const done = (stopReason = "end_turn") => out({ jsonrpc: "2.0", id, result: { stopReason, usage: { inputTokens: 100, outputTokens: 7, cachedReadTokens: 50, thoughtTokens: 3 } } });
  if (text.startsWith("host ")) {
    const [, tool, json] = /^host (\S+) (.*)$/s.exec(text) ?? [];
    const args = JSON.parse(json || "{}") as Json;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_host_1", name: `mcp_exocortex_${tool}`, rawInput: { ...args, toolSummary: "x" }, status: "in_progress" });
    const result = await callMcp(session.mcp[0], tool, args);
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_host_1", name: `mcp_exocortex_${tool}`, status: "completed" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `tool said: ${result}` } });
    done();
    return;
  }
  if (text.includes("shell")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_sh_1", name: "run_command", rawInput: { CommandLine: "echo hi", toolSummary: "Echo" }, status: "in_progress", kind: "execute" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_sh_1", name: "run_command", status: "completed", rawOutput: { output: "hi\n", exit_code: 0 }, content: [{ type: "content", content: { type: "text", text: "Command output:\nhi\n" } }] });
    update(sessionId, { sessionUpdate: "usage_update", used: 1234, size: 1048576 });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ran it" } });
    done();
    return;
  }
  if (text.includes("slow")) {
    await new Promise<void>(resolve => { cancelled = resolve; });
    done("cancelled");
    return;
  }
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo(${session.model}/${session.level}, images=${images}): ` } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  done();
}

let counter = 0;
async function handle(message: Json): Promise<void> {
  const { id, method } = message;
  const params = (message.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      out({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } } });
      return;
    case "session/new": {
      const sessionId = `fake-session-${++counter}`;
      sessions.set(sessionId, { mcp: (params.mcpServers as Json[]) ?? [], model: "gemini-4-neon", level: "high" });
      out({ jsonrpc: "2.0", id, result: { sessionId, configOptions: configOptions("gemini-4-neon", "high"), _meta: { antigravity: { tier: { name: "Google AI Pro" } } } } });
      return;
    }
    case "session/load": {
      const sessionId = String(params.sessionId);
      if (sessionId.startsWith("missing")) {
        out({ jsonrpc: "2.0", id, error: { code: -32602, message: "conversation not found" } });
        return;
      }
      sessions.set(sessionId, { mcp: (params.mcpServers as Json[]) ?? [], model: "gemini-4-neon", level: "high" });
      out({ jsonrpc: "2.0", id, result: { configOptions: configOptions("gemini-4-neon", "high") } });
      return;
    }
    case "session/set_config_option": {
      const session = sessions.get(String(params.sessionId))!;
      if (params.configId === "model") session.model = String(params.value);
      if (params.configId === "thought_level") session.level = String(params.value);
      out({ jsonrpc: "2.0", id, result: { configOptions: configOptions(session.model, session.level) } });
      return;
    }
    case "session/prompt":
      await prompt(id, params);
      return;
    case "session/cancel":
      cancelled?.();
      cancelled = null;
      return;
    default:
      if (id !== undefined) out({ jsonrpc: "2.0", id, error: { code: -32601, message: `no ${String(method)}` } });
  }
}

let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) void handle(JSON.parse(line) as Json);
  }
}
