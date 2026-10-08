#!/usr/bin/env bun
/**
 * Paid live game-building benchmark, explicitly opt-in and worktree-only.
 * Start this worktree with exotest in a nested X11 environment first.
 * Usage: bun scripts/dev/profile-model-loop.ts --live baseline [model]
 */
import assert from "node:assert/strict";
import net from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { socketPath, worktreeName, conversationWorkspaceDir, diagnosticsDir } from "../../shared/src/paths";
import { performanceProfilingEnabled } from "../../shared/src/config";
import type { Command } from "../../shared/src/protocol";

assert(worktreeName(), "Live benchmarks must run in a worktree, never main.");
assert(process.argv[2] === "--live", "Use --live to authorize a real model run.");
assert(performanceProfilingEnabled(), "Enable diagnostics.performanceProfiling before starting exotest.");
const label = process.argv[3] ?? "sample";
assert(/^[a-zA-Z0-9_-]+$/.test(label), "Label must be a simple filename.");
const dir = join(diagnosticsDir(), "benchmarks");
const file = join(dir, `${label}.json`);
assert(!existsSync(file), `Benchmark label already exists: ${file}. Inspect it; choose a new label for a new run.`);
const socket = net.connect(socketPath());
await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
let buffer = "";
let serial = 0;
let convId: string | undefined;
let failure: string | undefined;
const pending = new Map<string, (event: any) => void>();
let resolveDone!: (event: any) => void;
const done = new Promise<any>(resolve => { resolveDone = resolve; });
socket.on("data", chunk => {
  buffer += String(chunk);
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const event = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (event.reqId && pending.has(event.reqId)) {
      pending.get(event.reqId)!(event);
      pending.delete(event.reqId);
    }
    if (event.convId !== convId) continue;
    if (event.type === "system_message" && event.color === "error") failure = event.text;
    if (event.type === "tool_call") console.log(`tool ${event.toolName}`);
    if (event.type === "tool_result") console.log(`result ${event.toolName} error=${event.isError}`);
    if (event.type === "message_complete" || event.type === "streaming_stopped") resolveDone(event);
  }
});
function request(command: Command): Promise<any> {
  const reqId = `profile-model-loop-${Date.now()}-${++serial}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(reqId); reject(new Error(`IPC timeout: ${command.type}; inspect state before retrying`)); }, 10_000);
    pending.set(reqId, event => { clearTimeout(timeout); resolve(event); });
    socket.write(JSON.stringify({ ...command, reqId }) + "\n");
  });
}
try {
  const created = await request({ type: "new_conversation", provider: "openai",
    model: process.argv[4] ?? "gpt-6.1-sol", effort: "high", fastMode: true,
    subagent: true, title: `Model loop benchmark ${label}` });
  assert.equal(created.type, "conversation_created", JSON.stringify(created));
  convId = created.convId;
  socket.write(JSON.stringify({ type: "subscribe", convId }) + "\n");
  await request({ type: "ping" });
  const workspace = conversationWorkspaceDir(convId!);
  const prompt = `Build a small polished dependency-free browser Snake game in your conversation workspace (${workspace}) only.
Do not modify Exocortex or any other directory. Do not delegate or use the network.
Use HTML/CSS/JavaScript, with keyboard controls, score, pause, restart and a game-over screen.
Keep the game logic in an importable module and write deterministic tests runnable with bun test.
Make this a realistic multi-step coding task: inspect your workspace, implement the game, run tests, fix any failures, inspect the final files and write a short README with how to play and test.
Actually execute the tests before finishing. Keep the response brief.`;
  const startedAt = Date.now();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ label, convId, workspace, model: created.model, startedAt, status: "running" }, null, 2));
  console.log(`conversation=${convId}\nworkspace=${workspace}\nmanifest=${file}`);
  const accepted = await request({ type: "send_message", convId: convId!, text: prompt, startedAt, detached: true });
  assert.notEqual(accepted.type, "error", JSON.stringify(accepted));
  let timeout: ReturnType<typeof setTimeout>;
  const event = await Promise.race([done, new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Benchmark wait expired; inspect/abort ${convId}, do NOT retry submission`)), 900_000);
  })]).finally(() => clearTimeout(timeout));
  writeFileSync(file, JSON.stringify({
    label, convId, workspace, model: created.model, startedAt, endedAt: Date.now(),
    status: event.type === "message_complete" ? "complete" : "stopped", failure,
    tokens: event.tokens,
  }, null, 2));
  assert.equal(event.type, "message_complete", failure ?? "Turn stopped");
  console.log(`PASS: ${label}, ${(Date.now() - startedAt) / 1000}s, tokens=${event.tokens}`);
} finally {
  socket.destroy();
}
