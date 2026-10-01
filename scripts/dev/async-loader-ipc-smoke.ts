#!/usr/bin/env bun
/**
 * Actual daemon IPC/restart smoke against a SYNTHETIC fixture only.
 * No secrets, external-daemon supervision, provider calls, or live DB writes.
 * bun scripts/dev/async-loader-ipc-smoke.ts FIXTURE_DB ID [REPORT_JSON]
 * Seed first with profile-archive-loader.ts. Only the child PID is stopped.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { Command, Event } from "../../shared/src/protocol";
import { DAEMON_RESTART_EXIT_CODE } from "../../daemon/src/daemon-lifecycle";

const [rawFixture, id, reportPath] = process.argv.slice(2);
if (!rawFixture || !id) throw new Error("Expected SYNTHETIC_FIXTURE_DB ID [REPORT_JSON]");
const repo = resolve(import.meta.dir, "../..");
const namespace = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: repo, encoding: "utf8" }).trim().split("/").at(-1)!;
if (namespace === ".git") throw new Error("Run this smoke in a linked git worktree, never main");
const root = mkdtempSync(join(tmpdir(), "exo-async-ipc-"));
const data = join(root, "data", "instances", namespace);
mkdirSync(data, { recursive: true });
const dbPath = join(data, "exocortex.sqlite3");
const source = new Database(resolve(rawFixture), { readonly: true });
const original = source.query<{ title: string; stored_message_count: number }, [string]>(
  "SELECT title, stored_message_count FROM conversations WHERE id=?",
).get(id);
if (original?.title !== "Synthetic cold archive" || original.stored_message_count < 32_000) {
  source.close();
  rmSync(root, { recursive: true, force: true });
  throw new Error("Refusing a non-synthetic or undersized fixture");
}
// Includes any committed WAL bytes; the source is always opened readonly.
source.query("VACUUM INTO ?").run(dbPath);
const checkpoint = source.query<{ payload_json: string }, [string]>("SELECT payload_json FROM active_contexts WHERE conversation_id=?").get(id)!.payload_json;
source.close();
writeFileSync(join(root, "config.json"), JSON.stringify({
  agent: { workingDirectory: root }, diagnostics: { performanceProfiling: true },
}));
const candidate = join(root, "runtime", namespace, "exocortexd.sock");
const socketPath = Buffer.byteLength(candidate) < 104 ? candidate : join(tmpdir(),
  `exocortexd-${process.getuid?.() ?? "user"}-${createHash("sha256").update(candidate).digest("hex").slice(0, 16)}.sock`);

type Reply = { event: Event; ms: number };
class Client {
  seq = 0;
  buffer = "";
  pending = new Map<string, { resolve: (reply: Reply) => void; reject: (error: Error) => void; start: number; timer: ReturnType<typeof setTimeout>; broadcast?: Event["type"] }>();
  constructor(readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", data => {
      this.buffer += data.toString();
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const event: Event = JSON.parse(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + 1);
        // Some legacy sidebar mutations publish only an uncorrelated broadcast.
        // These actions are strictly sequential in this dedicated test client.
        const reqId = ("reqId" in event ? event.reqId : undefined)
          ?? [...this.pending].find(([, pending]) => pending.broadcast === event.type)?.[0];
        const pending = reqId ? this.pending.get(reqId) : undefined;
        if (!pending || !reqId) continue;
        this.pending.delete(reqId);
        clearTimeout(pending.timer);
        pending.resolve({ event, ms: performance.now() - pending.start });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Isolated daemon socket closed"));
      }
      this.pending.clear();
    });
  }
  request(command: Command, broadcast?: Event["type"]): Promise<Reply> {
    const reqId = `smoke-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(new Error(`Timed out: ${command.type}`)); }, 15_000);
      this.pending.set(reqId, { resolve, reject, timer, start: performance.now(), broadcast });
      this.socket.write(JSON.stringify({ ...command, reqId }) + "\n");
    });
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function expectType(reply: Reply, type: Event["type"]) {
  assert(reply.event.type === type, `Expected ${type}, received ${JSON.stringify(reply.event)}`);
  return reply;
}
const logs: string[] = [];
const logPumps: Promise<void>[] = [];
let child: ReturnType<typeof Bun.spawn> | undefined;
let client: Client | undefined;
const ownedPids: number[] = [];
async function start(): Promise<Client> {
  // Deliberately do not inherit credential-bearing environment variables.
  child = Bun.spawn({
    cmd: [process.execPath, "run", "daemon/src/main.ts"], cwd: repo,
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LANG: "C.UTF-8",
      EXOCORTEX_CONFIG_DIR: root, EXOCORTEX_CONVERSATION_STORE: "sqlite",
      EXOCORTEX_SUPERVISE_EXTERNAL_DAEMONS: "0",
    },
    stdout: "pipe", stderr: "pipe",
  });
  ownedPids.push(child.pid);
  let ready = false;
  const pumps = [child.stdout, child.stderr].map(async stream => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of stream as ReadableStream<Uint8Array>) {
      text += decoder.decode(chunk, { stream: true });
      if (text.includes("Waiting for connections")) ready = true;
    }
    logs.push(text);
  });
  logPumps.push(...pumps);
  const deadline = performance.now() + 20_000;
  while (!ready) {
    assert(child.exitCode === null, `Isolated daemon exited early: ${child.exitCode}`);
    assert(performance.now() < deadline, "Isolated daemon did not become ready");
    await Bun.sleep(25);
  }
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return client = new Client(socket);
}
async function probeWhile(work: () => Promise<Reply>) {
  const probes: Promise<Reply>[] = [client!.request({ type: "list_tasks" })];
  const timer = setInterval(() => { probes.push(client!.request({ type: "list_tasks" })); }, 10);
  let result: Reply;
  try { result = await work(); } finally { clearInterval(timer); }
  const replies = await Promise.all(probes);
  for (const reply of replies) expectType(reply, "tasks_list");
  const times = replies.map(reply => reply.ms).sort((a, b) => a - b);
  assert(times.length >= 1, "No IPC probe completed");
  assert(times.at(-1)! < 250, `IPC stalled during cold load: ${times.at(-1)} ms`);
  return { result, ipc: { samples: times.length, p50Ms: times[Math.floor(times.length * .5)], p95Ms: times[Math.floor(times.length * .95)], maxMs: times.at(-1) } };
}
try {
  await start();
  const page = expectType(await client!.request({ type: "load_conversation", convId: id, turns: 1 }), "conversation_loaded");
  const tool = expectType(await client!.request({ type: "load_tool_outputs", convId: id, toolCallIds: ["tool-1"] }), "tool_outputs_loaded");
  let stopMs = 0;
  const cold = await probeWhile(async () => {
    const send = client!.request({ type: "send_message", convId: id, text: "MUST NOT BE PERSISTED", startedAt: Date.now() });
    // Same socket dispatch batch: cancellation must not depend on keeping cold
    // admission artificially slow enough to beat a 50 ms timer.
    const stop = expectType(await client!.request({ type: "abort", convId: id }), "ack");
    stopMs = stop.ms;
    assert(stopMs < 250, "Stop was blocked by archive loading");
    const outcome = expectType(await send, "error");
    assert("message" in outcome.event && outcome.event.message.includes("cancelled"), "Stop did not cancel cold admission");
    return outcome;
  });
  expectType(await client!.request({ type: "rename_conversation", convId: id, title: "IPC persisted rename" }), "ack");
  expectType(await client!.request({ type: "mark_conversation", convId: id, marked: true }, "conversation_marked"), "conversation_marked");
  expectType(await client!.request({ type: "pin_conversation", convId: id, pinned: true }, "conversation_moved"), "conversation_moved");
  // Exact owned-instance restart protocol, not a service/main-daemon restart.
  expectType(await client!.request({ type: "restart_daemon" }), "ack");
  const restartCode = await child!.exited;
  assert(restartCode === DAEMON_RESTART_EXIT_CODE, `Unexpected restart exit code ${restartCode}`);
  await start();
  const restartPage = expectType(await client!.request({ type: "load_conversation", convId: id, turns: 1 }), "conversation_loaded");
  // The restarted cache is still cold: only paged display rows were read.
  // Delete / restore / redo must not hydrate canonical archive bodies.
  expectType(await client!.request({ type: "delete_conversation", convId: id }, "conversation_deleted"), "conversation_deleted");
  const undo = await client!.request({ type: "undo_delete" });
  assert(undo.event.type !== "error", `Undo failed: ${JSON.stringify(undo.event)}`);
  const redo = await client!.request({ type: "redo_delete" }, "conversation_deleted");
  assert(redo.event.type !== "error", `Redo failed: ${JSON.stringify(redo.event)}`);
  const restored = await client!.request({ type: "undo_delete" });
  assert(restored.event.type !== "error", `Restore failed: ${JSON.stringify(restored.event)}`);
  const reloaded = await probeWhile(() => client!.request({ type: "get_system_prompt", convId: id }));
  expectType(reloaded.result, "system_prompt");
  child!.kill("SIGTERM");
  assert(await child!.exited === 0, "Isolated daemon did not stop cleanly");
  const final = new Database(dbPath, { readonly: true });
  const stored = final.query<{ title: string; stored_message_count: number; marked: number; pinned: number; deleted_at: number | null }, [string]>(
    "SELECT title, stored_message_count, marked, pinned, deleted_at FROM conversations WHERE id=?",
  ).get(id)!;
  assert(stored.stored_message_count === original.stored_message_count, "Cancelled prompt or archive rows were written");
  assert(stored.title === "IPC persisted rename" && !!stored.marked && !!stored.pinned && stored.deleted_at === null, "Metadata did not survive restart/restore");
  assert(final.query<{ payload_json: string }, [string]>("SELECT payload_json FROM active_contexts WHERE conversation_id=?").get(id)!.payload_json === checkpoint, "Checkpoint changed");
  assert(Object.values(final.query("PRAGMA integrity_check").get()!)[0] === "ok", "SQLite integrity check failed");
  final.close();
  // A fresh daemon has no trusted proofs. Paged open speculates a bounded,
  // verified window off-thread; wait for evidence from this exact child rather
  // than sleeping long enough and assuming the cache must be warm.
  await start();
  expectType(await client!.request({ type: "load_conversation", convId: id, turns: 1 }), "conversation_loaded");
  const perfPath = join(root, "runtime", namespace, "exocortex.log");
  const perfLines = () => existsSync(perfPath) ? readFileSync(perfPath, "utf8").split("\n")
    .filter(line => line.includes(`[${child!.pid}]`)) : [];
  const deadline = performance.now() + 10_000;
  while (!perfLines().some(line => line.includes("perf: conversation_runtime_prefetch") && line.includes('"warmed":true'))) {
    assert(performance.now() < deadline, "Paged open did not finish verified background warming");
    await Bun.sleep(25);
  }
  const prefetchedLoad = expectType(await client!.request({ type: "get_system_prompt", convId: id }), "system_prompt");
  child!.kill("SIGTERM");
  assert(await child!.exited === 0, "Prefetched isolated daemon did not stop cleanly");
  assert(perfLines().some(line => line.includes("perf: conversation_runtime_load")
    && line.includes('"cacheHit":true') && line.includes('"archiveRowsRead":0')), "Foreground did not use the verified worker cache");
  const perfLog = readFileSync(perfPath, "utf8");
  // Fault only the disposable synthetic copy. Superseded canonical bytes must
  // not be read on resume, but a requested corrupt expansion/projection must
  // return an IPC error. Tail corruption must still block a fresh resume.
  const fault = new Database(dbPath);
  fault.query("UPDATE messages SET content_json='{' WHERE conversation_id=? AND sequence=2").run(id);
  fault.close();
  await start();
  const oldFaultResume = expectType(await client!.request({ type: "get_system_prompt", convId: id }), "system_prompt");
  expectType(await client!.request({ type: "load_tool_outputs", convId: id, toolCallIds: ["tool-0"] }), "error");
  expectType(await client!.request({ type: "load_tool_outputs", convId: id, toolCallIds: ["tool-1"] }), "tool_outputs_loaded");
  const projectionFault = new Database(dbPath);
  projectionFault.query("UPDATE display_entries SET payload_json='{' WHERE conversation_id=? AND pinned=0 AND entry_index=0").run(id);
  projectionFault.query("UPDATE messages SET content_json='{' WHERE conversation_id=? AND sequence=?").run(id, original.stored_message_count - 1);
  projectionFault.close();
  expectType(await client!.request({ type: "load_conversation", convId: id, turns: 100 }), "error");
  child!.kill("SIGTERM");
  assert(await child!.exited === 0, "Archive-fault isolated daemon did not stop cleanly");
  await start();
  const rejected = expectType(await client!.request({ type: "get_system_prompt", convId: id }), "error");
  assert("message" in rejected.event && rejected.event.message.includes("Could not load verified conversation"), "Worker failure did not reach the caller");
  const recoveredIpc = expectType(await client!.request({ type: "list_tasks" }), "tasks_list");
  child!.kill("SIGTERM");
  assert(await child!.exited === 0, "Faulted isolated daemon did not stop cleanly");
  const report = {
    ok: true, ownedPids, pageMs: page.ms, toolMs: tool.ms, stopMs,
    coldAdmissionMs: cold.result.ms, coldIpc: cold.ipc, restartCode,
    restartPageMs: restartPage.ms, restartColdLoadMs: reloaded.result.ms, restartIpc: reloaded.ipc,
    coldUndoMs: undo.ms, coldRedoMs: redo.ms, coldRestoreMs: restored.ms,
    messagesPreserved: stored.stored_message_count, checkpointUnchanged: true,
    prefetchedLoadMs: prefetchedLoad.ms, prefetchedArchiveRowsRead: 0,
    oldFaultResumeMs: oldFaultResume.ms, oldArchiveDeferred: true, corruptRequestedChunksRejected: true,
    workerFaultReturnedError: true, afterFaultIpcMs: recoveredIpc.ms,
  };
  if (reportPath) writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2) + "\n");
  if (reportPath) writeFileSync(resolve(reportPath) + ".perf.log", perfLog);
  console.log(JSON.stringify(report, null, 2));
} finally {
  client?.socket.destroy();
  if (child?.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
  await Promise.all(logPumps);
  if (reportPath) writeFileSync(resolve(reportPath) + ".daemon.log", logs.join("\n"));
  else if (!logs.length) console.error("Isolated daemon exited before producing logs");
  rmSync(root, { recursive: true, force: true });
}
