#!/usr/bin/env bun
/** Paid, worktree-only TTFT benchmark: cold vs prewarmed, real assistant text only. */
import assert from "node:assert/strict";
import net from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { socketPath, worktreeName, diagnosticsDir } from "../../shared/src/paths";
import { performanceProfilingEnabled } from "../../shared/src/config";
import type { Command } from "../../shared/src/protocol";

assert(worktreeName(), "Run from a worktree, never main.");
assert(process.argv[2] === "--live", "Use --live to authorize six short model calls.");
assert(performanceProfilingEnabled(), "Enable diagnostics.performanceProfiling before starting exotest.");
const socket = net.connect(socketPath());
await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
let buffer = "", serial = 0;
const pending = new Map<string, (event: any) => void>();
const observers = new Map<string, { started: number; firstText?: number; resolve: (event: any) => void }>();
socket.on("data", chunk => {
  buffer += String(chunk);
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const event = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const request = pending.get(event.reqId);
    if (request) { pending.delete(event.reqId); request(event); }
    const observer = observers.get(event.convId);
    if (!observer) continue;
    if (event.type === "text_chunk" && /\S/.test(event.text) && observer.firstText == null) observer.firstText = performance.now();
    if (event.type === "message_complete" || event.type === "streaming_stopped") observer.resolve(event);
  }
});
function request(command: Command): Promise<any> {
  const reqId = `ttft-${Date.now()}-${++serial}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(reqId); reject(new Error(`IPC timeout ${command.type}; inspect before retrying`)); }, 30_000);
    pending.set(reqId, event => { clearTimeout(timeout); resolve(event); });
    socket.write(JSON.stringify({ ...command, reqId }) + "\n");
  });
}
const ids: string[] = [];
const samples: unknown[] = [];
try {
  for (let pair = 0; pair < 3; pair++) {
    for (const warm of pair % 2 ? [true, false] : [false, true]) {
      const convId = `${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
      ids.push(convId);
      if (warm) {
        const ready = await request({ type: "prewarm_conversation", convId, draft: true });
        assert.equal(ready.type, "ack", JSON.stringify(ready));
        const list = await request({ type: "list_conversations" });
        assert(!list.conversations.some((conv: any) => conv.id === convId), "Draft prewarm must not create history");
      }
      const created = await request({ type: "new_conversation", convId, provider: "openai",
        model: "gpt-6.1-sol", effort: "high", fastMode: true, title: "TTFT benchmark" });
      assert.equal(created.type, "conversation_created", JSON.stringify(created));
      await request({ type: "subscribe", convId });
      let resolve!: (event: any) => void;
      const done = new Promise<any>(r => { resolve = r; });
      const observer = { started: performance.now(), firstText: undefined as number | undefined, resolve };
      observers.set(convId, observer);
      const accepted = await request({ type: "send_message", convId, startedAt: Date.now(), detached: true,
        text: "Reply with exactly READY and nothing else. Do not use tools." });
      assert.notEqual(accepted.type, "error", JSON.stringify(accepted));
      let timeout: ReturnType<typeof setTimeout>;
      const completed = await Promise.race([done, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Turn wait expired; inspect ${convId}, do not retry submission`)), 120_000);
      })]).finally(() => clearTimeout(timeout));
      assert.equal(completed.type, "message_complete");
      assert(observer.firstText != null, "No real text received");
      const sample = { pair, warm, convId, ttftMs: observer.firstText - observer.started, completedMs: performance.now() - observer.started };
      samples.push(sample);
      console.log(JSON.stringify(sample));
      observers.delete(convId);
    }
  }
  const dir = join(diagnosticsDir(), "benchmarks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `ttft-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ metric: "submit IPC -> first non-whitespace assistant text; not response.created", samples }, null, 2));
  console.log(`saved=${file}`);
  // These short test conversations own no long-running work. Preserve traces, not sidebar clutter.
  for (const convId of ids) socket.write(JSON.stringify({ type: "delete_conversation", convId }) + "\n");
  await request({ type: "list_conversations" });
} finally {
  socket.destroy();
}
