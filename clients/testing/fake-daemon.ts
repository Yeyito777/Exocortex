/**
 * A fake Exocortex daemon that speaks the app API's JSON lines
 * (docs/app-api.md) with a scripted "model", for the reference clients' tests.
 * Every client's test suite spawns it: `bun clients/testing/fake-daemon.ts
 * --socket PATH [options]`. It prints `ready <pid>` once listening and exits
 * on SIGTERM, on stdin EOF (so a crashed test cannot leave it behind) or on
 * `fake_exit`.
 *
 * Options:
 *   --api-version N       appApiVersion in app_welcome (default 1)
 *   --no-welcome          never answer client_capabilities (a daemon too old for the app API)
 *   --owner-wait-ms N     how long an app tool call waits for an owner (default 3000)
 *   --no-owner-results    send turn_result only to the connection that awaited it
 *                         (no owner copies, no lastTurnResult on attach: a send
                         interrupted by a restart then fails with result_lost)
 *   --chunk-delay-ms N    pause between streamed pieces (default 5)
 *   --refuse-after-restart-ms N
 *                         after a restart, drop new connections this long (default 0), so a
 *                         replayed turn ends before its owner is back
 *   --grace-ms N          default reconnect grace of a session (default 120000)
 *   --no-sessions         behave like a daemon from before sessions: no session in app_welcome,
 *                         an ephemeral conversation ends with its connection and with a restart,
 *                         a prompt sent again runs again
 *
 * The model's reply depends on the prompt:
 *   tool NAME JSON        call app tool NAME with input JSON; reply "NAME -> <output>"
 *                         (or "NAME error -> <output>")
 *   hang                  stream "working" and wait for an abort
 *   fail                  end the turn with stopReason "error"
 *   count                 reply "turns: N" (user messages so far, this one included)
 *   restart REST          stream "before", restart the daemon gracefully (connections close;
 *                         sessions and conversations, ephemeral ones too, carry on), replay
 *                         the turn as REST
 *   anything else         reply "echo: <prompt>"
 *
 * Test-only commands: `fake_restart {downMs?, crash?}` (a crash loses the sessions and
 * ephemeral conversations), `fake_drop` (closes every connection, the daemon stays up),
 * `fake_exit`, `fake_state` (answers `fake_state` with every conversation and the
 * commands received).
 */
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";

const argv = process.argv.slice(2);
function opt(name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}
const socketPath = opt("--socket");
if (!socketPath) { console.error("usage: fake-daemon.ts --socket PATH"); process.exit(2); }
const apiVersion = Number(opt("--api-version") ?? 1);
const noWelcome = argv.includes("--no-welcome");
const ownerWaitMs = Number(opt("--owner-wait-ms") ?? 3000);
const ownerResults = !argv.includes("--no-owner-results");
const chunkDelayMs = Number(opt("--chunk-delay-ms") ?? 5);
const refuseAfterRestartMs = Number(opt("--refuse-after-restart-ms") ?? 0);
const defaultGraceMs = Number(opt("--grace-ms") ?? 120_000);
const sessionsEnabled = !argv.includes("--no-sessions");
let refuseUntil = 0;

const APP_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const BUILTINS = ["bash", "read", "write", "edit", "glob", "grep", "web_search", "web_fetch", "exo", "chrono", "goal", "attach"];
const LIFETIMES = ["saved", "temporary", "ephemeral"];

type Json = Record<string, any>;

interface Conn { socket: Socket; app: string | null; id: number; session: Session | null }

/** What owns conversations: a client's session, which a reconnecting client takes back by its token. */
interface Session { id: string; app: string; conn: Conn | null; graceMs: number; timer: ReturnType<typeof setTimeout> | null; pending: Json[] }

interface PendingCall { callId: string; name: string; input: Json; resolve: (r: { output: string; isError: boolean }) => void; timer?: ReturnType<typeof setTimeout> }

interface Turn {
  turnId: string;
  prompt: string;
  /** Connections awaiting it (the sender, and any that sent the same prompt again). */
  awaiters: { conn: Conn; reqId: string | null }[];
  startedAt: number;
  aborted: boolean;
  wake: (() => void) | null;
  calls: Map<string, PendingCall>;
}

interface Conv {
  convId: string;
  app: string;
  lifetime: string;
  title: string;
  provider: string;
  model: string;
  effort: string;
  idleTtlMs?: number;
  cwd?: string;
  systemBase: string;
  builtinTools: string[] | "all";
  tools: Json[];
  route?: Json;
  owner: Session | null;
  subscribers: Set<Conn>;
  /** startedAt of every prompt it was sent. */
  prompts: Set<number>;
  createdAt: number;
  lastActivityAt: number;
  userMessages: number;
  turn: Turn | null;
  replay: { prompt: string; turnId: string; startedAt: number; awaiters?: Turn["awaiters"] } | null;
  lastTurnResult: Json | null;
  keep: boolean;
  runFinished?: boolean;
  ownerWaiters: Array<() => void>;
}

const conversations = new Map<string, Conv>();
const connections = new Set<Conn>();
const sessions = new Map<string, Session>();
const received: Json[] = [];
let connCounter = 0;
let idCounter = 0;
let server: Server | null = null;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const newConvId = () => `${String(Date.now()).padStart(13, "0")}-${(++idCounter).toString(36).padStart(6, "0").slice(-6)}`;

function write(conn: Conn | null, event: Json): void {
  if (!conn || conn.socket.destroyed) return;
  conn.socket.write(JSON.stringify(event) + "\n");
}

function ownerConn(conv: Conv): Conn | null {
  const conn = conv.owner?.conn ?? null;
  return conn && !conn.socket.destroyed ? conn : null;
}

function toSubscribers(conv: Conv, event: Json): void {
  const targets = new Set(conv.subscribers);
  const owner = ownerConn(conv);
  if (owner) targets.add(owner);
  for (const conn of targets) write(conn, event);
}

/** To the owner, or kept for its session while it is away. */
function toOwner(conv: Conv, event: Json): void {
  const owner = ownerConn(conv);
  if (owner) write(owner, event);
  else if (conv.owner && sessionsEnabled) conv.owner.pending.push(event);
}

function sessionOf(conn: Conn): Session {
  if (conn.session) return conn.session;
  const session: Session = { id: `anon-${conn.id}`, app: conn.app ?? "", conn, graceMs: 0, timer: null, pending: [] };
  conn.session = session;
  sessions.set(session.id, session);
  return session;
}

function owned(session: Session): Conv[] {
  return [...conversations.values()].filter(conv => conv.owner === session);
}

function armGrace(session: Session): void {
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    session.timer = null;
    if (session.conn) return;
    sessions.delete(session.id);
    for (const conv of owned(session)) {
      conv.owner = null;
      if (conv.lifetime === "ephemeral") deleteConv(conv, "owner_disconnected");
    }
  }, session.graceMs);
}

function info(conv: Conv): Json {
  return {
    convId: conv.convId, app: conv.app, lifetime: conv.lifetime, title: conv.title,
    provider: conv.provider, model: conv.model, effort: conv.effort,
    createdAt: conv.createdAt, lastActivityAt: conv.lastActivityAt,
    ...(conv.lifetime === "temporary" ? { idleTtlMs: conv.idleTtlMs, expiresAt: conv.lastActivityAt + (conv.idleTtlMs ?? 3_600_000) } : {}),
    ownerConnected: Boolean(ownerConn(conv)), streaming: Boolean(conv.turn || conv.replay),
    ...(conv.cwd ? { cwd: conv.cwd } : { workspace: `/tmp/fake-workspace/${conv.convId}` }),
    systemBase: conv.systemBase, builtinTools: conv.builtinTools,
    appTools: conv.tools.map(tool => tool.name),
    ...(conv.route ? { route: conv.route } : {}),
  };
}

function validateTools(tools: Json | undefined): string | null {
  if (tools === undefined) return null;
  if (typeof tools !== "object" || tools === null) return "tools must be an object";
  const builtin = tools.builtin;
  if (builtin !== undefined && builtin !== "all") {
    if (!Array.isArray(builtin)) return "tools.builtin must be a list or \"all\"";
    for (const name of builtin) if (!BUILTINS.includes(name)) return `tools.builtin: unknown tool ${JSON.stringify(name)}`;
  }
  return validateAppTools(tools.app);
}

function validateAppTools(app: unknown): string | null {
  if (app === undefined) return null;
  if (!Array.isArray(app)) return "tools.app must be a list";
  const seen = new Set<string>();
  for (const tool of app) {
    if (!tool || !TOOL_NAME.test(tool.name)) return `tools.app: invalid tool name ${JSON.stringify(tool?.name)}`;
    if (seen.has(tool.name)) return `tools.app: duplicate tool name ${JSON.stringify(tool.name)}`;
    if (BUILTINS.includes(tool.name)) return `tools.app: ${tool.name} is a built-in tool's name`;
    if (typeof tool.description !== "string") return `tools.app.${tool.name}: description must be a string`;
    if (!tool.inputSchema || tool.inputSchema.type !== "object") return `tools.app.${tool.name}: inputSchema must be an object schema`;
    seen.add(tool.name);
  }
  return null;
}

function create(conn: Conn, cmd: Json, defaultLifetime: string): Conv | string {
  const app = cmd.app ?? conn.app;
  if (!APP_NAME.test(app ?? "")) return `app: invalid app name ${JSON.stringify(app)}`;
  const lifetime = cmd.lifetime ?? defaultLifetime;
  if (!LIFETIMES.includes(lifetime)) return `lifetime: must be one of ${LIFETIMES.join(", ")}`;
  if (cmd.idleTtlMs !== undefined && lifetime !== "temporary") return "idleTtlMs: only for temporary conversations";
  if (cmd.system !== undefined && (typeof cmd.system !== "object" || (cmd.system.base && !["none", "agent", "full"].includes(cmd.system.base)))) return "system.base: must be none, agent or full";
  if (cmd.cwd !== undefined && (typeof cmd.cwd !== "string" || !cmd.cwd.startsWith("/") || !existsSync(cmd.cwd))) return `cwd: not an existing absolute directory: ${cmd.cwd}`;
  const toolError = validateTools(cmd.tools);
  if (toolError) return toolError;
  if (cmd.convId && conversations.has(cmd.convId)) return `convId: ${cmd.convId} already exists`;
  const now = Date.now();
  const conv: Conv = {
    convId: cmd.convId ?? newConvId(), app, lifetime,
    title: cmd.title ?? String(cmd.prompt ?? "").split("\n")[0].slice(0, 80),
    provider: cmd.provider ?? "anthropic", model: cmd.model ?? "fake-model", effort: cmd.effort ?? "high",
    idleTtlMs: lifetime === "temporary" ? cmd.idleTtlMs ?? 3_600_000 : undefined,
    cwd: cmd.cwd, systemBase: cmd.system?.base ?? "none",
    builtinTools: cmd.tools?.builtin ?? [], tools: cmd.tools?.app ?? [],
    ...(cmd.route ? { route: cmd.route } : {}),
    owner: sessionOf(conn), subscribers: new Set(), prompts: new Set(), createdAt: now, lastActivityAt: now,
    userMessages: 0, turn: null, replay: null, lastTurnResult: null, keep: Boolean(cmd.keep), ownerWaiters: [],
  };
  conversations.set(conv.convId, conv);
  return conv;
}

function created(conv: Conv, reqId: string | undefined): Json {
  return { type: "conversation_created", reqId, convId: conv.convId, provider: conv.provider, model: conv.model, effort: conv.effort, fastMode: false, goal: null, app: info(conv) };
}

function waitForOwner(conv: Conv, turn: Turn): Promise<boolean> {
  if (ownerConn(conv)) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => { conv.ownerWaiters = conv.ownerWaiters.filter(w => w !== waiter); resolve(false); }, ownerWaitMs);
    const waiter = () => { clearTimeout(timer); resolve(!turn.aborted); };
    conv.ownerWaiters.push(waiter);
  });
}

async function callAppTool(conv: Conv, turn: Turn, name: string, input: Json): Promise<{ output: string; isError: boolean }> {
  const callId = `toolu_fake_${++idCounter}`;
  toSubscribers(conv, { type: "tool_call", convId: conv.convId, toolCallId: callId, toolName: name, input, summary: `${name} ${JSON.stringify(input)}` });
  const def = conv.tools.find(tool => tool.name === name);
  let result: { output: string; isError: boolean };
  if (!def) result = { output: `No such tool: ${name}`, isError: true };
  else if (!(await waitForOwner(conv, turn))) result = { output: turn.aborted ? "interrupted" : `${conv.app} is not connected`, isError: true };
  else {
    result = await new Promise(resolve => {
      const call: PendingCall = { callId, name, input, resolve };
      turn.calls.set(callId, call);
      if (def.timeoutMs) call.timer = setTimeout(() => {
        if (!turn.calls.delete(callId)) return;
        write(ownerConn(conv), { type: "app_tool_cancel", convId: conv.convId, callId, reason: "timeout" });
        resolve({ output: `${name} timed out`, isError: true });
      }, def.timeoutMs);
      write(ownerConn(conv), { type: "app_tool_call", convId: conv.convId, callId, name, input });
    });
  }
  toSubscribers(conv, { type: "tool_result", convId: conv.convId, toolCallId: callId, toolName: name, output: result.output, isError: result.isError });
  return result;
}

async function stream(conv: Conv, text: string): Promise<void> {
  toSubscribers(conv, { type: "block_start", convId: conv.convId, blockType: "text" });
  const middle = Math.ceil(text.length / 2);
  for (const piece of [text.slice(0, middle), text.slice(middle)]) {
    if (!piece) continue;
    await sleep(chunkDelayMs);
    toSubscribers(conv, { type: "text_chunk", convId: conv.convId, text: piece });
  }
}

/** Runs one turn of the scripted model; returns the final text, or throws "restart". */
async function model(conv: Conv, turn: Turn, prompt: string): Promise<{ text: string; stopReason: string; error?: string }> {
  const words = prompt.trim().split(/\s+/);
  if (words[0] === "restart") {
    await stream(conv, "before");
    await sleep(chunkDelayMs);
    conv.replay = { prompt: prompt.trim().slice("restart".length).trim() || "replayed", turnId: turn.turnId, startedAt: turn.startedAt };
    throw new Error("restart");
  }
  if (words[0] === "tool") {
    const name = words[1];
    const input = JSON.parse(prompt.trim().split(/\s+/).slice(2).join(" ") || "{}");
    const result = await callAppTool(conv, turn, name, input);
    if (turn.aborted) return { text: "", stopReason: "aborted" };
    const text = `${name}${result.isError ? " error" : ""} -> ${result.output}`;
    await stream(conv, text);
    return { text, stopReason: "end_turn" };
  }
  if (words[0] === "hang") {
    await stream(conv, "working");
    await new Promise<void>(resolve => { turn.wake = resolve; if (turn.aborted) resolve(); });
    return { text: "", stopReason: "aborted" };
  }
  if (words[0] === "fail") return { text: "", stopReason: "error", error: "fake failure" };
  const text = words[0] === "count" ? `turns: ${conv.userMessages}` : `echo: ${prompt}`;
  await stream(conv, text);
  return { text, stopReason: "end_turn" };
}

async function runTurn(conv: Conv, prompt: string, awaiter: Conn | null, reqId: string | null, startedAt: number, turnId: string, replayed: boolean, awaiters: Turn["awaiters"] = []): Promise<void> {
  const turn: Turn = { turnId, prompt, awaiters: [...awaiters, ...(awaiter ? [{ conn: awaiter, reqId }] : [])], startedAt, aborted: false, wake: null, calls: new Map() };
  conv.turn = turn;
  if (!replayed) {
    conv.prompts.add(startedAt);
    conv.userMessages++;
    toSubscribers(conv, { type: "user_message", convId: conv.convId, text: prompt, startedAt });
  }
  toSubscribers(conv, { type: "streaming_started", convId: conv.convId, provider: conv.provider, model: conv.model, startedAt });
  let outcome: { text: string; stopReason: string; error?: string };
  try { outcome = await model(conv, turn, prompt); }
  catch (error) {
    if ((error as Error).message === "restart") { conv.turn = null; void restart(400, false); return; }
    outcome = { text: "", stopReason: "error", error: String(error) };
  }
  if (conv.turn !== turn) return; // deleted or restarted meanwhile
  if (turn.aborted) outcome = { text: outcome.text, stopReason: "aborted" };
  conv.turn = null;
  conv.lastActivityAt = Date.now();
  if (outcome.stopReason === "end_turn") {
    toSubscribers(conv, { type: "tokens_update", convId: conv.convId, tokens: outcome.text.length });
    toSubscribers(conv, { type: "message_complete", convId: conv.convId, blocks: [{ type: "text", text: outcome.text }], endedAt: Date.now(), tokens: outcome.text.length });
  } else {
    toSubscribers(conv, { type: "streaming_stopped", convId: conv.convId });
  }
  const result: Json = {
    type: "turn_result", convId: conv.convId, turnId, text: outcome.text, stopReason: outcome.stopReason,
    ...(outcome.error ? { error: outcome.error } : {}),
    usage: { outputTokens: outcome.text.length, durationMs: Date.now() - startedAt },
  };
  conv.lastTurnResult = result;
  for (const { conn, reqId } of turn.awaiters) if (!conn.socket.destroyed) write(conn, { ...result, reqId });
  const owner = ownerConn(conv);
  if (ownerResults && !(owner && turn.awaiters.some(entry => entry.conn === owner))) toOwner(conv, result);
  if (conv.lifetime === "ephemeral" && conv.runFinished && !conv.keep && conversations.has(conv.convId)) deleteConv(conv, "run_finished");
}

function abortTurn(conv: Conv, reason: "aborted" | "ended"): void {
  const turn = conv.turn;
  if (!turn) return;
  turn.aborted = true;
  for (const call of turn.calls.values()) {
    if (call.timer) clearTimeout(call.timer);
    write(ownerConn(conv), { type: "app_tool_cancel", convId: conv.convId, callId: call.callId, reason });
    call.resolve({ output: "interrupted", isError: true });
  }
  turn.calls.clear();
  for (const waiter of conv.ownerWaiters.splice(0)) waiter();
  turn.wake?.();
}

function deleteConv(conv: Conv, reason: string, reqId?: string, answer?: Conn): void {
  if (conv.turn) {
    const turn = conv.turn;
    abortTurn(conv, "ended");
    conv.turn = null;
    const result = { type: "turn_result", convId: conv.convId, turnId: turn.turnId, text: "", stopReason: "aborted" };
    for (const entry of turn.awaiters) write(entry.conn, { ...result, reqId: entry.reqId });
  }
  conversations.delete(conv.convId);
  const event = { type: "conversation_deleted", convId: conv.convId, reason };
  const targets = new Set(conv.subscribers);
  const owner = ownerConn(conv);
  if (owner) targets.add(owner);
  else if (conv.owner && sessionsEnabled) conv.owner.pending.push(event);
  if (answer) targets.delete(answer);
  for (const conn of targets) write(conn, event);
  if (answer) write(answer, { ...event, reqId });
}

function sendMessage(conn: Conn, conv: Conv, text: string, reqId: string | null, startedAt: number, awaited: boolean): void {
  // Like the daemon: a turn's identity is its prompt's startedAt.
  const turnId = String(startedAt);
  // The same prompt sent again after a reconnect: wait for its turn, never run it twice.
  if (awaited && sessionsEnabled && conv.prompts.has(startedAt)) {
    if (conv.lastTurnResult?.turnId === turnId) return write(conn, { ...conv.lastTurnResult, reqId });
    if (conv.turn?.turnId === turnId) { conv.turn.awaiters.push({ conn, reqId }); return; }
    if (conv.replay?.turnId === turnId) { (conv.replay.awaiters ??= []).push({ conn, reqId }); return; }
    return write(conn, { type: "error", reqId, convId: conv.convId, message: "That prompt was sent before and its turn's result is no longer known" });
  }
  if (conv.turn || conv.replay) return write(conn, { type: "error", reqId, convId: conv.convId, message: "Already streaming" });
  void runTurn(conv, text, awaited ? conn : null, reqId, startedAt, turnId, false);
}

function attach(conn: Conn, conv: Conv, reqId: string | undefined, tools?: Json[]): boolean {
  const session = sessionOf(conn);
  if (conv.lifetime === "ephemeral" && conv.owner && conv.owner !== session) {
    write(conn, { type: "error", reqId, convId: conv.convId, message: "An ephemeral conversation belongs to the session that created it" });
    return false;
  }
  if (tools !== undefined) {
    const toolError = validateAppTools(tools);
    if (toolError) { write(conn, { type: "error", reqId, convId: conv.convId, message: toolError }); return false; }
    conv.tools = tools;
  }
  conv.owner = session;
  write(conn, { type: "app_conversation_attached", reqId, convId: conv.convId, conversation: info(conv), ...(ownerResults ? { lastTurnResult: conv.lastTurnResult } : {}) });
  for (const waiter of conv.ownerWaiters.splice(0)) waiter();
  for (const call of conv.turn?.calls.values() ?? []) write(conn, { type: "app_tool_call", convId: conv.convId, callId: call.callId, name: call.name, input: call.input });
  return true;
}

function handle(conn: Conn, cmd: Json): void {
  received.push(cmd);
  const reqId = cmd.reqId;
  const error = (message: string, convId?: string) => write(conn, { type: "error", reqId, ...(convId ? { convId } : {}), message });
  if (cmd.type === "fake_exit") process.exit(0);
  if (cmd.type === "fake_restart") { write(conn, { type: "ack", reqId }); void restart(cmd.downMs ?? 300, Boolean(cmd.crash)); return; }
  if (cmd.type === "fake_drop") { for (const other of [...connections]) other.socket.destroy(); return; }
  if (cmd.type === "fake_state") {
    write(conn, { type: "fake_state", reqId, conversations: [...conversations.values()].map(info), received });
    return;
  }
  if (cmd.type === "client_capabilities") {
    if (!cmd.app) return;
    if (!APP_NAME.test(cmd.app.name ?? "")) return error(`app.name: invalid app name ${JSON.stringify(cmd.app.name)}`);
    conn.app = cmd.app.name;
    if (noWelcome) return;
    if (!sessionsEnabled) {
      write(conn, { type: "app_welcome", reqId, appApiVersion: apiVersion, app: conn.app, instance: "fake", pid: process.pid });
      write(conn, { type: "fake_unknown_event", note: "clients must ignore event types they do not know" });
      return;
    }
    let session = typeof cmd.app.session === "string" ? sessions.get(cmd.app.session) : undefined;
    const resumed = Boolean(session);
    if (!session) {
      session = { id: cmd.app.session ?? `fake-session-${++idCounter}-${Math.random().toString(36).slice(2, 12)}`, app: conn.app!, conn: null, graceMs: defaultGraceMs, timer: null, pending: [] };
      sessions.set(session.id, session);
    }
    if (typeof cmd.app.reconnectGraceMs === "number") session.graceMs = cmd.app.reconnectGraceMs;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    session.conn = conn;
    conn.session = session;
    const mine = owned(session);
    write(conn, { type: "app_welcome", reqId, appApiVersion: apiVersion, app: conn.app, instance: "fake", pid: process.pid, session: session.id, reconnectGraceMs: session.graceMs, resumed, conversations: mine.map(c => c.convId) });
    write(conn, { type: "fake_unknown_event", note: "clients must ignore event types they do not know" });
    for (const event of session.pending.splice(0)) write(conn, event);
    for (const conv of mine) {
      for (const waiter of conv.ownerWaiters.splice(0)) waiter();
      for (const call of conv.turn?.calls.values() ?? []) write(conn, { type: "app_tool_call", convId: conv.convId, callId: call.callId, name: call.name, input: call.input });
    }
    return;
  }
  if (!conn.app) return error("fake daemon: declare an app with client_capabilities first");
  const conv = cmd.convId ? conversations.get(cmd.convId) : undefined;
  if (conv) conv.lastActivityAt = Date.now();
  switch (cmd.type) {
    case "new_conversation": {
      const result = create(conn, cmd, "saved");
      if (typeof result === "string") return error(result);
      write(conn, created(result, reqId));
      return;
    }
    case "app_run": {
      if (typeof cmd.prompt !== "string" || !cmd.prompt) return error("prompt: required");
      // The same run sent again after a reconnect: carry on with its conversation.
      if (conv) {
        if (!attach(conn, conv, reqId)) return;
        sendMessage(conn, conv, cmd.prompt, reqId, cmd.startedAt ?? Date.now(), true);
        return;
      }
      const result = create(conn, cmd, "ephemeral");
      if (typeof result === "string") return error(result);
      result.runFinished = true;
      write(conn, created(result, reqId));
      sendMessage(conn, result, cmd.prompt, reqId, cmd.startedAt ?? Date.now(), true);
      return;
    }
    case "send_message": {
      if (!conv) return error(`Conversation not found: ${cmd.convId}`, cmd.convId);
      sendMessage(conn, conv, cmd.text, reqId, cmd.startedAt ?? Date.now(), Boolean(cmd.awaitResult));
      return;
    }
    case "attach_app_conversation": {
      if (!conv) return error(`App conversation ${cmd.convId} not found`, cmd.convId);
      if (cmd.route !== undefined) conv.route = cmd.route ?? undefined;
      attach(conn, conv, reqId, cmd.tools?.app);
      return;
    }
    case "end_app_session": {
      const session = conn.session;
      const ended: string[] = [];
      if (session) {
        sessions.delete(session.id);
        conn.session = null;
        for (const owned_ of owned(session)) {
          owned_.owner = null;
          if (owned_.lifetime === "ephemeral") { deleteConv(owned_, "owner_disconnected"); ended.push(owned_.convId); }
        }
      }
      write(conn, { type: "app_session_ended", reqId, ended });
      return;
    }
    case "app_tool_result": {
      const call = conv?.turn?.calls.get(cmd.callId);
      if (!conv || !call || ownerConn(conv) !== conn) return;
      conv.turn!.calls.delete(cmd.callId);
      if (call.timer) clearTimeout(call.timer);
      call.resolve({ output: String(cmd.output), isError: Boolean(cmd.isError) });
      return;
    }
    case "abort": {
      if (!conv) return error(`Conversation not found: ${cmd.convId}`, cmd.convId);
      abortTurn(conv, "aborted");
      write(conn, { type: "ack", reqId, convId: conv.convId });
      return;
    }
    case "delete_conversation": {
      if (!conv) return error(`App conversation ${cmd.convId} not found`, cmd.convId);
      deleteConv(conv, "deleted", reqId, conn);
      return;
    }
    case "subscribe": {
      if (!conv) return error(`Conversation not found: ${cmd.convId}`, cmd.convId);
      conv.subscribers.add(conn);
      write(conn, { type: "ack", reqId, convId: conv.convId });
      return;
    }
    case "list_app_conversations": {
      const list = [...conversations.values()].filter(c => (!cmd.app || c.app === cmd.app) && (cmd.includeSaved || c.lifetime !== "saved"));
      write(conn, { type: "app_conversations_list", reqId, conversations: list.map(info) });
      return;
    }
    case "ping": write(conn, { type: "pong", reqId }); return;
    default: return error(`Unknown command: ${cmd.type}`);
  }
}

function dropConnection(conn: Conn, restarting = false): void {
  if (!connections.delete(conn)) return;
  for (const conv of conversations.values()) conv.subscribers.delete(conn);
  const session = conn.session;
  if (!session || session.conn !== conn) return;
  session.conn = null;
  // A restart starts the grace when the daemon is back.
  if (restarting) return;
  if (!sessionsEnabled || session.graceMs === 0) {
    sessions.delete(session.id);
    for (const conv of owned(session)) {
      conv.owner = null;
      if (conv.lifetime === "ephemeral") deleteConv(conv, "owner_disconnected");
    }
    return;
  }
  armGrace(session);
}

function listen(): Promise<void> {
  if (existsSync(socketPath!)) unlinkSync(socketPath!);
  server = createServer(socket => {
    if (Date.now() < refuseUntil) { socket.destroy(); return; }
    const conn: Conn = { socket, app: null, id: ++connCounter, session: null };
    connections.add(conn);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (data: string) => {
      buffer += data;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let cmd: Json;
        try { cmd = JSON.parse(line); } catch { write(conn, { type: "error", message: "Invalid JSON" }); continue; }
        handle(conn, cmd);
      }
    });
    socket.on("close", () => dropConnection(conn));
    socket.on("error", () => {});
  });
  return new Promise((resolve, reject) => { server!.once("error", reject); server!.listen(socketPath, () => resolve()); });
}

/**
 * A graceful restart (sessions and every conversation carry on, interrupted
 * turns are replayed), or with `crash` (or --no-sessions) one that loses the
 * sessions and the ephemeral conversations.
 */
async function restart(downMs: number, crash: boolean): Promise<void> {
  const old = server;
  server = null;
  const closed = new Promise<void>(resolve => (old ? old.close(() => resolve()) : resolve()));
  for (const conn of [...connections]) { conn.socket.destroy(); dropConnection(conn, true); }
  await closed;
  const loses = crash || !sessionsEnabled;
  for (const conv of [...conversations.values()]) {
    if (conv.lifetime === "ephemeral" && loses) { conversations.delete(conv.convId); continue; }
    if (conv.turn) { abortTurn(conv, "ended"); conv.replay = { prompt: conv.turn.prompt, turnId: conv.turn.turnId, startedAt: conv.turn.startedAt }; conv.turn = null; }
    if (loses) conv.owner = null;
    conv.subscribers.clear();
  }
  if (loses) sessions.clear();
  for (const session of sessions.values()) if (session.timer) { clearTimeout(session.timer); session.timer = null; }
  await sleep(downMs);
  refuseUntil = Date.now() + refuseAfterRestartMs;
  await listen();
  for (const session of [...sessions.values()]) if (!session.conn) armGrace(session);
  for (const conv of conversations.values()) {
    const replay = conv.replay;
    if (!replay) continue;
    // Like the real daemon's replay: the turn runs again, awaited only by those who sent it again.
    setTimeout(() => {
      if (conv.replay !== replay || !conversations.has(conv.convId)) return;
      conv.replay = null;
      void runTurn(conv, replay.prompt, null, null, replay.startedAt, replay.turnId, true, replay.awaiters ?? []);
    }, refuseAfterRestartMs ? 0 : 200);
  }
}

await listen();
process.stdout.write(`ready ${process.pid}\n`);
const shutdown = () => { try { server?.close(); if (existsSync(socketPath!)) unlinkSync(socketPath!); } finally { process.exit(0); } };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.stdin.resume();
