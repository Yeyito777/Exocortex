/**
 * Keeps one Claude Code process running across daemon restarts.
 *
 *   bun relay.ts <start-file>
 *
 * The daemon starts this outside its own process tree (see relay-client.ts),
 * so it and its Claude Code process survive the daemon's exit. It listens on a
 * Unix socket and passes Claude Code's stream-json traffic to the connected
 * daemon. With no daemon connected Claude Code keeps working, and a daemon
 * that connects is first replayed:
 * - Claude Code's output since the daemon's last commit (a tool round or a
 *   turn it saved), without the deltas of finished API calls;
 * - Claude Code's requests that no daemon answered yet. An Exocortex tool
 *   call (MCP tools/call) a departed daemon was running is answered with an
 *   error instead: it may have done part of its work.
 *
 * The newest connection replaces an older one. Left without a daemon, an idle
 * Claude Code without background tasks is ended after ORPHAN_IDLE_MS.
 */

import { spawn } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { DAEMON_RESTART_TOOL_INTERRUPTED_MESSAGE } from "../../abort";
import {
  endsInterruptedTurn,
  RELAY_LINE_PREFIX,
  RELAY_PROTOCOL_VERSION,
  relayLine,
  REPLAYED_FIELD,
  startsClaudeTurn,
  type RelayOp,
  type RelayRecord,
  type RelayResumePoint,
  type RelayStart,
} from "./relay-protocol";

const ORPHAN_IDLE_MS = 10 * 60_000;
const KILL_GRACE_MS = 5_000;
/** How long a relay whose Claude Code failed to start waits for a daemon to report it to. */
const FAILED_START_WAIT_MS = 30_000;

type Json = Record<string, unknown>;

interface LogEntry {
  line: string;
  uuid: string | undefined;
  /** A streamed content delta: redundant once its message is complete. */
  delta: boolean;
  turn: boolean;
}

function parse(line: string): Json | null {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function markReplayed(line: string): string {
  return line.endsWith("}") && line.length > 2 ? `${line.slice(0, -1)},"${REPLAYED_FIELD}":true}` : line;
}

/** JSON-RPC id of an MCP tool call Claude Code asks the daemon to run, if this request is one. */
function toolCallId(request: Json): { id: unknown } | null {
  const body = request.request as Json | undefined;
  const message = body?.message as Json | undefined;
  return body?.subtype === "mcp_message" && message?.method === "tools/call" ? { id: message.id } : null;
}

const startPath = process.argv[2];
if (!startPath) {
  console.error("usage: relay.ts <start-file>");
  process.exit(2);
}
const start = JSON.parse(readFileSync(startPath, "utf8")) as RelayStart;
rmSync(startPath, { force: true });
if (start.version !== RELAY_PROTOCOL_VERSION) {
  console.error(`relay: unsupported start version ${String(start.version)}`);
  process.exit(2);
}
process.umask(0o077);

let client: Socket | null = null;
let log: LogEntry[] = [];
/** Claude Code's requests to the daemon still waiting for an answer, by request id. */
const pending = new Map<string, { line: string; toolCall: { id: unknown } | null }>();
let resume: RelayResumePoint | null = start.meta.resume;
let delivered: string[] = [];
/** Claude Code is not idle: a turn, or background agents it waits on. */
let busy = false;
/** Prompts sent to Claude Code that no result has answered yet. */
const unanswered = new Set<string>();
/** Claude Code produced output of a turn that has no result yet. */
let turnOpen = false;
/** When each live background task was first seen. */
const taskStarts = new Map<string, number>();
/** Output of an interrupted turn is dropped up to the result that ends it. */
let discarding: { promptUuid: string | null } | null = null;
let exited: { code: number | null; signal: string | null } | null = null;
let orphanTimer: ReturnType<typeof setTimeout> | null = null;
let attached = false;

const claude = spawn(start.command, start.args, { cwd: start.cwd, env: start.env, stdio: ["pipe", "pipe", "pipe"] });
claude.stdin.on("error", () => { /* exit follows */ });

function send(text: string): void {
  if (client && !client.destroyed) client.write(text);
}

function record(message: Json, line: string): void {
  if (discarding) {
    if (endsInterruptedTurn(discarding.promptUuid, message)) discarding = null;
    return;
  }
  if (message.type === "result") turnOpen = false;
  else if (startsClaudeTurn(message)) turnOpen = true;
  // A complete message carries its streamed deltas; drop them.
  if (message.type === "assistant" || message.type === "user") log = log.filter(entry => !entry.delta);
  const event = message.type === "stream_event" ? message.event as Json | undefined : undefined;
  log.push({
    line,
    uuid: str(message.uuid),
    delta: typeof event?.type === "string" && event.type.startsWith("content_block_"),
    turn: startsClaudeTurn(message),
  });
}

function observe(message: Json, line: string): void {
  switch (message.type) {
    case "control_request": {
      const id = str(message.request_id);
      if (id) pending.set(id, { line, toolCall: toolCallId(message) });
      return;
    }
    case "control_cancel_request":
      pending.delete(str(message.request_id) ?? "");
      return;
    case "control_response":
    case "keep_alive":
      return;
  }
  if (message.type === "result") {
    const answered = Array.isArray(message.user_message_uuids) ? message.user_message_uuids : [message.user_message_uuid];
    for (const uuid of answered) if (typeof uuid === "string") unanswered.delete(uuid);
  } else if (message.type === "system" && message.subtype === "session_state_changed") {
    busy = message.state !== "idle";
    checkOrphaned();
  } else if (message.type === "system" && message.subtype === "background_tasks_changed") {
    const live = new Set<string>();
    for (const task of Array.isArray(message.tasks) ? message.tasks as Json[] : []) {
      const id = str(task?.task_id);
      if (id && task.ambient !== true) live.add(id);
    }
    for (const id of taskStarts.keys()) if (!live.has(id)) taskStarts.delete(id);
    for (const id of live) if (!taskStarts.has(id)) taskStarts.set(id, Date.now());
    checkOrphaned();
  }
  // Subagent traffic is only liveness to the daemon; it is never replayed.
  if (!message.parent_tool_use_id) record(message, line);
}

function commit(op: Extract<RelayOp, { op: "commit" }>): void {
  if (op.through) {
    const index = log.findIndex(entry => entry.uuid === op.through);
    if (index >= 0) log = log.slice(index + 1);
  }
  if (op.resume) {
    resume = op.resume;
    // History has moved past every message sent before this point.
    delivered = [];
  }
  if (op.interrupted) {
    const { promptUuid } = op.interrupted;
    if (promptUuid) unanswered.delete(promptUuid);
    turnOpen = false;
    // Its result may already be on its way to the daemon.
    const end = log.findIndex(entry => endsInterruptedTurn(promptUuid, parse(entry.line) ?? {}));
    if (end >= 0) log = log.slice(end + 1);
    else {
      log = [];
      discarding = { promptUuid };
    }
  }
}

function handleOp(op: RelayOp): void {
  switch (op.op) {
    case "commit":
      commit(op);
      return;
    case "delivered":
      for (const key of op.keys) if (!delivered.includes(key)) delivered.push(key);
      return;
    case "end_input":
      claude.stdin.end();
      return;
    case "kill":
      terminate(op.signal as NodeJS.Signals);
      return;
  }
}

function fromClient(line: string): void {
  if (line.startsWith(RELAY_LINE_PREFIX)) {
    const op = parse(line) as RelayOp | null;
    if (op) handleOp(op);
    return;
  }
  if (line.includes("\"control_response\"")) {
    const response = parse(line);
    if (response?.type === "control_response") pending.delete(str((response.response as Json | undefined)?.request_id) ?? "");
  } else if (line.includes("\"user\"")) {
    const prompt = parse(line);
    const uuid = prompt?.type === "user" ? str(prompt.uuid) : undefined;
    if (uuid) unanswered.add(uuid);
  }
  if (!claude.stdin.destroyed) claude.stdin.write(`${line}\n`);
}

/** Answer the Exocortex tool calls a departed daemon was running, so Claude Code does not wait on them. */
function answerAbandonedToolCalls(): void {
  for (const [requestId, request] of pending) {
    if (!request.toolCall) continue;
    pending.delete(requestId);
    const result = { content: [{ type: "text", text: DAEMON_RESTART_TOOL_INTERRUPTED_MESSAGE }], isError: true };
    const response = { type: "control_response", response: { subtype: "success", request_id: requestId, response: { mcp_response: { jsonrpc: "2.0", id: request.toolCall.id, result } } } };
    if (!claude.stdin.destroyed) claude.stdin.write(`${JSON.stringify(response)}\n`);
  }
}

/** A daemon's connection ended or was replaced: nothing it was running will be answered. */
function release(socket: Socket): void {
  if (client !== socket) return;
  client = null;
  answerAbandonedToolCalls();
  checkOrphaned();
}

function attach(socket: Socket): void {
  if (client) {
    const previous = client;
    release(previous);
    previous.destroy();
  }
  client = socket;
  attached = true;
  checkOrphaned();
  send(relayLine({
    event: "hello",
    version: RELAY_PROTOCOL_VERSION,
    pid: process.pid,
    meta: start.meta,
    resume,
    delivered,
    pending: unanswered.size > 0 || turnOpen || log.some(entry => entry.turn),
    taskStarts: Object.fromEntries(taskStarts),
  }));
  for (const entry of log) send(`${markReplayed(entry.line)}\n`);
  for (const request of pending.values()) send(`${request.line}\n`);
  if (exited) {
    send(relayLine({ event: "exit", ...exited }));
    socket.end(shutdown);
    return;
  }

  let partial = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    const text = partial + chunk;
    let from = 0;
    for (let newline = text.indexOf("\n"); newline !== -1; newline = text.indexOf("\n", from)) {
      const line = text.slice(from, newline);
      from = newline + 1;
      if (line) fromClient(line);
    }
    partial = text.slice(from);
  });
  socket.on("error", () => { /* close follows */ });
  socket.on("close", () => release(socket));
}

function checkOrphaned(): void {
  const orphaned = !client && !busy && taskStarts.size === 0 && !exited;
  if (!orphaned) {
    if (orphanTimer) clearTimeout(orphanTimer);
    orphanTimer = null;
    return;
  }
  orphanTimer ??= setTimeout(() => {
    claude.stdin.end();
    setTimeout(() => terminate("SIGTERM"), KILL_GRACE_MS).unref();
  }, ORPHAN_IDLE_MS);
}

function terminate(signal: NodeJS.Signals): void {
  if (exited) return;
  try { claude.kill(signal); } catch { /* already gone */ }
  setTimeout(() => {
    try { if (!exited) claude.kill("SIGKILL"); } catch { /* already gone */ }
  }, KILL_GRACE_MS).unref();
}

const server = createServer(attach);

function shutdown(): void {
  server.close();
  rmSync(start.recordPath, { force: true });
  rmSync(start.socketPath, { force: true });
  process.exit(0);
}

function finish(code: number | null, signal: string | null): void {
  if (exited) return;
  exited = { code, signal };
  if (orphanTimer) clearTimeout(orphanTimer);
  if (client) {
    send(relayLine({ event: "exit", code, signal }));
    client.end(shutdown);
    setTimeout(shutdown, 2_000).unref();
  } else if (attached) {
    shutdown();
  } else {
    // The daemon starting this relay is still connecting; attach() tells it why.
    setTimeout(shutdown, FAILED_START_WAIT_MS);
  }
}

createInterface({ input: claude.stdout, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return;
  const message = parse(line);
  if (message) observe(message, line);
  send(`${line}\n`);
});
claude.stderr.setEncoding("utf8");
claude.stderr.on("data", (data: string) => send(relayLine({ event: "stderr", data })));
claude.on("error", (error) => {
  send(relayLine({ event: "stderr", data: `Failed to start Claude Code: ${error.message}\n` }));
  finish(127, null);
});
claude.on("close", (code, signal) => finish(code, signal));

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => terminate("SIGTERM"));
process.on("SIGHUP", () => { /* outlives the terminal that started it */ });

server.on("error", (error) => {
  console.error(`relay: ${error.message}`);
  terminate("SIGTERM");
});
server.listen(start.socketPath, () => {
  const entry: RelayRecord = {
    version: RELAY_PROTOCOL_VERSION,
    convId: start.meta.convId,
    socketPath: start.socketPath,
    pid: process.pid,
    createdAt: Date.now(),
  };
  const temporary = `${start.recordPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(entry)}\n`);
  renameSync(temporary, start.recordPath);
});
