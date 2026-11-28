#!/usr/bin/env bun
/**
 * A stand-in for `agy acp` in tests: enough ACP to drive GeminiProcess.
 *
 * session/prompt behaves by the prompt's text:
 * - "host <tool> <json>": calls that tool on the session's MCP server (the
 *   real mcp-bridge.ts), announced as `mcp_exocortex_<tool>` like the CLI.
 * - "shell": a run_command tool round, then a reply.
 * - "slow": waits for session/cancel and ends `cancelled`.
 * - "background <ms>": a run_command the CLI moves to the background (logged
 *   in the session's transcript, as the CLI does), finishing after <ms>.
 * - "stop-tool": a run_command that is still running when the turn is
 *   cancelled, which the CLI then reports failed with no output.
 * - "edits": edit_file and write_file rounds with ACP diffs, and a tool
 *   Exocortex has no entry for.
 * - anything else: thinks, then echoes it back.
 *
 * FAKE_AGY_QUOTA_FILE: a file holding `{"resetAt": <epoch ms>}`. Until then
 * every prompt is refused as the real CLI refuses it at the plan's limit
 * (test-fixtures/quota-refusal.acp.jsonl, recorded Nov 28 2026): one
 * "\n⚠ … Resets in XhYmZs.\n" text chunk and `end_turn` with no usage. A
 * prompt containing "quota-work" first runs a tool round and writes a line.
 * `"duration": false` leaves the reset time out of the message; `"hold": true`
 * keeps refusing past `resetAt` until the file goes (tests release it). Run with no
 * arguments (in a terminal) it shows the `/usage` screen, spent while refused.
 * FAKE_AGY_MODELS_TIMEOUT: `agy models` gives up as it does offline.
 * FAKE_AGY_OFFLINE: sessions come up without a model list, as offline.
 * EXOCORTEX_AGY_STATE_DIR: where session transcripts are written.
 * FAKE_AGY_PROMPT_LOG: each prompt's text is appended there, one JSON line each.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export {};

if (process.argv.includes("--version")) {
  console.log("1.5.14");
  process.exit(0);
}
if (process.argv.includes("models")) {
  if (process.env.FAKE_AGY_MODELS_TIMEOUT) {
    console.log("Fetching available models...\nError: timed out waiting for available models");
    process.exit(1);
  }
  if (process.env.FAKE_AGY_SIGNED_OUT) {
    console.log("Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.");
    process.exit(1);
  }
  console.log(["Fetching available models...", "gemini-4-neon-high\tGemini 4 Neon (High)", "gemini-4-neon-low\tGemini 4 Neon (Low)", "gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)", "claude-opus-5-5-high\tClaude Opus 5.5 (High)"].join("\n"));
  process.exit(0);
}

type Json = Record<string, unknown>;

/** The refusal in force, if any. */
function quotaRefusal(): { resetAt: number; duration: boolean } | null {
  const file = process.env.FAKE_AGY_QUOTA_FILE;
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { resetAt?: number; duration?: boolean; hold?: boolean };
    if (typeof parsed.resetAt !== "number" || (parsed.resetAt <= Date.now() && !parsed.hold)) return null;
    return { resetAt: parsed.resetAt, duration: parsed.duration !== false };
  } catch {
    return null;
  }
}

/** "4h11m33s", as the CLI writes it. */
function hms(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${h ? `${h}h` : ""}${h || m ? `${m}m` : ""}${sec}s`;
}

if (process.argv.length <= 2) {
  // Interactive: enough of the CLI's screen for usage.ts to read /usage.
  process.stdout.write("Antigravity CLI\r\n? for shortcuts\r\n");
  let typed = "";
  for await (const chunk of Bun.stdin.stream()) {
    typed += new TextDecoder().decode(chunk);
    if (!/\/usage[\r\n]/.test(typed)) continue;
    const refused = quotaRefusal();
    const left = refused ? Math.max(0, refused.resetAt - Date.now()) : 0;
    const five = refused ? `[          ] 0.00%\r\nRefreshes in ${Math.floor(left / 3_600_000)}h ${Math.floor((left % 3_600_000) / 60_000)}m` : "[██████████] 100.00%\r\nQuota available";
    process.stdout.write(["└ Models & Quota", "  Account: someone@example.com", "GEMINI MODELS", "  Weekly Limit Remaining", "[██████████] 80.00%", "Refreshes in 100h 5m", "  Five Hour Limit Remaining", five, ""].join("\r\n"));
    typed = "";
  }
  process.exit(0);
}

const out = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (sessionId: string, body: Json) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });

const sessions = new Map<string, { mcp: Json[]; model: string; level: string }>();
let cancelled: (() => void) | null = null;
let step = 0;

/** Log a step in the session's transcript, as the CLI does. */
function logStep(sessionId: string, body: Json): number {
  const index = ++step;
  const root = process.env.EXOCORTEX_AGY_STATE_DIR;
  if (!root) return index;
  const path = join(root, "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ step_index: index, source: "MODEL", status: "DONE", created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), ...body })}\n`);
  return index;
}

const waitForCancel = () => new Promise<void>(resolve => { cancelled = resolve; });

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
  if (process.env.FAKE_AGY_PROMPT_LOG) appendFileSync(process.env.FAKE_AGY_PROMPT_LOG, `${JSON.stringify({ at: new Date().toISOString(), sessionId, text })}\n`);
  const done = (stopReason = "end_turn") => out({ jsonrpc: "2.0", id, result: { stopReason, usage: { inputTokens: 100, outputTokens: 7, cachedReadTokens: 50, thoughtTokens: 3 } } });
  const refused = quotaRefusal();
  if (refused) {
    if (text.includes("quota-work")) {
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_q_1", name: "run_command", rawInput: { CommandLine: "echo before", toolSummary: "Echo" }, status: "in_progress", kind: "execute" });
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_q_1", name: "run_command", status: "completed", rawOutput: { output: "before\n", exit_code: 0 }, content: [{ type: "content", content: { type: "text", text: "before\n" } }] });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Before the limit." } });
    }
    update(sessionId, { sessionUpdate: "usage_update", used: 0, size: 1048576 });
    const resets = refused.duration ? ` Resets in ${hms(refused.resetAt - Date.now())}.` : "";
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits.${resets}\n` } });
    out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }
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
  if (text.startsWith("background ")) {
    const ms = Number(text.split(" ")[1]);
    const input = { CommandLine: "make long-job", WaitMsBeforeAsync: 30, toolSummary: "Build" };
    // The model call that makes the tool call takes a moment.
    await Bun.sleep(20);
    logStep(sessionId, { type: "PLANNER_RESPONSE", output_tokens: 40, tool_calls: [{ name: "run_command", args: input }] });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_bg_1", name: "run_command", rawInput: input, status: "in_progress", kind: "execute" });
    await Bun.sleep(40);
    const root = process.env.EXOCORTEX_AGY_STATE_DIR ?? "/nowhere";
    const index = step + 1;
    const log = join(root, "brain", sessionId, ".system_generated", "tasks", `task-${index}.log`);
    logStep(sessionId, { type: "GENERIC", content: `Created At: now\nTool is running as a background task with task id: ${sessionId}/task-${index}\nTask Description: make long-job\nTask logs are available at: file://${log}\nLog output:\n` });
    logStep(sessionId, { type: "PLANNER_RESPONSE", output_tokens: 6 });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "launched; waiting" } });
    if (text.includes("then-wait")) {
      // The agent waits on the task with Exocortex's chrono as soon as it hears of it.
      const args = { action: "wait", task_id: `${sessionId}/task-${index}`, max_wait: "1m" };
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_wait_1", name: "mcp_exocortex_chrono", rawInput: args, status: "in_progress" });
      const said = await callMcp(session.mcp[0], "chrono", args);
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_wait_1", name: "mcp_exocortex_chrono", status: "completed", content: [{ type: "content", content: { type: "text", text: said } }] });
    }
    await Bun.sleep(ms);
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_bg_1", name: "run_command", status: "completed", kind: "execute", rawOutput: { output: "Command exited with code 0.\n\nCommand output:\nbuilt\n", exit_code: 0 }, content: [{ type: "content", content: { type: "text", text: "Command exited with code 0.\n\nCommand output:\nbuilt\n" } }] });
    await Bun.sleep(20);
    logStep(sessionId, { type: "PLANNER_RESPONSE", output_tokens: 5 });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "built it" } });
    out({ jsonrpc: "2.0", id, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 51, cachedReadTokens: 0, thoughtTokens: 0 } } });
    return;
  }
  if (text.includes("stop-tool")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_stop_1", name: "run_command", rawInput: { CommandLine: "sleep 600", WaitMsBeforeAsync: 5000 }, status: "in_progress", kind: "execute" });
    await waitForCancel();
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_stop_1", name: "run_command", status: "failed", kind: "execute" });
    done("cancelled");
    return;
  }
  if (text.includes("edits")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_ed_1", name: "edit_file", rawInput: { Path: "/w/a.txt", Target: "beta", Replacement: "gamma" }, status: "in_progress", kind: "edit" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_ed_1", name: "edit_file", status: "completed", kind: "edit", rawOutput: {}, content: [{ type: "diff", path: "/w/a.txt", oldText: "alpha\nbeta\n", newText: "alpha\ngamma\n" }] });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_wr_1", name: "write_file", rawInput: { Path: "/w/b.txt", Content: "one\ntwo\n" }, status: "in_progress", kind: "edit" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_wr_1", name: "write_file", status: "completed", kind: "edit", rawOutput: {}, content: [{ type: "diff", path: "/w/b.txt", newText: "one\ntwo\n" }] });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call_un_1", name: "frobnicate_files", rawInput: { Query: "needle" }, status: "in_progress", kind: "search" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call_un_1", name: "frobnicate_files", status: "completed", kind: "search", rawOutput: { output: "found" } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "edited" } });
    done();
    return;
  }
  if (text.includes("slow")) {
    await waitForCancel();
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
      const sessionId = `fake-session-${process.pid}-${++counter}`;
      sessions.set(sessionId, { mcp: (params.mcpServers as Json[]) ?? [], model: "gemini-4-neon", level: "high" });
      if (process.env.FAKE_AGY_OFFLINE) {
        out({ jsonrpc: "2.0", id, result: { sessionId, configOptions: [{ id: "mode", type: "select", currentValue: "default", options: [{ value: "default" }] }] } });
        return;
      }
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
      if (process.env.FAKE_AGY_OFFLINE && params.configId === "model") {
        out({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown model ID: ${String(params.value)}` } });
        return;
      }
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
