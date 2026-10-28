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
}

export interface TurnResult {
  convId: string;
  text: string;
  stopReason: StopReason;
  error?: string;
  usage?: { outputTokens: number; durationMs: number };
  /** The daemon's turn identity, when it sends one. */
  turnId?: string;
  /** The raw turn_result event (or a reconstruction after a reconnect). */
  raw: Record<string, any>;
}

export interface Welcome { appApiVersion: number; app: string; instance: string; pid: number }

/** What a turn's stream yields. Everything else is available raw through `onEvent`. */
export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name: string; output: string; isError: boolean };

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
  /** A client-chosen conversation id. */
  convId?: string;
}

export interface SendOptions {
  images?: unknown[];
  /** Every raw daemon event of this conversation during the turn. */
  onEvent?: (event: Record<string, any>) => void;
}

export interface RunOptions extends ConversationOptions, SendOptions {
  /** Default "ephemeral". */
  lifetime?: Lifetime;
  /** Keep an ephemeral conversation after the run (it ends with the connection). */
  keep?: boolean;
}

export interface ConnectOptions {
  /** The app's name, `^[a-z0-9][a-z0-9-]{0,39}$`. */
  app: string;
  version?: string;
  /** The daemon's socket; default: $EXOCORTEX_SOCKET, then `exocortexd socket`. */
  socket?: string;
  /** Reconnect (and re-attach saved/temporary conversations) when the connection drops. Default true. */
  reconnect?: boolean;
  /** Give up reconnecting after this long. Default 60 s. */
  reconnectTimeoutMs?: number;
  /** How long to wait for app_welcome. Default 5 s. */
  welcomeTimeoutMs?: number;
  /** Timeout for requests other than turns. Default 30 s. */
  requestTimeoutMs?: number;
}

export type ErrorCode =
  | "not_installed" | "not_running" | "too_old" | "incompatible" | "daemon"
  | "disconnected" | "closed" | "ended" | "timeout" | "result_lost";

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
  convId: string | null;
  /** The daemon's turn identity: the prompt's startedAt, as a string. */
  turnId: string;
  /** The connection this turn's request went out on. */
  generation: number;
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  onEvent?: (event: Record<string, any>) => void;
  stream?: TurnStream;
  /** app_run: becomes the conversation once conversation_created arrives. */
  run?: { options: RunOptions };
}

function toResult(event: Record<string, any>): TurnResult {
  return {
    convId: event.convId, text: event.text ?? "", stopReason: event.stopReason,
    ...(event.error ? { error: event.error } : {}),
    ...(event.usage ? { usage: event.usage } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
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

function createFields(options: ConversationOptions): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    lifetime: options.lifetime, idleTtlMs: options.idleTtlMs, title: options.title,
    system: systemSpec(options.system), tools: toolsWire(options.tools),
    provider: options.provider, model: options.model, effort: options.effort,
    cwd: options.cwd, convId: options.convId,
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
  /** Set once it is gone (deleted, expired, its connection closed). */
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

/** A connection to the daemon, declared as one app. */
export class Client {
  readonly app: string;
  welcome!: Welcome;
  private options: Required<Omit<ConnectOptions, "version" | "socket">> & Pick<ConnectOptions, "version" | "socket">;
  private socketPath = "";
  private socket: Socket | null = null;
  private generation = 0;
  private reqCounter = 0;
  private lastStartedAt = 0;
  private buffer = "";
  private closed = false;
  private reconnecting: Promise<void> | null = null;
  private requests = new Map<string, PendingRequest>();
  private turns = new Map<string, PendingTurn>();
  private conversations = new Map<string, Conversation>();
  /** In-flight and recently finished app tool calls by callId (a re-attach resends unanswered ones). */
  private calls = new Map<string, { controller: AbortController; result?: { output: string; isError: boolean }; convId: string }>();
  private listeners = new Set<(event: Record<string, any>) => void>();

  /** @internal Use `connect()`. */
  constructor(options: ConnectOptions) {
    this.app = options.app;
    this.options = {
      reconnect: true, reconnectTimeoutMs: 60_000, welcomeTimeoutMs: 5_000, requestTimeoutMs: 30_000,
      ...options,
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
    const generation = ++this.generation;
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => { if (this.socket === socket) this.onData(data); });
    socket.on("error", () => {});
    let ready = false;
    socket.on("close", () => {
      if (this.socket !== socket) return;
      if (ready) return this.onClose(generation);
      this.socket = null;
      for (const [reqId, request] of this.requests) {
        clearTimeout(request.timer);
        this.requests.delete(reqId);
        request.reject(new ExocortexError("disconnected", "The daemon closed the connection before app_welcome"));
      }
    });
    const welcome = await this.request(
      { type: "client_capabilities", capabilities: [], app: { name: this.app, ...(this.options.version ? { version: this.options.version } : {}) } },
      event => event.type === "app_welcome",
      this.options.welcomeTimeoutMs,
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
    this.welcome = { appApiVersion: welcome.appApiVersion, app: welcome.app, instance: welcome.instance, pid: welcome.pid };
    ready = true;
    if (this.socket !== socket) throw new ExocortexError("disconnected", "The daemon closed the connection");
  }

  /** Listen to every daemon event this connection receives. Returns an unsubscribe function. */
  onEvent(listener: (event: Record<string, any>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send a raw command and wait for the answer `match` accepts (or an `error` with its reqId). */
  request(command: Record<string, any>, match: (event: Record<string, any>) => boolean, timeoutMs = this.options.requestTimeoutMs): Promise<Record<string, any>> {
    const reqId = command.reqId ?? this.nextReqId();
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { match, resolve, reject };
      if (timeoutMs > 0) pending.timer = setTimeout(() => {
        this.requests.delete(reqId);
        reject(new ExocortexError("timeout", `No answer to ${command.type} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.requests.set(reqId, pending);
      try { this.write({ ...command, reqId }); }
      catch (error) { clearTimeout(pending.timer); this.requests.delete(reqId); reject(error); }
    });
  }

  /** Create a conversation. */
  async conversation(options: ConversationOptions = {}): Promise<Conversation> {
    const event = await this.request({ type: "new_conversation", ...createFields(options) }, e => e.type === "conversation_created");
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
  async attachExisting(conversation: Conversation): Promise<Record<string, any>> {
    const event = await this.request(
      { type: "attach_app_conversation", convId: conversation.id, ...(conversation.tools ? { tools: { app: toolDefs(conversation.tools) } } : {}) },
      e => e.type === "app_conversation_attached",
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
    await this.request({ type: "delete_conversation", convId }, e => e.type === "conversation_deleted" && e.convId === convId);
    this.endConversation(convId, "deleted");
  }

  /** Close the connection. Ephemeral conversations end with it; saved and temporary ones stay. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new ExocortexError("closed", "The client was closed"));
    this.socket?.end();
    this.socket = null;
  }

  // ── Turns ──

  /** @internal */
  sendTurn(conversation: Conversation, prompt: string, options: SendOptions, stream: (() => TurnStream) | null): Promise<TurnResult> {
    if (conversation.ended) return Promise.reject(new ExocortexError("ended", `Conversation ${conversation.id} has ended (${conversation.ended})`));
    const reqId = this.nextReqId();
    const startedAt = this.nextStartedAt();
    return new Promise((resolve, reject) => {
      const turn: PendingTurn = { reqId, convId: conversation.id, turnId: String(startedAt), generation: this.generation, resolve, reject, onEvent: options.onEvent };
      if (stream) Object.defineProperty(turn, "stream", { get: stream });
      this.turns.set(reqId, turn);
      try {
        this.write({ type: "send_message", reqId, convId: conversation.id, text: prompt, startedAt, awaitResult: true, ...(options.images ? { images: options.images } : {}) });
      } catch (error) { this.turns.delete(reqId); reject(error); }
    });
  }

  private startRun(prompt: string, options: RunOptions, stream: (() => TurnStream) | null): Promise<TurnResult> {
    const reqId = this.nextReqId();
    const startedAt = this.nextStartedAt();
    return new Promise((resolve, reject) => {
      const turn: PendingTurn = { reqId, convId: null, turnId: String(startedAt), generation: this.generation, resolve, reject, onEvent: options.onEvent, run: { options } };
      if (stream) Object.defineProperty(turn, "stream", { get: stream });
      this.turns.set(reqId, turn);
      try {
        this.write({ type: "app_run", reqId, ...createFields(options), prompt, startedAt, ...(options.images ? { images: options.images } : {}), ...(options.keep ? { keep: true } : {}) });
      } catch (error) { this.turns.delete(reqId); reject(error); }
    });
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
    for (const listener of this.listeners) listener(event);
    const reqId: string | undefined = event.reqId;
    const turnByReq = reqId ? this.turns.get(reqId) : undefined;

    if (turnByReq && turnByReq.generation === this.generation) {
      if (event.type === "error") return this.settle(turnByReq, new ExocortexError("daemon", event.message));
      if (event.type === "conversation_created" && turnByReq.run) {
        const conversation = new Conversation(this, event.app, turnByReq.run.options.tools?.app);
        this.conversations.set(conversation.id, conversation);
        turnByReq.convId = conversation.id;
        return;
      }
      if (event.type === "turn_result") return this.settle(turnByReq, toResult(event));
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
    for (const turn of this.turns.values()) {
      if (turn.convId !== convId) continue;
      if (event.type === "turn_result") {
        // The owner's copy (after a reconnect our reqId is gone): ours when it names our turn.
        if (turn.turnId === event.turnId) this.settle(turn, toResult(event));
        continue;
      }
      turn.onEvent?.(event);
      const stream = turn.stream;
      if (stream) {
        if (event.type === "text_chunk") stream.push({ type: "text", text: event.text });
        else if (event.type === "thinking_chunk") stream.push({ type: "thinking", text: event.text });
        else if (event.type === "tool_call") stream.push({ type: "tool_call", id: event.toolCallId, name: event.toolName, input: event.input });
        else if (event.type === "tool_result") stream.push({ type: "tool_result", id: event.toolCallId, name: event.toolName, output: event.output, isError: event.isError });
      }
    }
  }


  private onToolCall(event: Record<string, any>): void {
    const { convId, callId, name } = event;
    const known = this.calls.get(callId);
    if (known) {
      // Re-sent after a re-attach: answer again if it already finished, else keep running it.
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
      setTimeout(() => { if (this.calls.get(callId) === entry) this.calls.delete(callId); }, 120_000).unref?.();
    };
    if (!tool) return finish({ output: `${this.app} has no handler for tool ${name}`, isError: true });
    Promise.resolve()
      .then(() => tool.handler(event.input ?? {}, { convId, callId, signal: controller.signal }))
      .then(value => finish(normalizeOutput(value)), error => finish({ output: error instanceof Error ? error.message : String(error), isError: true }));
  }

  private endConversation(convId: string, reason: string): void {
    const conversation = this.conversations.get(convId);
    if (conversation) { conversation.ended = reason; this.conversations.delete(convId); }
    for (const [callId, call] of this.calls) if (call.convId === convId) { call.controller.abort("ended"); this.calls.delete(callId); }
    for (const turn of this.turns.values()) {
      // app_run answers turn_result before deleting its ephemeral conversation; anything else still pending is gone.
      if (turn.convId === convId) this.settle(turn, new ExocortexError("ended", `Conversation ${convId} has ended (${reason})`));
    }
  }

  // ── Connection loss ──

  private onClose(generation: number): void {
    this.socket = null;
    if (this.closed || generation !== this.generation) return;
    const lost = new ExocortexError("disconnected", "Lost the connection to the Exocortex daemon");
    for (const [reqId, request] of this.requests) { clearTimeout(request.timer); request.reject(lost); this.requests.delete(reqId); }
    for (const [callId, call] of this.calls) if (!call.result) { call.controller.abort("disconnected"); this.calls.delete(callId); }
    // Ephemeral conversations end with the connection; their turns with them.
    for (const conversation of [...this.conversations.values()]) {
      if (conversation.info.lifetime === "ephemeral") this.endConversation(conversation.id, "owner_disconnected");
    }
    for (const turn of [...this.turns.values()]) if (!turn.convId) this.settle(turn, lost);
    if (!this.options.reconnect) { this.closed = true; this.failAll(lost); return; }
    this.reconnecting ??= this.reconnect().finally(() => { this.reconnecting = null; });
  }

  private async reconnect(): Promise<void> {
    const deadline = Date.now() + this.options.reconnectTimeoutMs;
    let delay = 100;
    while (!this.closed) {
      try {
        await this.handshake();
        break;
      } catch (error) {
        if (error instanceof ExocortexError && (error.code === "incompatible")) { this.closed = true; this.failAll(error); return; }
        if (Date.now() + delay > deadline) {
          this.closed = true;
          this.failAll(new ExocortexError("disconnected", `Could not reconnect to the Exocortex daemon within ${this.options.reconnectTimeoutMs} ms`));
          return;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 2_000);
      }
    }
    if (this.closed) return;
    for (const conversation of [...this.conversations.values()]) {
      let event: Record<string, any>;
      try { event = await this.attachExisting(conversation); }
      catch (error) {
        if (error instanceof ExocortexError && error.code === "disconnected") return; // the next onClose retries
        this.endConversation(conversation.id, error instanceof Error ? error.message : String(error));
        continue;
      }
      if (event.conversation?.streaming) continue;
      // The turn ended while we were away.
      for (const turn of [...this.turns.values()]) {
        if (turn.convId !== conversation.id) continue;
        const last = event.lastTurnResult;
        if (last && last.turnId === turn.turnId) this.settle(turn, toResult(last));
        else this.settle(turn, new ExocortexError("result_lost", `The turn on ${conversation.id} ended while the client was disconnected, and the daemon did not report its result`));
      }
    }
  }

  private failAll(error: Error): void {
    for (const [reqId, request] of this.requests) { clearTimeout(request.timer); request.reject(error); this.requests.delete(reqId); }
    for (const turn of [...this.turns.values()]) this.settle(turn, error);
    for (const call of this.calls.values()) call.controller.abort("closed");
    this.calls.clear();
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
    try { this.write(command); } catch { /* a re-attach re-sends the call */ }
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
  await client.open();
  return client;
}

/** One-shot from anywhere: connect, run, close. */
export async function run(prompt: string, options: RunOptions & ConnectOptions): Promise<TurnResult> {
  const { app, version, socket, welcomeTimeoutMs, requestTimeoutMs, ...runOptions } = options;
  const client = await connect({ app, version, socket, welcomeTimeoutMs, requestTimeoutMs, reconnect: false });
  try { return await client.run(prompt, runOptions); }
  finally { client.close(); }
}
