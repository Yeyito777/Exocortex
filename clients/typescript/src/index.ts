/**
 * @exocortex/client: use the user's Exocortex daemon from a program
 * (docs/app-api.md). Dependency-free; runs on Bun and on Node 22.18+ (which
 * strips these types itself). Only erasable TypeScript syntax is used here.
 */
import { connect as netConnect, type Socket } from "node:net";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

/** The app API version this client speaks. */
export const APP_API_VERSION = 1;
export const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/Yeyito777/Exocortex/main/install.sh | bash";

// ── Protocol shapes (mirroring shared/src/app-api.ts; copied, never imported) ──

export type Lifetime = "saved" | "temporary" | "ephemeral";
export type SystemBase = "none" | "agent" | "full";
export type StopReason = "end_turn" | "aborted" | "error";

export interface SystemSpec { text?: string; base?: SystemBase }

/** How the conversation's Claude turns may be billed (docs/app-api.md). */
export interface RouteSpec {
  /** "allow" (default): API credits while every subscription is limited; "never": subscriptions only. */
  credits?: "allow" | "never";
  /** "wait" (default) until something can run the turn, or "error" at once (TurnResult.limited). */
  whenLimited?: "wait" | "error";
}

export interface AppToolDef {
  name: string;
  description: string;
  /** JSON Schema of the input; an object schema. */
  inputSchema: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ToolCallContext {
  convId: string;
  callId: string;
  /** Aborted when the daemon cancels the call (turn aborted, timed out, conversation ended). */
  signal: AbortSignal;
}

/** A handler's answer: text, `{output, isError}`, or anything else (sent as JSON). Throwing gives the model an error result. */
export type ToolOutput = string | { output: string; isError?: boolean } | unknown;

export interface AppTool extends AppToolDef {
  handler: (input: any, ctx: ToolCallContext) => ToolOutput | Promise<ToolOutput>;
}

export interface ToolsSpec {
  /** Built-in tools by neutral name (`bash`, `read`, `grep`, …) or "all". */
  builtin?: string[] | "all";
  /** Tools this program defines and answers. */
  app?: AppTool[];
}

export interface AppConversationInfo {
  convId: string;
  app: string;
  lifetime: Lifetime;
  title: string;
  provider: string;
  model: string;
  effort?: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt?: number;
  idleTtlMs?: number;
  ownerConnected: boolean;
  streaming: boolean;
  cwd?: string;
  workspace?: string;
  systemBase: SystemBase;
  builtinTools: string[] | "all";
  appTools: string[];
  route?: RouteSpec;
  /** The Claude account its turns last ran on, if any. */
  account?: string;
  billing?: "api-credits";
}

export interface TurnResult {
  convId: string;
  text: string;
  stopReason: StopReason;
  error?: string;
  usage?: { outputTokens: number; durationMs: number };
  /** The daemon's turn identity, when it sends one. */
  turnId?: string;
  /** "api-credits" when (some of) the turn ran on Claude API credits. */
  billing?: "api-credits";
  /** The turn stopped at a usage limit (`route.whenLimited: "error"`); `resetAt` in ms when known. */
  limited?: { resetAt: number | null };
  /** The raw turn_result event (or a reconstruction after a reconnect). */
  raw: Record<string, any>;
}

export interface Welcome {
  appApiVersion: number;
  app: string;
  instance: string;
  pid: number;
  /** The session token; absent from a daemon older than sessions. */
  session?: string;
  reconnectGraceMs?: number;
  /** The session was known: the conversations it owns are this client's again. */
  resumed?: boolean;
  conversations?: string[];
  /** The daemon catches this client up with running turns (turn_catchup): streams never miss or repeat text. */
  turnCatchup?: boolean;
}

/**
 * What a turn's stream yields. Everything else is available raw through `onEvent`.
 * `reset`: the daemon replaced what the stream showed (a provider retry); everything
 * the turn shows now follows it again from the start. Rare; never for a reconnect.
 */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean }
  | { type: "reset" };

export interface ConversationOptions {
  lifetime?: Lifetime;
  /** temporary only: deleted this long after its last activity (default 1 h). */
  idleTtlMs?: number;
  title?: string;
  /** The system prompt: text alone (base "none"), or `{text, base}`. */
  system?: string | SystemSpec;
  tools?: ToolsSpec;
  provider?: string;
  model?: string;
  effort?: string;
  /** An existing absolute directory tools run in. */
  cwd?: string;
  /** A client-chosen conversation id (default: one the client makes). */
  convId?: string;
  route?: RouteSpec;
}

export interface SendOptions {
  images?: unknown[];
  /** Every raw daemon event of this conversation during the turn. */
  onEvent?: (event: Record<string, any>) => void;
}

export interface RunOptions extends ConversationOptions, SendOptions {
  /** Default "ephemeral". */
  lifetime?: Lifetime;
  /** Keep an ephemeral conversation after the run (it ends with the client's session). */
  keep?: boolean;
}

export interface ConnectOptions {
  /** The app's name, `^[a-z0-9][a-z0-9-]{0,39}$`. */
  app: string;
  version?: string;
  /** The daemon's socket; default: $EXOCORTEX_SOCKET, then `exocortexd socket`. */
  socket?: string;
  /**
   * Ride out a dropped connection or a daemon restart: reconnect under the session,
   * take the conversations back and send again what was in flight. Default true.
   */
  reconnect?: boolean;
  /** Give up reconnecting after this long. Default 300 s. */
  reconnectTimeoutMs?: number;
  /** How long the daemon keeps this session's ephemeral conversations while it is away (default: the daemon's, 2 min). */
  reconnectGraceMs?: number;
  /** A session token to take back (`client.session` of an earlier client). */
  session?: string;
  /** A one-shot run whose conversation the daemon lost (a crash) runs again on a new one. Default true. */
  rerunLost?: boolean;
  /** How long to wait for app_welcome. Default 5 s. */
  welcomeTimeoutMs?: number;
  /** Timeout for requests other than turns. Default 30 s. */
  requestTimeoutMs?: number;
}

export type ErrorCode =
  | "not_installed" | "not_running" | "too_old" | "incompatible" | "daemon"
  | "disconnected" | "closed" | "ended" | "lost" | "timeout" | "result_lost";

export class ExocortexError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ExocortexError";
    this.code = code;
  }
}

// ── Discovery ──────────────────────────────────────────────────────────

/** `exocortexd doctor --json`'s problems as lines for an error message; "" when none or it cannot run. */
async function doctorProblems(): Promise<string> {
  return new Promise(resolve => {
    execFile("exocortexd", ["doctor", "--json"], { timeout: 20_000, maxBuffer: 4 << 20 }, (_error, stdout) => {
      try {
        const problems: any[] = JSON.parse(String(stdout)).problems ?? [];
        resolve(problems.map(p => `\n  - ${p.message}${p.fix ? ` Fix: ${p.fix}` : ""}`).join(""));
      } catch { resolve(""); }
    });
  });
}

/** The daemon's socket path: $EXOCORTEX_SOCKET, else `exocortexd socket`. Throws a clear error otherwise. */
export async function findSocket(): Promise<string> {
  const fromEnv = process.env.EXOCORTEX_SOCKET?.trim();
  if (fromEnv) return fromEnv;
  const printed = await new Promise<string | null>((resolve, reject) => {
    execFile("exocortexd", ["socket"], { timeout: 10_000 }, (error, stdout) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") resolve(null);
      else if (error) reject(new ExocortexError("not_running", `\`exocortexd socket\` failed: ${error.message.trim()}`));
      else resolve(stdout.trim());
    });
  });
  if (printed === null) throw new ExocortexError("not_installed", `Exocortex is not installed (no \`exocortexd\` on PATH). Install it with:\n  ${INSTALL_COMMAND}`);
  if (!printed) throw new ExocortexError("not_running", "`exocortexd socket` printed nothing; is Exocortex installed correctly?");
  if (!existsSync(printed)) throw new ExocortexError("not_running", `The Exocortex daemon is not running (no socket at ${printed}). Start it with: exocortexd start${await doctorProblems()}`);
  return printed;
}

// ── Line transport ────────────────────────────────────────────────────

function openSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(path);
    const fail = (error: Error) => {
      socket.destroy();
      const code = (error as NodeJS.ErrnoException).code;
      reject(code === "ENOENT" || code === "ECONNREFUSED"
        ? new ExocortexError("not_running", `The Exocortex daemon is not running (cannot connect to ${path}). Start it with: exocortexd start`)
        : error);
    };
    socket.once("error", fail);
    socket.once("connect", () => { socket.off("error", fail); resolve(socket); });
  });
}

interface PendingRequest {
  match: (event: Record<string, any>) => boolean;
  resolve: (event: Record<string, any>) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingTurn {
  reqId: string;
  convId: string;
  /** The daemon's turn identity: the prompt's startedAt, as a string. */
  turnId: string;
  /** The connection this turn's command went out on; -1 before it went out. */
  generation: number;
  /** The send_message or app_run that started it, sent again (same startedAt) after a reconnect. */
  command: Record<string, any>;
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  onEvent?: (event: Record<string, any>) => void;
  stream?: TurnStream;
  /** app_run: the tools of the conversation it creates. */
  runTools?: AppTool[];
  /** What its stream has shown, as the turn's blocks (with a daemon that sends turn catch-ups). */
  shown?: Block[];
  /** `shown` is the conversation's live turn: a stream event passes straight through. */
  synced?: boolean;
}

// ── Following a turn (turn_catchup) ───────────────────────────────────

type Block = Record<string, any>;

/** A conversation's running turn as this client knows it: from a turn_catchup, then newer stream events. */
interface LiveTurn { turnId: string | null; blocks: Block[]; seq: number; offset: number }

const BLOCK_EVENTS = new Set(["block_start", "text_chunk", "thinking_chunk", "tool_call", "tool_result"]);

/** Apply a stream event to blocks, as the daemon builds a turn's blocks from its events. */
function applyStreamEvent(blocks: Block[], event: Record<string, any>): void {
  if (event.type === "block_start") blocks.push({ type: event.blockType, text: "" });
  else if (event.type === "text_chunk" || event.type === "thinking_chunk") {
    const type = event.type === "text_chunk" ? "text" : "thinking";
    const last = blocks.at(-1);
    if (last?.type === type) last.text += event.text; else blocks.push({ type, text: event.text });
  } else if (event.type === "tool_call") blocks.push({ type: "tool_call", toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
  else if (event.type === "tool_result") blocks.push({ type: "tool_result", toolCallId: event.toolCallId, toolName: event.toolName, output: event.output, isError: event.isError });
}

/** The stream event that shows a block, from character `from` of its text. */
function blockEvent(block: Block, from = 0): StreamEvent | null {
  if (block.type === "text" || block.type === "thinking") {
    const text = String(block.text ?? "").slice(from);
    return text ? { type: block.type, text } : null;
  }
  if (block.type === "tool_call") return { type: "tool_call", id: block.toolCallId, name: block.toolName, input: block.input ?? {} };
  if (block.type === "tool_result") return { type: "tool_result", id: block.toolCallId, name: block.toolName ?? "", output: block.output ?? "", isError: Boolean(block.isError) };
  return null;
}

type Comparison = { kind: "extends"; events: StreamEvent[] } | { kind: "behind" } | { kind: "diverged" };

/**
 * How a turn's blocks stand to what a stream showed: "extends" it (with the new part as
 * stream events), "behind" (it agrees but has not reached all of it yet: a replay after a
 * restart sending the turn again from its start), or "diverged".
 */
function compare(shown: Block[], target: Block[]): Comparison {
  const common = Math.min(shown.length, target.length);
  for (let i = 0; i < common; i++) {
    const was = shown[i]!, now = target[i]!;
    if (now.type !== was.type) return { kind: "diverged" };
    if (was.type === "text" || was.type === "thinking") {
      const a = String(was.text ?? ""), b = String(now.text ?? "");
      // Texts may differ only at the end of one side: the turn grew past the stream, or not up to it yet.
      if (a !== b && !(b.startsWith(a) && i === shown.length - 1) && !(a.startsWith(b) && i === target.length - 1)) return { kind: "diverged" };
    } else if (now.toolCallId !== was.toolCallId) return { kind: "diverged" };
  }
  if (target.length < shown.length) return { kind: "behind" };
  const last = shown.length - 1;
  const events: StreamEvent[] = [];
  if (last >= 0 && (shown[last]!.type === "text" || shown[last]!.type === "thinking")) {
    const had = String(shown[last]!.text ?? "").length, has = String(target[last]!.text ?? "").length;
    if (has < had) return { kind: "behind" };
    const grown = blockEvent(target[last]!, had);
    if (grown) events.push(grown);
  }
  for (let i = shown.length; i < target.length; i++) {
    const event = blockEvent(target[i]!);
    if (event) events.push(event);
  }
  return { kind: "extends", events };
}

function toResult(event: Record<string, any>): TurnResult {
  return {
    convId: event.convId, text: event.text ?? "", stopReason: event.stopReason,
    ...(event.error ? { error: event.error } : {}),
    ...(event.usage ? { usage: event.usage } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.billing ? { billing: event.billing } : {}),
    ...(event.limited ? { limited: event.limited } : {}),
    raw: event,
  };
}

function systemSpec(system: string | SystemSpec | undefined): SystemSpec | undefined {
  return typeof system === "string" ? { text: system } : system;
}

function toolDefs(tools: AppTool[] | undefined): AppToolDef[] | undefined {
  return tools?.map(({ name, description, inputSchema, timeoutMs }) => ({ name, description, inputSchema, ...(timeoutMs ? { timeoutMs } : {}) }));
}

function toolsWire(tools: ToolsSpec | undefined): Record<string, unknown> | undefined {
  if (!tools) return undefined;
  return { ...(tools.builtin !== undefined ? { builtin: tools.builtin } : {}), ...(tools.app ? { app: toolDefs(tools.app) } : {}) };
}

/** A conversation id of our own, so a create sent again after a reconnect is recognized. */
function newConvId(): string {
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)];
  return `${Date.now()}-${suffix}`;
}

function createFields(options: ConversationOptions): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    lifetime: options.lifetime, idleTtlMs: options.idleTtlMs, title: options.title,
    system: systemSpec(options.system), tools: toolsWire(options.tools),
    provider: options.provider, model: options.model, effort: options.effort,
    cwd: options.cwd, convId: options.convId ?? newConvId(), route: options.route,
  };
  for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
  return fields;
}

// ── Streams ────────────────────────────────────────────────────────────

/** One turn: iterate it for text deltas and tool events; `result` resolves when it ends. */
export class TurnStream implements AsyncIterable<StreamEvent> {
  readonly result: Promise<TurnResult>;
  private queue: StreamEvent[] = [];
  private waiting: ((value: IteratorResult<StreamEvent>) => void) | null = null;
  private done = false;
  private failure: Error | null = null;
  private failWaiting: ((error: Error) => void) | null = null;

  constructor(result: Promise<TurnResult>) {
    this.result = result;
    result.then(() => this.finish(null), error => this.finish(error));
    // The iterator rethrows the failure; an unread result must not be an unhandled rejection.
    result.catch(() => {});
  }

  /** @internal */
  push(event: StreamEvent): void {
    if (this.done) return;
    if (this.waiting) { const wake = this.waiting; this.waiting = null; this.failWaiting = null; wake({ value: event, done: false }); }
    else this.queue.push(event);
  }

  private finish(error: Error | null): void {
    if (this.done) return;
    this.done = true;
    this.failure = error;
    if (this.waiting) {
      const wake = this.waiting, fail = this.failWaiting;
      this.waiting = null; this.failWaiting = null;
      if (error && fail) fail(error); else wake({ value: undefined, done: true });
    }
  }

  /** The reply's text, streamed: just the text deltas. */
  async *text(): AsyncGenerator<string> {
    for await (const event of this) if (event.type === "text") yield event.text;
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
        if (this.done) return this.failure ? Promise.reject(this.failure) : Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => { this.waiting = resolve; this.failWaiting = reject; });
      },
      return: () => { this.done = true; this.queue = []; return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

// ── Conversation ───────────────────────────────────────────────────────

/** An app conversation this client owns. */
export class Conversation {
  readonly id: string;
  /** How the daemon last reported it. */
  info: AppConversationInfo;
  /** Set once it is gone (deleted, expired, owner_disconnected, lost, ...). */
  ended: string | null = null;
  /** @internal */ handlers = new Map<string, AppTool>();
  /** @internal */ tools: AppTool[] | undefined;
  private client: Client;

  /** @internal */
  constructor(client: Client, info: AppConversationInfo, tools: AppTool[] | undefined) {
    this.client = client;
    this.id = info.convId;
    this.info = info;
    this.setHandlers(tools);
  }

  /** @internal */
  setHandlers(tools: AppTool[] | undefined): void {
    this.tools = tools;
    this.handlers = new Map((tools ?? []).map(tool => [tool.name, tool]));
  }

  /** Send a prompt and wait for the turn to end. */
  send(prompt: string, options: SendOptions = {}): Promise<TurnResult> {
    return this.client.sendTurn(this, prompt, options, null);
  }

  /** Send a prompt and stream the reply: `for await (const e of conv.stream(p))`, then `await stream.result`. */
  stream(prompt: string, options: SendOptions = {}): TurnStream {
    let stream!: TurnStream;
    const result = this.client.sendTurn(this, prompt, options, () => stream);
    stream = new TurnStream(result);
    return stream;
  }

  /**
   * The turn running now (one this client did not send: after attach(), or a queued
   * message's), streamed from its start: what it showed so far, then live. Null when none
   * runs, or with a daemon that sends no turn catch-ups.
   */
  follow(): TurnStream | null {
    return this.client.followTurn(this);
  }

  /** Abort the running turn, if any. */
  async abort(): Promise<void> {
    await this.client.request({ type: "abort", convId: this.id }, event => event.type === "ack");
  }

  /** Replace the app tools (handlers and definitions) from the next turn on. */
  async setTools(tools: AppTool[]): Promise<void> {
    this.setHandlers(tools);
    await this.client.attachExisting(this);
  }

  /** Delete it for good (a running turn is aborted first). */
  async delete(): Promise<void> {
    await this.client.delete(this.id);
  }
}

// ── Client ─────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type ClientOptions = Required<Pick<ConnectOptions, "reconnect" | "reconnectTimeoutMs" | "welcomeTimeoutMs" | "requestTimeoutMs" | "rerunLost">>
  & Omit<ConnectOptions, "reconnect" | "reconnectTimeoutMs" | "welcomeTimeoutMs" | "requestTimeoutMs" | "rerunLost">;

/**
 * A connection to the daemon, declared as one app. It survives a dropped
 * connection and a daemon restart: it reconnects with backoff under its
 * session token, takes its conversations back, and sends whatever was in
 * flight again (the daemon never runs a prompt twice), so a send or a run
 * sees a delay instead of an error. Requests made while it is reconnecting
 * wait for it.
 */
export class Client {
  readonly app: string;
  welcome!: Welcome;
  /** The session token (app_welcome.session): conversations belong to it, not to the socket. */
  session: string | null;
  private options: ClientOptions;
  private socketPath = "";
  private socket: Socket | null = null;
  /** The handshake on the current socket is done. */
  private connected = false;
  private connectedWaiters: Array<(connected: boolean) => void> = [];
  private generation = 0;
  private reqCounter = 0;
  private lastStartedAt = 0;
  private buffer = "";
  private closed = false;
  private closing: Promise<void> | null = null;
  private reconnecting: Promise<void> | null = null;
  private requests = new Map<string, PendingRequest>();
  private turns = new Map<string, PendingTurn>();
  private conversations = new Map<string, Conversation>();
  /** Running turns as caught up (turn_catchup) and followed since, by conversation. */
  private live = new Map<string, LiveTurn>();
  private followCounter = 0;
  /** This connection's welcome said turnCatchup (read as it arrives: catch-ups may follow it at once). */
  private turnCatchup = false;
  /** In-flight and recently finished app tool calls by callId (the daemon re-sends unanswered ones after a reconnect). */
  private calls = new Map<string, { controller: AbortController; result?: { output: string; isError: boolean }; convId: string }>();
  private listeners = new Set<(event: Record<string, any>) => void>();

  /** @internal Use `connect()`. */
  constructor(options: ConnectOptions) {
    this.app = options.app;
    this.session = options.session ?? null;
    this.options = {
      reconnect: true, reconnectTimeoutMs: 300_000, welcomeTimeoutMs: 5_000, requestTimeoutMs: 30_000, rerunLost: true,
      ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as ConnectOptions,
    };
  }

  /** @internal */
  async open(): Promise<void> {
    this.socketPath = this.options.socket ?? await findSocket();
    try { await this.handshake(); }
    catch (error) {
      // A discovered socket nobody answers on: say what `exocortexd doctor` finds wrong.
      if (error instanceof ExocortexError && error.code === "not_running" && !this.options.socket && !process.env.EXOCORTEX_SOCKET?.trim()) {
        throw new ExocortexError("not_running", error.message + await doctorProblems());
      }
      throw error;
    }
  }

  private async handshake(): Promise<void> {
    const socket = await openSocket(this.socketPath);
    if (this.closed) { socket.destroy(); throw new ExocortexError("closed", "The client was closed"); }
    const generation = ++this.generation;
    this.socket = socket;
    this.connected = false;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => { if (this.socket === socket) this.onData(data); });
    socket.on("error", () => {});
    let ready = false;
    socket.on("close", () => {
      if (this.socket !== socket) return;
      if (ready) return this.onClose(generation);
      this.socket = null;
      this.failRequests(new ExocortexError("disconnected", "The daemon closed the connection before app_welcome"));
    });
    const app: Record<string, unknown> = { name: this.app };
    if (this.options.version) app.version = this.options.version;
    if (this.session) app.session = this.session;
    if (this.options.reconnectGraceMs !== undefined) app.reconnectGraceMs = this.options.reconnectGraceMs;
    const welcome = await this.exchange(
      { type: "client_capabilities", capabilities: ["turn-catchup"], app },
      event => event.type === "app_welcome",
      this.options.welcomeTimeoutMs, false,
    ).catch(error => {
      socket.destroy();
      if (error instanceof ExocortexError && error.code === "timeout") {
        throw new ExocortexError("too_old", `The Exocortex daemon did not answer app_welcome: it is too old for the app API. Update it with:\n  ${INSTALL_COMMAND}`);
      }
      throw error;
    });
    if (welcome.appApiVersion !== APP_API_VERSION) {
      socket.destroy();
      const newer = welcome.appApiVersion > APP_API_VERSION;
      throw new ExocortexError("incompatible", newer
        ? `The Exocortex daemon speaks app API v${welcome.appApiVersion}; this client knows v${APP_API_VERSION}. Update @exocortex/client.`
        : `The Exocortex daemon speaks app API v${welcome.appApiVersion}; this client needs v${APP_API_VERSION}. Update Exocortex:\n  ${INSTALL_COMMAND}`);
    }
    const { appApiVersion, instance, pid, session, reconnectGraceMs, resumed, conversations, turnCatchup } = welcome;
    this.welcome = { appApiVersion, app: welcome.app, instance, pid, ...(session ? { session, reconnectGraceMs, resumed, conversations } : {}), ...(turnCatchup ? { turnCatchup: true } : {}) };
    if (session) this.session = session;
    ready = true;
    if (this.socket !== socket) throw new ExocortexError("disconnected", "The daemon closed the connection");
    this.connected = true;
    for (const wake of this.connectedWaiters.splice(0)) wake(true);
  }

  /** Listen to every daemon event this connection receives. Returns an unsubscribe function. */
  onEvent(listener: (event: Record<string, any>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Send a raw command and wait for the answer `match` accepts (or an `error` with its reqId).
   * While reconnecting it waits for the connection; a request the connection dropped under is
   * sent again once reconnected, unless `retry` is false.
   */
  request(command: Record<string, any>, match: (event: Record<string, any>) => boolean, timeoutMs = this.options.requestTimeoutMs, retry = true): Promise<Record<string, any>> {
    if (this.closed || this.closing) return Promise.reject(new ExocortexError("closed", "The client was closed"));
    return this.exchange(command, match, timeoutMs, retry);
  }

  private async exchange(command: Record<string, any>, match: (event: Record<string, any>) => boolean, timeoutMs: number, retry: boolean): Promise<Record<string, any>> {
    let reqId: string = command.reqId ?? this.nextReqId();
    for (;;) {
      try {
        if (!this.connected && retry) await this.waitConnected();
        return await this.exchangeOnce({ ...command, reqId }, match, timeoutMs);
      } catch (error) {
        if (!(error instanceof ExocortexError) || error.code !== "disconnected" || !retry || !await this.waitConnected()) throw error;
      }
      reqId = this.nextReqId();
    }
  }

  private exchangeOnce(command: Record<string, any>, match: (event: Record<string, any>) => boolean, timeoutMs: number): Promise<Record<string, any>> {
    const reqId: string = command.reqId;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { match, resolve, reject };
      this.requests.set(reqId, pending);
      try { this.write(command); }
      catch (error) { this.requests.delete(reqId); reject(error); return; }
      if (timeoutMs > 0) pending.timer = setTimeout(() => {
        this.requests.delete(reqId);
        reject(new ExocortexError("timeout", `No answer to ${command.type} within ${timeoutMs} ms`));
      }, timeoutMs);
    });
  }

  /** While reconnecting: wait until connected again (true) or given up (false). */
  private waitConnected(): Promise<boolean> {
    if (this.closed || !this.options.reconnect) return Promise.resolve(false);
    if (this.connected) return Promise.resolve(true);
    return new Promise(resolve => {
      const wake = (connected: boolean) => { clearTimeout(timer); resolve(connected && !this.closed); };
      const timer = setTimeout(() => {
        this.connectedWaiters = this.connectedWaiters.filter(w => w !== wake);
        resolve(false);
      }, this.options.reconnectTimeoutMs);
      this.connectedWaiters.push(wake);
    });
  }

  /** Create a conversation. */
  async conversation(options: ConversationOptions = {}): Promise<Conversation> {
    const fields = createFields(options);
    let event: Record<string, any>;
    try { event = await this.request({ type: "new_conversation", ...fields }, e => e.type === "conversation_created"); }
    catch (error) {
      // Made by an earlier attempt whose answer a dropped connection lost: it is ours.
      if (error instanceof ExocortexError && error.code === "daemon" && error.message.includes("already exists") && !options.convId) {
        return this.attach(fields.convId as string, { tools: options.tools?.app });
      }
      throw error;
    }
    const conversation = new Conversation(this, event.app, options.tools?.app);
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  /** Own an existing saved or temporary conversation (after this program restarts). `tools` replaces its app tools. */
  async attach(convId: string, options: { tools?: AppTool[] } = {}): Promise<Conversation> {
    const event = await this.request(
      { type: "attach_app_conversation", convId, ...(options.tools ? { tools: { app: toolDefs(options.tools) } } : {}) },
      e => e.type === "app_conversation_attached",
    );
    let conversation = this.conversations.get(convId);
    if (conversation) { conversation.info = event.conversation; if (options.tools) conversation.setHandlers(options.tools); }
    else {
      conversation = new Conversation(this, event.conversation, options.tools);
      this.conversations.set(convId, conversation);
    }
    return conversation;
  }

  /** @internal Re-send the attach for a conversation this client owns, with its current tools. */
  async attachExisting(conversation: Conversation, retry = true): Promise<Record<string, any>> {
    const event = await this.exchange(
      { type: "attach_app_conversation", convId: conversation.id, ...(conversation.tools ? { tools: { app: toolDefs(conversation.tools) } } : {}) },
      e => e.type === "app_conversation_attached", this.options.requestTimeoutMs, retry,
    );
    conversation.info = event.conversation;
    return event;
  }

  /** One-shot: create (ephemeral by default), send, await. */
  run(prompt: string, options: RunOptions = {}): Promise<TurnResult> {
    return this.startRun(prompt, options, null);
  }

  /** One-shot, streamed. */
  runStream(prompt: string, options: RunOptions = {}): TurnStream {
    let stream!: TurnStream;
    const result = this.startRun(prompt, options, () => stream);
    stream = new TurnStream(result);
    return stream;
  }

  /** Live hidden app conversations (this app's unless `allApps`), and saved ones with `includeSaved`. */
  async list(options: { includeSaved?: boolean; allApps?: boolean; app?: string } = {}): Promise<AppConversationInfo[]> {
    const event = await this.request(
      { type: "list_app_conversations", ...(options.allApps ? {} : { app: options.app ?? this.app }), ...(options.includeSaved ? { includeSaved: true } : {}) },
      e => e.type === "app_conversations_list",
    );
    return event.conversations;
  }

  /** Delete an app conversation for good. */
  async delete(convId: string): Promise<void> {
    try { await this.request({ type: "delete_conversation", convId }, e => e.type === "conversation_deleted" && e.convId === convId); }
    catch (error) {
      // Gone already: an earlier attempt went through before the connection dropped, or it ended.
      if (!(error instanceof ExocortexError) || error.code !== "daemon" || !error.message.includes("not found")) throw error;
    }
    this.endConversation(convId, "deleted");
  }

  /** Close the connection. Ephemeral conversations end now; saved and temporary ones stay. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      if (this.connected && this.welcome?.session) {
        // Without it they would wait out the session's reconnect grace.
        await this.exchange({ type: "end_app_session" }, e => e.type === "app_session_ended", 2_000, false).catch(() => {});
      }
      this.closed = true;
      this.failAll(new ExocortexError("closed", "The client was closed"));
      this.socket?.end();
      this.socket = null;
      this.connected = false;
    })();
    return this.closing;
  }

  // ── Turns ──

  /** @internal */
  sendTurn(conversation: Conversation, prompt: string, options: SendOptions, stream: (() => TurnStream) | null): Promise<TurnResult> {
    if (conversation.ended) return Promise.reject(new ExocortexError("ended", `Conversation ${conversation.id} has ended (${conversation.ended})`));
    const reqId = this.nextReqId();
    const startedAt = this.nextStartedAt();
    const command = { type: "send_message", reqId, convId: conversation.id, text: prompt, startedAt, awaitResult: true, ...(options.images ? { images: options.images } : {}) };
    return this.startTurn({ reqId, convId: conversation.id, turnId: String(startedAt), generation: -1, command, resolve: () => {}, reject: () => {}, onEvent: options.onEvent }, stream);
  }

  private startRun(prompt: string, options: RunOptions, stream: (() => TurnStream) | null): Promise<TurnResult> {
    const reqId = this.nextReqId();
    const startedAt = this.nextStartedAt();
    const fields = createFields(options);
    const command = { type: "app_run", reqId, ...fields, prompt, startedAt, ...(options.images ? { images: options.images } : {}), ...(options.keep ? { keep: true } : {}) };
    return this.startTurn({ reqId, convId: fields.convId as string, turnId: String(startedAt), generation: -1, command, resolve: () => {}, reject: () => {}, onEvent: options.onEvent, runTools: options.tools?.app }, stream);
  }

  private startTurn(turn: PendingTurn, stream: (() => TurnStream) | null): Promise<TurnResult> {
    if (this.closed || this.closing) return Promise.reject(new ExocortexError("closed", "The client was closed"));
    if (!this.options.reconnect && !this.connected) return Promise.reject(new ExocortexError("disconnected", "Not connected to the Exocortex daemon"));
    if (stream) Object.defineProperty(turn, "stream", { get: stream });
    return new Promise((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
      this.turns.set(turn.reqId, turn);
      // Not connected now: the reconnect sends it.
      this.sendTurnNow(turn);
    });
  }

  /**
   * Send a turn's command on the current connection, once per connection: a turn sent on a
   * connection that dropped is sent again on the next one (the daemon never runs it twice).
   */
  private sendTurnNow(turn: PendingTurn): boolean {
    if (!this.socket || !this.connected || turn.generation >= this.generation || !this.turns.has(turn.reqId)) return false;
    turn.generation = this.generation;
    try { this.write(turn.command); return true; }
    catch { return false; } // the reconnect sends it again
  }

  private settle(turn: PendingTurn, result: TurnResult | Error): void {
    if (!this.turns.delete(turn.reqId)) return;
    if (result instanceof Error) turn.reject(result); else turn.resolve(result);
  }

  // ── Incoming ──

  private onData(data: string): void {
    this.buffer += data;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { continue; }
      if (!event || typeof event.type !== "string") continue;
      try { this.dispatch(event); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }

  private dispatch(event: Record<string, any>): void {
    if (event.type === "app_welcome") this.turnCatchup = event.turnCatchup === true;
    for (const listener of this.listeners) listener(event);
    const reqId: string | undefined = event.reqId;
    const turnByReq = reqId ? this.turns.get(reqId) : undefined;

    if (turnByReq) {
      if (event.type === "error") {
        const message: string = event.message ?? "error";
        return this.settle(turnByReq, new ExocortexError(message.includes("sent before") ? "result_lost" : "daemon", message));
      }
      if (event.type === "conversation_created") {
        if (!this.conversations.has(event.convId)) this.conversations.set(event.convId, new Conversation(this, event.app, turnByReq.runTools));
        turnByReq.convId = event.convId;
        return;
      }
      if (event.type === "turn_result") return this.finishTurn(turnByReq, event);
      if (event.type === "app_conversation_attached") return; // a run sent again after a reconnect took its conversation back
    }
    if (reqId) {
      const request = this.requests.get(reqId);
      if (request) {
        if (event.type === "error") { this.requests.delete(reqId); clearTimeout(request.timer); request.reject(new ExocortexError("daemon", event.message)); return; }
        if (request.match(event)) { this.requests.delete(reqId); clearTimeout(request.timer); request.resolve(event); return; }
      }
    }

    const convId: string | undefined = event.convId;
    if (!convId) return;
    if (event.type === "app_tool_call") return this.onToolCall(event);
    if (event.type === "app_tool_cancel") { this.calls.get(event.callId)?.controller.abort(event.reason); this.calls.delete(event.callId); return; }
    if (event.type === "conversation_deleted") {
      this.endConversation(convId, event.reason ?? "deleted");
      return;
    }
    const exact = this.turnCatchup;
    const change = exact ? this.trackLive(convId, event) : null;
    for (const turn of [...this.turns.values()]) {
      if (turn.convId !== convId) continue;
      if (event.type === "turn_result") {
        // The owner's copy (after a reconnect our reqId is gone): ours when it names our turn.
        if (turn.turnId === event.turnId) this.finishTurn(turn, event);
        continue;
      }
      turn.onEvent?.(event);
      const stream = turn.stream;
      if (!stream) continue;
      if (exact) {
        if (change) this.followLive(turn, convId, change === "rebase" ? null : event);
      } else if (event.type === "text_chunk") stream.push({ type: "text", text: event.text });
      else if (event.type === "thinking_chunk") stream.push({ type: "thinking", text: event.text });
      else if (event.type === "tool_call") stream.push({ type: "tool_call", id: event.toolCallId, name: event.toolName, input: event.input });
      else if (event.type === "tool_result") stream.push({ type: "tool_result", id: event.toolCallId, name: event.toolName, output: event.output, isError: event.isError });
    }
    if (event.type === "turn_result" && this.live.get(convId)?.turnId === event.turnId) this.live.delete(convId);
  }

  /**
   * Keep a conversation's running turn: a catch-up replaces it, a newer stream event extends
   * it, the stream's message_complete completes it. "rebase" when streams must compare
   * against it, "event" when the event extended it, null when nothing changed (an event at or
   * below the last catch-up's streamSeq is already in it).
   */
  private trackLive(convId: string, event: Record<string, any>): "rebase" | "event" | null {
    if (event.type === "turn_catchup") {
      this.live.set(convId, { turnId: event.turnId, blocks: structuredClone(event.blocks ?? []), seq: event.streamSeq ?? 0, offset: event.streamOffset ?? 0 });
      return "rebase";
    }
    let live = this.live.get(convId);
    if (event.type === "streaming_started" && event.snapshotKind === "start") {
      // A new stream: its catch-up follows at once and says which turn it is.
      if (live) live.seq = event.streamSeq ?? 0;
      else this.live.set(convId, { turnId: null, blocks: [], seq: event.streamSeq ?? 0, offset: 0 });
      return null;
    }
    if (!BLOCK_EVENTS.has(event.type) && event.type !== "message_complete") return null;
    if (!live) this.live.set(convId, live = { turnId: null, blocks: [], seq: 0, offset: 0 });
    if (typeof event.streamSeq === "number") {
      if (event.streamSeq <= live.seq) return null;
      live.seq = event.streamSeq;
    }
    if (event.type === "message_complete") {
      live.blocks = [...live.blocks.slice(0, live.offset), ...structuredClone(event.blocks ?? [])];
      return "rebase";
    }
    applyStreamEvent(live.blocks, event);
    return "event";
  }

  /** Bring a turn's stream up to its conversation's live turn: `event` when only that event is new. */
  private followLive(turn: PendingTurn, convId: string, event: Record<string, any> | null): void {
    const live = this.live.get(convId);
    if (!live || (live.turnId !== null && live.turnId !== turn.turnId)) return;
    if (event && turn.synced && turn.shown) {
      applyStreamEvent(turn.shown, event);
      const block = turn.shown.at(-1);
      const shown = event.type === "text_chunk" || event.type === "thinking_chunk"
        ? { type: event.type === "text_chunk" ? "text" : "thinking", text: event.text } as StreamEvent
        : event.type === "block_start" ? null : block ? blockEvent(block) : null;
      if (shown && (shown.type !== "text" && shown.type !== "thinking" || shown.text)) turn.stream!.push(shown);
      return;
    }
    turn.synced = this.catchUp(turn, live.blocks, false);
  }

  /**
   * Show what `blocks` adds to what the turn's stream showed. While they agree but `blocks`
   * has not reached all of it (`final` false), nothing: the stream goes on once the turn
   * passes it. When they disagree (or the turn ended short of it), a reset, then the turn
   * again. True when the stream now shows exactly `blocks`.
   */
  private catchUp(turn: PendingTurn, blocks: Block[], final: boolean): boolean {
    const stream = turn.stream;
    const comparison = compare(turn.shown ?? [], blocks);
    if (comparison.kind === "behind" && !final) return false;
    let events: StreamEvent[];
    if (comparison.kind === "extends") events = comparison.events;
    else {
      stream?.push({ type: "reset" });
      events = (compare([], blocks) as Extract<Comparison, { kind: "extends" }>).events;
    }
    turn.shown = structuredClone(blocks);
    for (const event of events) stream?.push(event);
    return true;
  }

  /** A turn's result: its stream first shows what it lacks of the whole turn (turn_result.blocks). */
  private finishTurn(turn: PendingTurn, event: Record<string, any>): void {
    if (turn.stream && this.turnCatchup && Array.isArray(event.blocks) && this.turns.has(turn.reqId)) {
      this.catchUp(turn, event.blocks, true);
      turn.synced = false;
    }
    this.settle(turn, toResult(event));
  }

  /** @internal */
  followTurn(conversation: Conversation): TurnStream | null {
    const live = this.live.get(conversation.id);
    if (!this.turnCatchup || !live?.turnId || conversation.ended) return null;
    let stream!: TurnStream;
    const result = new Promise<TurnResult>((resolve, reject) => {
      // Never sent: the daemon's owner copy of its turn_result settles it.
      const turn: PendingTurn = {
        reqId: `f${++this.followCounter}`, convId: conversation.id, turnId: live.turnId!, generation: Number.MAX_SAFE_INTEGER,
        command: {}, resolve, reject, synced: true, shown: [],
      };
      Object.defineProperty(turn, "stream", { get: () => stream });
      this.turns.set(turn.reqId, turn);
      queueMicrotask(() => { if (this.turns.has(turn.reqId)) this.followLive(turn, conversation.id, null); });
    });
    stream = new TurnStream(result);
    return stream;
  }

  private onToolCall(event: Record<string, any>): void {
    const { convId, callId, name } = event;
    const known = this.calls.get(callId);
    if (known) {
      // Re-sent after a reconnect: answer again if it already finished, else keep running it.
      if (known.result) this.writeQuietly({ type: "app_tool_result", convId, callId, ...known.result });
      return;
    }
    const conversation = this.conversations.get(convId);
    const tool = conversation?.handlers.get(name);
    const controller = new AbortController();
    const entry: { controller: AbortController; result?: { output: string; isError: boolean }; convId: string } = { controller, convId };
    this.calls.set(callId, entry);
    const finish = (result: { output: string; isError: boolean }) => {
      if (controller.signal.aborted || this.calls.get(callId) !== entry) return;
      entry.result = result;
      this.writeQuietly({ type: "app_tool_result", convId, callId, ...result });
      // Keep the answer a while in case the daemon re-sends the call after a reconnect.
      setTimeout(() => { if (this.calls.get(callId) === entry) this.calls.delete(callId); }, 600_000).unref?.();
    };
    if (!tool) return finish({ output: `${this.app} has no handler for tool ${name}`, isError: true });
    Promise.resolve()
      .then(() => tool.handler(event.input ?? {}, { convId, callId, signal: controller.signal }))
      .then(value => finish(normalizeOutput(value)), error => finish({ output: error instanceof Error ? error.message : String(error), isError: true }));
  }

  private endConversation(convId: string, reason: string, code: ErrorCode = "ended", message?: string): void {
    this.live.delete(convId);
    const conversation = this.conversations.get(convId);
    if (conversation) { conversation.ended = reason; this.conversations.delete(convId); }
    for (const [callId, call] of this.calls) if (call.convId === convId) { call.controller.abort("ended"); this.calls.delete(callId); }
    for (const turn of [...this.turns.values()]) {
      // app_run answers turn_result before deleting its ephemeral conversation; anything else still pending is gone.
      if (turn.convId === convId) this.settle(turn, new ExocortexError(code, message ?? `Conversation ${convId} has ended (${reason})`));
    }
  }

  // ── Connection loss ──

  private failRequests(error: Error): void {
    for (const [reqId, request] of this.requests) { clearTimeout(request.timer); this.requests.delete(reqId); request.reject(error); }
  }

  private onClose(generation: number): void {
    this.socket = null;
    if (this.closed || generation !== this.generation) return;
    this.connected = false;
    // Requests waiting on an answer are sent again once reconnected (request()); turns and
    // running tool calls carry on: the reconnect sends the turns again, and the daemon re-sends
    // the calls it still waits on, which get the answers kept for them.
    const lost = new ExocortexError("disconnected", "Lost the connection to the Exocortex daemon");
    this.failRequests(lost);
    if (this.closing) return;
    if (!this.options.reconnect) { this.closed = true; this.failAll(lost); return; }
    this.reconnecting ??= this.reconnect().finally(() => { this.reconnecting = null; });
  }

  private async reconnect(): Promise<void> {
    for (;;) {
      if (!await this.redial()) return;
      const generation = this.generation;
      await this.reclaim(generation);
      // Dropped again meanwhile: that close found this loop running, so it goes round again.
      if (this.closed || this.closing || (this.connected && this.generation === generation)) return;
    }
  }

  /** Handshake again with backoff; false when it gave up (and failed everything). */
  private async redial(): Promise<boolean> {
    const deadline = Date.now() + this.options.reconnectTimeoutMs;
    let delay = 100;
    while (!this.closed && !this.closing) {
      try {
        await this.handshake();
        return true;
      } catch (error) {
        if (error instanceof ExocortexError && error.code === "incompatible") { this.closed = true; this.failAll(error); return false; }
        if (Date.now() + delay > deadline) {
          this.closed = true;
          this.failAll(new ExocortexError("disconnected", `Could not reconnect to the Exocortex daemon within ${this.options.reconnectTimeoutMs} ms`));
          return false;
        }
        await sleep(delay * (0.75 + Math.random() / 2));
        delay = Math.min(delay * 2, 2_000);
      }
    }
    return false;
  }

  /** After a reconnect: take the conversations back and send again what was in flight. */
  private async reclaim(generation: number): Promise<void> {
    // A daemon with sessions never runs a prompt twice: what was in flight is sent again.
    const resend = Boolean(this.welcome.session);
    const attached = new Map<string, Record<string, any>>();
    for (const conversation of [...this.conversations.values()]) {
      if (!this.conversations.has(conversation.id)) continue;
      try { attached.set(conversation.id, await this.attachExisting(conversation, false)); }
      catch (error) {
        if (error instanceof ExocortexError && (error.code === "disconnected" || error.code === "closed")) return;
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("not found")) this.lost(conversation.id, resend);
        else this.endConversation(conversation.id, message);
      }
    }
    const turns = [...this.turns.values()].filter(turn => turn.generation < generation);
    if (resend) {
      // The daemon answers a prompt it already has from its turn, and carries on with a run
      // whose conversation it already has.
      for (const turn of turns) this.sendTurnNow(turn);
      return;
    }
    // An older daemon: what never went out goes now; what did is settled from the attach answers.
    for (const turn of turns) {
      if (turn.generation === -1) { this.sendTurnNow(turn); continue; }
      const event = attached.get(turn.convId);
      if (!event) { this.settle(turn, new ExocortexError("lost", "The connection dropped before the daemon took this run")); continue; }
      if (event.conversation?.streaming) continue; // its result comes as the owner's copy
      const last = event.lastTurnResult;
      if (last && last.turnId === turn.turnId) this.settle(turn, toResult(last));
      else this.settle(turn, new ExocortexError("result_lost", `The turn on ${turn.convId} ended while the client was disconnected, and the daemon did not report its result`));
    }
  }

  /**
   * The daemon no longer has a conversation of ours: a crash, or we were away longer than the
   * session's reconnect grace. A one-shot run starts over on a new conversation (`rerunLost`).
   */
  private lost(convId: string, rerun: boolean): void {
    if (this.options.rerunLost && rerun) {
      for (const turn of this.turns.values()) {
        if (turn.convId !== convId || turn.command.type !== "app_run") continue;
        turn.convId = newConvId();
        turn.command = { ...turn.command, convId: turn.convId };
        turn.generation = -1; // not sent on any connection: sent again
      }
    }
    this.endConversation(convId, "lost", "lost", `Conversation ${convId} is gone from the Exocortex daemon (it crashed, or the client was away longer than its reconnect grace)`);
  }

  private failAll(error: Error): void {
    this.failRequests(error);
    for (const turn of [...this.turns.values()]) this.settle(turn, error);
    for (const call of this.calls.values()) call.controller.abort("closed");
    this.calls.clear();
    // Wakes requests waiting for a reconnect: they see the client closed.
    for (const wake of this.connectedWaiters.splice(0)) wake(false);
  }

  // ── Plumbing ──

  private nextReqId(): string { return `c${++this.reqCounter}`; }

  /** The prompt's time, unique per client: it is the turn's identity (turn_result.turnId). */
  private nextStartedAt(): number {
    this.lastStartedAt = Math.max(Date.now(), this.lastStartedAt + 1);
    return this.lastStartedAt;
  }

  private write(command: Record<string, any>): void {
    if (this.closed) throw new ExocortexError("closed", "The client was closed");
    if (!this.socket) throw new ExocortexError("disconnected", "Not connected to the Exocortex daemon (reconnecting)");
    this.socket.write(JSON.stringify(command) + "\n");
  }

  private writeQuietly(command: Record<string, any>): void {
    try { this.write(command); } catch { /* the daemon re-sends the call after a reconnect */ }
  }
}

function normalizeOutput(value: unknown): { output: string; isError: boolean } {
  if (typeof value === "string") return { output: value, isError: false };
  if (value && typeof value === "object" && typeof (value as any).output === "string") {
    return { output: (value as any).output, isError: Boolean((value as any).isError) };
  }
  if (value === undefined || value === null) return { output: "", isError: false };
  return { output: JSON.stringify(value), isError: false };
}

/** Connect to the user's daemon as `app`. */
export async function connect(options: ConnectOptions): Promise<Client> {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(options.app)) throw new TypeError(`Invalid app name ${JSON.stringify(options.app)}: use lowercase letters, digits and dashes`);
  const client = new Client(options);
  try { await client.open(); }
  catch (error) { await client.close(); throw error; }
  return client;
}

/** One-shot from anywhere: connect, run (ephemeral by default), close. Rides out a daemon restart. */
export async function run(prompt: string, options: RunOptions & ConnectOptions): Promise<TurnResult> {
  const { app, version, socket, reconnect, reconnectTimeoutMs, reconnectGraceMs, session, rerunLost, welcomeTimeoutMs, requestTimeoutMs, ...runOptions } = options;
  const client = await connect({ app, version, socket, reconnect, reconnectTimeoutMs, reconnectGraceMs, session, rerunLost, welcomeTimeoutMs, requestTimeoutMs });
  try { return await client.run(prompt, runOptions); }
  finally { await client.close(); }
}
