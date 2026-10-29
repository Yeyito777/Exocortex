#!/usr/bin/env bun
/**
 * Paid, worktree-only: how many Claude Code turns reuse their running process.
 *
 * Two Haiku conversations each take a first turn, then follow-ups after the
 * given gaps (seconds, default 8,40,100,200,400), both at once. The daemon's
 * log says which turns ran in their running process and which started a new
 * one; the time to the first text of each turn shows what a new process costs.
 *
 *   scripts/dev/testd start <worktree>
 *   bun scripts/dev/claude-process-reuse.ts --live [8,40,100]
 */
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeDir, socketPath, worktreeName } from "../../shared/src/paths";
import type { Command } from "../../shared/src/protocol";

assert(worktreeName(), "Run from a worktree, never main.");
assert(process.argv[2] === "--live", "Use --live to authorize the short Haiku turns.");
const gaps = (process.argv[3] ?? "8,40,100,200,400").split(",").map(Number);
assert(gaps.every(gap => Number.isFinite(gap) && gap >= 0), "Gaps are seconds, comma-separated.");
const logPath = join(runtimeDir(), "exocortex.log");
const logStart = readFileSync(logPath, "utf8").length;

const socket = net.connect(socketPath());
await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
let buffer = "", serial = 0;
const pending = new Map<string, (event: any) => void>();
const observers = new Map<string, { firstText?: number; resolve: (event: any) => void }>();
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
  const reqId = `reuse-${Date.now()}-${++serial}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(reqId); reject(new Error(`IPC timeout ${command.type}; inspect before retrying`)); }, 30_000);
    pending.set(reqId, event => { clearTimeout(timeout); resolve(event); });
    socket.write(JSON.stringify({ ...command, reqId }) + "\n");
  });
}

async function turn(convId: string, text: string): Promise<number> {
  let resolve!: (event: any) => void;
  const done = new Promise<any>(r => { resolve = r; });
  const observer: { firstText?: number; resolve: (event: any) => void } = { resolve };
  observers.set(convId, observer);
  const started = performance.now();
  const accepted = await request({ type: "send_message", convId, startedAt: Date.now(), detached: true, text });
  assert.notEqual(accepted.type, "error", JSON.stringify(accepted));
  let timer: ReturnType<typeof setTimeout>;
  const completed = await Promise.race([done, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Turn wait expired; inspect ${convId}, do not retry submission`)), 180_000);
  })]).finally(() => clearTimeout(timer));
  observers.delete(convId);
  assert.equal(completed.type, "message_complete", JSON.stringify(completed));
  return (observer.firstText ?? performance.now()) - started;
}

async function conversation(index: number): Promise<{ convId: string; ttft: number[] }> {
  const convId = `${Date.now()}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
  const created = await request({ type: "new_conversation", convId, provider: "anthropic", model: "claude-haiku-5-5", effort: "low", title: `Process reuse ${index}` });
  assert.equal(created.type, "conversation_created", JSON.stringify(created));
  await request({ type: "subscribe", convId });
  const ttft = [await turn(convId, "Reply with exactly READY. Do not use tools.")];
  for (const gap of gaps) {
    await Bun.sleep(gap * 1000);
    ttft.push(await turn(convId, `After ${gap} s: reply with exactly READY. Do not use tools.`));
  }
  return { convId, ttft };
}

try {
  const runs = await Promise.all([conversation(1), conversation(2)]);
  const log = readFileSync(logPath, "utf8").slice(logStart);
  for (const { convId, ttft } of runs) {
    const lines = log.split("\n").filter(line => line.includes(convId) && /Claude Code turn (in its running process|\(model)/.test(line));
    const kinds = lines.map(line => line.includes("running process") ? "reused" : "new");
    console.log(JSON.stringify({ convId, gaps: [null, ...gaps], process: kinds, firstTextMs: ttft.map(Math.round) }));
  }
  const all = log.split("\n").filter(line => runs.some(run => line.includes(run.convId)));
  const reused = all.filter(line => line.includes("Claude Code turn in its running process")).length;
  const fresh = all.filter(line => line.includes("Claude Code turn (model")).length;
  console.log(`follow-ups reused: ${reused} of ${reused + fresh - runs.length}; new processes: ${fresh}`);
  for (const { convId } of runs) socket.write(JSON.stringify({ type: "delete_conversation", convId }) + "\n");
  await request({ type: "list_conversations" });
} finally {
  socket.destroy();
}
