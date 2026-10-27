#!/usr/bin/env bun
/**
 * End-to-end test: a daemon restart interrupting a subagent's queued
 * follow-up turn reports that turn once, with its real reply, after the
 * replay ends (Oct 27 Record GIF agent).
 *
 * One isolated daemon from this checkout plays against a mock OpenAI upstream.
 * A parent spawns a child whose first turn is slow; the parent messages the
 * child meanwhile (queued after that turn). The first turn reports "replied
 * (still working)", the parent then sleeps on `chrono wait` for the child, and
 * the daemon is restarted (SIGTERM, as systemd does) while the child's second
 * turn is in flight. The replayed turn then answers.
 *
 * Asserts: the parent gets exactly two notices, the second "completed" with
 * the replayed turn's reply (never the first turn's again), and the parent's
 * wait does not finish before that reply exists.
 *
 * Usage: bun scripts/dev/subagent-restart-e2e.ts [--keep]
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";

const ROOT = resolve(import.meta.dir, "../..");
const KEEP = process.argv.includes("--keep");
const work = mkdtempSync(join(tmpdir(), "exo-subagent-restart-e2e-"));
const OPENAI_TOKEN = "e2e-openai-token";
const MODEL = "gpt-6-astra";
const log = (message: string) => console.log(`  ${message}`);

// ── Mock upstream ────────────────────────────────────────────────────
// Only user-role input items steer it (tool arguments repeat the prompts).
// The child's prompt carries CHILDMARK past its six-word title, so the
// parent's notices (which quote the title) never look like the child.

const CHILD_PROMPT = "please answer after a short pause CHILDMARK";
const FOLLOW_UP = "FOLLOWUP please look again";
const REPLY_A = "reply A from the first turn";
const REPLY_B = "reply B from the replayed turn";

type Item = Record<string, unknown>;
const userTexts = (input: Item[]) => input.filter(item => item.role === "user").map(item => JSON.stringify(item.content));
let childId = "";
let followUpRequests = 0;
let replyBSentAt = 0;
let chronoWaitIssued = false;
let toolSerial = 0;
let resolveFollowUpInFlight!: () => void;
const followUpInFlight = new Promise<void>(resolve => { resolveFollowUpInFlight = resolve; });

function message(text: string): Item {
  return { type: "message", id: `msg_${++toolSerial}`, role: "assistant", content: [{ type: "output_text", text }] };
}
function call(name: string, args: unknown): Item {
  return { type: "function_call", id: `fc_${++toolSerial}`, call_id: `call_e2e_${toolSerial}`, name, arguments: JSON.stringify(args) };
}

/** What one websocket has seen: later requests on it carry only new input. */
interface Session { child: boolean; followUp: boolean }

/** The item to answer with, a delay, or null to hang (the restart cuts it). */
function respond(input: Item[], session: Session = { child: false, followUp: false }): { item: Item; delayMs?: number } | null {
  const texts = userTexts(input);
  const last = texts.at(-1) ?? "";
  const lastUser = input.findLastIndex(item => item.role === "user");
  const output = input.slice(lastUser + 1).findLast(item => item.type === "function_call_output");
  session.child ||= texts.some(text => text.includes("CHILDMARK"));
  session.followUp ||= texts.some(text => text.includes("FOLLOWUP"));
  if (session.child) {
    if (!session.followUp) return { item: message(REPLY_A), delayMs: 3000 };
    followUpRequests += 1;
    if (followUpRequests === 1) { resolveFollowUpInFlight(); return null; }
    replyBSentAt = Date.now();
    return { item: message(REPLY_B) };
  }
  if (output) return { item: message(`tool said: ${String(output.output).trim()}`) };
  if (last.includes("SPAWN")) return { item: call("exo", { subagent: CHILD_PROMPT }) };
  if (last.includes("MESSAGE")) return { item: call("exo", { message: { conversation: childId, text: FOLLOW_UP, delivery: "after_turn" } }) };
  if (last.includes("[notification]") && last.includes(REPLY_A)) {
    chronoWaitIssued = true;
    return { item: call("chrono", { action: "wait", task_id: childId, max_wait: "10m" }) };
  }
  return { item: message("ack") };
}

function events(item: Item): Item[] {
  const id = `resp_${++toolSerial}`;
  return [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, usage: { input_tokens: 10, output_tokens: 3 }, output: [item] } },
  ];
}

const mock = Bun.serve<{ session: Session }>({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/backend-api/codex/responses" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (request.headers.get("authorization") !== `Bearer ${OPENAI_TOKEN}`) return new Response("bad token", { status: 401 });
      return server.upgrade(request, { data: { session: { child: false, followUp: false } } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/backend-api/codex/responses") {
      if (request.headers.get("authorization") !== `Bearer ${OPENAI_TOKEN}`) return new Response("bad token", { status: 401 });
      const body = JSON.parse(await request.text()) as { input?: Item[] };
      const answer = respond(body.input ?? []);
      if (!answer) return new Response(new ReadableStream({ start() { /* hang */ } }), { headers: { "content-type": "text/event-stream" } });
      if (answer.delayMs) await Bun.sleep(answer.delayMs);
      return new Response(events(answer.item).map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/backend-api/codex/models") return Response.json({ models: [] });
    return new Response("not mocked", { status: 404 });
  },
  websocket: {
    async message(socket: ServerWebSocket<{ session: Session }>, raw) {
      const request = JSON.parse(String(raw)) as { type: string; input?: Item[] };
      if (request.type !== "response.create") return;
      const answer = respond(request.input ?? [], socket.data.session);
      if (!answer) return;
      if (answer.delayMs) await Bun.sleep(answer.delayMs);
      for (const event of events(answer.item)) socket.send(JSON.stringify(event));
    },
  },
});
const MOCK = `http://127.0.0.1:${mock.port}`;

// ── Instance ─────────────────────────────────────────────────────────

const configDir = join(work, "config");
mkdirSync(join(configDir, "secrets"), { recursive: true });
const day = Date.now() + 24 * 3600_000;
writeFileSync(join(configDir, "secrets", "credentials.json"), JSON.stringify({
  version: 2,
  providers: {
    openai: {
      tokens: { accessToken: OPENAI_TOKEN, refreshToken: null, expiresAt: day, scopes: [], subscriptionType: "pro", rateLimitTier: null },
      profile: { accountUuid: "acct-e2e", email: "e2e@example.com", displayName: null, organizationUuid: null, organizationName: null, organizationType: null, organizationRole: null, workspaceRole: null },
      updatedAt: new Date().toISOString(), source: "oauth", authMode: null, accountId: "acct-e2e", idToken: null,
    },
  },
}), { mode: 0o600 });

const env = { ...process.env, EXOCORTEX_CONFIG_DIR: configDir, EXOCORTEX_TEST: "1", EXOCORTEX_CLAUDE_RELAY: "0", OPENAI_CHATGPT_BASE_URL: MOCK };
const INSTANCE = Bun.spawnSync(["bun", "-e", `import { worktreeName } from "./shared/src/paths"; process.stdout.write(worktreeName() ?? "main")`], { cwd: ROOT, env }).stdout.toString();
const socket = Bun.spawnSync(["bun", "-e", `import { socketPath } from "./shared/src/paths"; process.stdout.write(socketPath())`], { cwd: ROOT, env }).stdout.toString();
let daemon: Bun.Subprocess | null = null;
let starts = 0;

async function startDaemon(): Promise<void> {
  const logFile = Bun.file(join(work, `daemon-${++starts}.log`));
  daemon = Bun.spawn(["bun", "run", "src/main.ts"], { cwd: join(ROOT, "daemon"), env, stdout: logFile, stderr: logFile });
  for (let i = 0; i < 150; i++) {
    if (existsSync(socket)) {
      try { (await Ipc.connect(socket)).close(); break; } catch { /* stale socket */ }
    }
    await Bun.sleep(100);
  }
  await Bun.sleep(300);
}

// ── IPC ──────────────────────────────────────────────────────────────

class Ipc {
  private buffer = "";
  private serial = 0;
  readonly events: Array<Record<string, any>> = [];
  private waiters: Array<{ match: (event: Record<string, any>) => boolean; resolve: (event: Record<string, any>) => void }> = [];
  private constructor(private readonly socket: net.Socket) {
    socket.on("data", chunk => {
      this.buffer += String(chunk);
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const event = JSON.parse(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
        this.events.push(event);
        for (const waiter of [...this.waiters]) {
          if (waiter.match(event)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            waiter.resolve(event);
          }
        }
      }
    });
    socket.on("error", () => { /* the daemon restarts under it */ });
  }
  static async connect(path: string): Promise<Ipc> {
    const socket = net.connect(path);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return new Ipc(socket);
  }
  send(command: Record<string, unknown>): void { this.socket.write(`${JSON.stringify(command)}\n`); }
  wait(match: (event: Record<string, any>) => boolean, timeoutMs = 60_000, label = "event"): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      this.waiters.push({ match, resolve: event => { clearTimeout(timer); resolve(event); } });
    });
  }
  async request(command: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, any>> {
    const reqId = `e2e-${++this.serial}`;
    const reply = this.wait(event => event.reqId === reqId && event.type !== "ack", timeoutMs, `${String(command.type)} reply`);
    this.send({ ...command, reqId });
    return reply;
  }
  close(): void { this.socket.destroy(); }
}

async function parentTurn(ipc: Ipc, convId: string, text: string): Promise<string> {
  ipc.send({ type: "subscribe", convId });
  const done = ipc.wait(event => event.convId === convId && event.type === "message_complete", 60_000, "parent turn");
  ipc.send({ type: "send_message", convId, text, startedAt: Date.now() });
  const outcome = await done;
  return (outcome.blocks as Array<Record<string, any>>).map(block => block.text ?? "").join("\n");
}

async function until(condition: () => boolean, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(100);
  }
}

interface Row { sequence: number; role: string; content: string; startedAt: number | null; endedAt: number | null }
function history(convId: string): Row[] {
  // Test instances keep conversations as JSON files, flushed at each turn's end.
  const file = join(configDir, "data", "instances", INSTANCE, "conversations", `${convId}.json`);
  if (!existsSync(file)) return [];
  const conv = JSON.parse(readFileSync(file, "utf-8")) as { messages: Array<{ role: string; content: unknown; metadata?: { startedAt?: number; endedAt?: number } | null }> };
  return conv.messages.map((message, sequence) => ({
    sequence, role: message.role, content: JSON.stringify(message.content),
    startedAt: message.metadata?.startedAt ?? null, endedAt: message.metadata?.endedAt ?? null,
  }));
}
const notices = (rows: Row[]) => rows.filter(row => row.role === "user" && row.content.includes("[notification] Subagent"));

// ── Run ──────────────────────────────────────────────────────────────

let failed = false;
try {
  log(`work dir ${work}; mock upstream ${MOCK}`);
  await startDaemon();
  let ipc = await Ipc.connect(socket);
  const created = await ipc.request({ type: "new_conversation", provider: "openai", model: MODEL, title: "e2e parent" });
  assert.equal(created.type, "conversation_created", JSON.stringify(created));
  const parentId = created.convId as string;

  const spawned = await parentTurn(ipc, parentId, "SPAWN");
  childId = spawned.match(/"conversation_id":\s*"([^"]+)"/)?.[1] ?? "";
  assert(childId, spawned);
  log(`✓ parent ${parentId} spawned child ${childId} (slow first turn)`);
  const sent = await parentTurn(ipc, parentId, "MESSAGE");
  assert.match(sent, /"queued"/, sent);
  log("✓ parent's message queued behind the child's first turn");

  await followUpInFlight;
  await until(() => chronoWaitIssued, "the parent's chrono wait");
  await Bun.sleep(1000);
  assert.equal(notices(history(parentId)).length, 1);
  log("✓ first turn reported; child's follow-up turn in flight; parent waiting on the child");

  ipc.close();
  const exited = daemon!.exited;
  daemon!.kill("SIGTERM");
  await exited;
  log("✓ daemon restarted (SIGTERM) mid follow-up turn");
  await startDaemon();
  ipc = await Ipc.connect(socket);

  await until(() => replyBSentAt > 0, "the replayed follow-up turn");
  await until(() => notices(history(parentId)).length >= 2, "the follow-up turn's notice", 30_000);
  // Let any duplicate or late notice land before judging.
  await until(() => {
    const summary = history(parentId).at(-1);
    return summary?.role === "assistant" && summary.endedAt != null;
  }, "the parent to settle", 30_000);
  await Bun.sleep(1500);

  const rows = history(parentId);
  const got = notices(rows).map(row => JSON.parse(row.content) as string);
  assert.equal(got.length, 2, `expected 2 notices, got ${got.length}:\n${got.join("\n---\n")}`);
  assert.match(got[0], /Subagent replied \(still working\)/);
  assert.match(got[0], new RegExp(REPLY_A));
  assert.match(got[1], /Subagent completed/);
  assert.match(got[1], /Woken by: your message/);
  assert.match(got[1], new RegExp(REPLY_B));
  assert.doesNotMatch(got[1], new RegExp(REPLY_A));
  log("✓ exactly two notices: first turn (still working), replayed turn (completed, its own reply)");

  // The parent's long wait is suspended across the restart; the replayed
  // turn's notice is what wakes it, with no earlier wake in between.
  const waitCall = rows.findIndex(row => row.role === "assistant" && row.content.includes('"name":"chrono"'));
  const waitResult = rows.findIndex((row, index) => index > waitCall && row.content.includes("tool_result"));
  assert(waitCall >= 0 && waitResult > waitCall, "the parent's chrono wait and its result are in its history");
  const afterWait = rows.slice(waitResult + 1).find(row => row.role !== "system");
  assert(afterWait?.content.includes(REPLY_B), `the parent's wait ended before the replayed turn's notice:\n${rows[waitResult].content}`);
  const replyB = history(childId).find(row => row.role === "assistant" && row.content.includes(REPLY_B));
  assert(replyB?.endedAt, "the child's replayed reply is in its history");
  assert(afterWait.startedAt! >= replyB.endedAt, "the parent woke only after the child's replayed reply");
  log(`✓ parent's chrono wait (suspended across the restart) was woken by the replayed turn's notice`);
  console.log("PASS: a restart-interrupted subagent follow-up turn reports once, with its own reply.");
} catch (error) {
  failed = true;
  console.error("FAIL:", error instanceof Error ? error.stack ?? error.message : error);
  console.error(`  logs in ${work}`);
} finally {
  if (daemon) {
    const child = daemon as Bun.Subprocess;
    child.kill();
    await child.exited;
  }
  mock.stop(true);
  if (!KEEP && !failed) rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
