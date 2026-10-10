/**
 * Claude Code processes that outlive a turn.
 *
 * Claude Code runs background tasks (`run_in_background` shells, background
 * agents) inside its own process and starts a turn of its own when one
 * finishes. So a turn that leaves background tasks running keeps its process:
 * the conversation's next turns send their prompts into it, its tasks show as
 * the conversation's tasks, and when Claude Code starts a turn by itself the
 * daemon queues a notification message whose turn shows that work. Without
 * background tasks a process still stays briefly after its turn ends or is
 * interrupted, so queued and steering messages continue in it.
 *
 * Messages queued for the next turn while a turn runs are sent into it as
 * they are queued, and Claude Code takes them in at its next tool boundary,
 * as typed input in Claude Code itself (or runs them right after the turn's
 * result, which then goes on to answer them too). One edited or unqueued
 * before Claude Code took it is withdrawn.
 *
 * A process run by a relay (relay.ts) also outlives the daemon. A restart
 * detaches it instead of interrupting its turn, and the next daemon adopts it:
 * the relay replays what the old daemon had not saved, and replaying the
 * conversation shows the rest of the turn.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAbortError, createDetachedTurnError } from "../../abort";
import type { ToolExecutor } from "../../agent";
import { restoreRunningBackgroundTask, setBackgroundTaskActive } from "../../conversation-activity";
import { getDaemonShutdownMode } from "../../daemon-lifecycle";
import { log } from "../../log";
import type { ApiMessage } from "../../messages";
import type { QueuedInput, QueuedInputSource, StreamResult } from "../types";
import type { HostToolBinding } from "./host-tools";
import { buildLiveSessionContent, buildQueuedInputContent, trailingUserMessages } from "./prompt";
import type { ClaudeRelay } from "./relay-client";
import { endsInterruptedTurn, startsClaudeTurn, type RelayHistoryMark, type RelayResumePoint } from "./relay-protocol";
import { agentTitlesInHistory, commitInterruptedRound, finalizeClaudeStream, pushClaudeMessage, takeQueuedInput, type ClaudeStreamState } from "./stream";
import type { AnthropicAssistantProviderData } from "./types";

type SdkRecord = Record<string, unknown>;
type SdkContent = SDKUserMessage["message"]["content"];
type ResumeData = AnthropicAssistantProviderData["anthropic"];

/** Query controls the SDK has without declaring them. */
interface QueuedInputControls {
  /** Withdraw a sent message Claude Code has not taken yet; false once it has. */
  cancelAsyncMessage?(uuid: string): Promise<boolean>;
  /** With cancelQueued, also withdraws every sent message it has not taken yet. */
  interrupt(options?: { cancelQueued?: boolean }): Promise<unknown>;
}

export type ClaudeRuntime = Pick<Query, "stopTask" | "close"> & QueuedInputControls & AsyncIterable<unknown>;
export type StartClaudeRuntime = (input: AsyncIterable<SDKUserMessage>, binding: () => Promise<HostToolBinding>) => ClaudeRuntime;

export interface ClaudeCodeSessionHooks {
  /** A conversation's task list changed. */
  tasksChanged(convId: string): void;
  /** Queue a turn to show work Claude Code started by itself; false when the conversation cannot take one. */
  wake(convId: string, text: string, wakeId: string): boolean;
  /** Withdraw a queued wake whose work another turn already showed. */
  cancelWake(convId: string, wakeId: string): void;
}

export interface ClaudeCodeSessionOptions {
  /** The relay running the process; one that has said hello was started by an earlier daemon. */
  relay?: ClaudeRelay | null;
  /** Where the process forked its session. */
  resume?: ResumeData | null;
  /** For a new session (no resume point), the history it was started with. */
  history?: RelayHistoryMark | null;
}

/** What a turn sends into a running process. */
export type LiveTurnInput =
  | { kind: "prompt"; content: SdkContent; messages: ApiMessage[] }
  /** Show the turn Claude Code is running by itself. */
  | { kind: "wake" }
  /** Only messages the process already has. */
  | { kind: "none" };

/** Claude Code keeps the watchdog quiet through long tool calls while it runs. */
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** How long a process without background tasks stays for a late notification turn or a quick follow-up. */
const IDLE_CLOSE_MS = 15_000;
/** How long an interrupted turn may take to end before its process is given up. */
const INTERRUPT_GRACE_MS = 30_000;
/** How long a host tool call from a turn Claude Code started waits for that turn to be shown. */
const BINDING_WAIT_MS = 60_000;
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "stopped", "killed"]);
/**
 * How Claude Code reports a background command it stopped by itself (at its
 * time limit, or short of memory), which it answers with a turn. A task
 * stopped on request is reported by its description and gets no turn.
 */
const SELF_STOPPED_SUMMARY = /^Background command ".*" was stopped/s;
/** Claude Code's background task types, named for what runs them. */
const BACKGROUND_TASK_TOOLS: Record<string, string> = {
  local_bash: "Bash",
  local_agent: "Agent",
  remote_agent: "Agent",
  in_process_teammate: "Agent",
  local_workflow: "Workflow",
  monitor_mcp: "Monitor",
  monitor_ws: "Monitor",
  mcp_task: "MCP",
  dream: "Dream",
};
/** Tasks run by an agent rather than a command, reported like Exocortex subagents. */
const AGENT_TASK_TOOLS = new Set(["Agent", "Workflow"]);
/** How much of an agent's final report a completion notification carries, as for Exocortex subagents. */
const AGENT_RESULT_CHARS = 6000;
const WAKE_AUTOMATION_KIND = "background_task_completion";
const WAKE_KEY_PREFIX = "wake:";

let hooks: ClaudeCodeSessionHooks | null = null;
const sessions = new Map<string, ClaudeCodeSession>();

export function configureClaudeCodeSessions(next: ClaudeCodeSessionHooks | null): void {
  hooks = next;
}

export function getClaudeCodeSession(convId: string): ClaudeCodeSession | undefined {
  return sessions.get(convId);
}

/** Start a process for a conversation (or adopt one), replacing any it still had. */
export function openClaudeCodeSession(
  convId: string | undefined,
  key: string,
  start: StartClaudeRuntime,
  options: ClaudeCodeSessionOptions = {},
): ClaudeCodeSession {
  if (convId) sessions.get(convId)?.close("replaced by a new Claude Code process");
  const session = new ClaudeCodeSession(convId, key, start, options);
  if (convId) sessions.set(convId, session);
  return session;
}

export function closeAllClaudeCodeSessions(reason: string): void {
  for (const session of [...sessions.values()]) session.close(reason);
}

/** Leave every process running for the next daemon to adopt; ones without a relay cannot outlive this one and close. */
export function detachAllClaudeCodeSessions(reason: string): void {
  for (const session of [...sessions.values()]) session.detach(reason);
}

/** Close every process and wait (briefly) until their relays have stopped them. */
export async function stopAllClaudeCodeSessions(reason: string): Promise<void> {
  await Promise.all([...sessions.values()].map(session => session.stop(reason)));
}

/** Settings a running process was started with; a turn needing others starts a new one. */
export function claudeSessionKey(model: string, effort: string | undefined, cwd: string): string {
  return JSON.stringify([model, effort ?? null, cwd]);
}

/** Prompt stream that stays open, so later turns can send into the same process. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private notify: (() => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    this.items.push(message);
    this.notify?.();
  }

  close(): void {
    this.closed = true;
    this.notify?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => { this.notify = resolve; });
      this.notify = null;
    }
  }
}

interface LiveTask {
  title: string;
  toolName: string;
  /** Set once the task is mirrored into the conversation's tasks. */
  startedAt?: number;
  /** The subagent task that launched it; its notifications are that agent's. */
  parentTaskId?: string;
}

interface TaskNote {
  id: string;
  /** The task run it reports; the result of the turn that answers it names the same run. */
  runId?: string;
  status: string;
  title: string;
  toolName: string;
  summary?: string;
  outputFile?: string;
  /** Shown as the reason for a turn Claude Code started by itself. */
  shown?: boolean;
  /** Taken into a running turn, so no turn of its own answers it. */
  takenIn?: boolean;
}

/**
 * A turn's queued next-turn messages, sent into it as they are queued.
 * Claude Code reports taking one in (or dropping it) with a command_lifecycle
 * frame for the uuid it was sent with.
 */
class TurnInput {
  /** Sent and neither taken in nor dropped yet, by uuid. */
  private readonly sent = new Map<string, QueuedInput>();
  private readonly withdrawing = new Set<string>();
  private readonly unsubscribe: () => void;
  private syncScheduled = false;
  private ended = false;

  constructor(
    private readonly source: QueuedInputSource,
    private readonly send: (uuid: string, input: QueuedInput) => void,
    private readonly withdraw: (uuid: string) => Promise<boolean>,
    private readonly dropped: () => void,
  ) {
    this.unsubscribe = source.subscribe(() => this.scheduleSync());
    this.sync();
  }

  /** Claude Code has messages of this turn it has not taken in yet. */
  get waiting(): boolean {
    return this.sent.size > 0;
  }

  get untaken(): string[] {
    return [...this.sent.keys()];
  }

  /** Claude Code took in the message sent as `uuid`; null if it is not one of this turn's. */
  take(uuid: string): QueuedInput | null {
    const input = this.sent.get(uuid) ?? null;
    this.forget(uuid);
    return input;
  }

  /** Claude Code dropped the message sent as `uuid`. */
  drop(uuid: string): void {
    if (this.forget(uuid)) this.dropped();
  }

  end(): void {
    this.ended = true;
    this.unsubscribe();
  }

  private forget(uuid: string): boolean {
    this.withdrawing.delete(uuid);
    return this.sent.delete(uuid);
  }

  private scheduleSync(): void {
    if (this.syncScheduled || this.ended) return;
    this.syncScheduled = true;
    queueMicrotask(() => {
      this.syncScheduled = false;
      if (!this.ended) this.sync();
    });
  }

  /** Send what is newly queued; withdraw what was edited or unqueued since it was sent. */
  private sync(): void {
    const pending = this.source.pending();
    for (const [uuid, sent] of this.sent) {
      if (this.withdrawing.has(uuid) || pending.some(input => sameInput(input, sent))) continue;
      this.withdrawing.add(uuid);
      void this.withdraw(uuid).then((withdrawn) => {
        if (!this.withdrawing.delete(uuid) || !withdrawn) return;
        this.drop(uuid);
        this.scheduleSync();
      });
    }
    for (const input of pending) {
      // Sent already, or an earlier version is still being withdrawn: Claude Code may take that in instead.
      if ([...this.sent.values()].some(sent => sent.id === input.id)) continue;
      const uuid = randomUUID();
      this.sent.set(uuid, input);
      this.send(uuid, input);
    }
  }
}

function sameInput(a: QueuedInput, b: QueuedInput): boolean {
  return a.id === b.id && a.text === b.text && JSON.stringify(a.images ?? []) === JSON.stringify(b.images ?? []);
}

interface Turn {
  state: ClaudeStreamState;
  binding: HostToolBinding | null;
  /** The turn's queued next-turn messages, sent in once Claude Code has started the turn. */
  source: QueuedInputSource | null;
  input: TurnInput | null;
  /** Frames that arrive while taken input is committed, in order. */
  backlog: SdkRecord[] | null;
  /** The result that ended the turn, once it has. */
  through?: string;
  finish(result: StreamResult | null, error?: unknown): void;
}

function asRecord(value: unknown): SdkRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as SdkRecord : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function wakeIdOf(message: ApiMessage): string | null {
  const automation = message.metadata?.automation;
  return automation?.kind === WAKE_AUTOMATION_KIND && automation.sourceId ? automation.sourceId : null;
}

/** Identity of an Exocortex message sent into a process, stable across daemons. */
export function deliveryKey(message: ApiMessage): string {
  const wakeId = wakeIdOf(message);
  if (wakeId) return `${WAKE_KEY_PREFIX}${wakeId}`;
  return createHash("sha256").update(JSON.stringify([message.metadata?.startedAt ?? null, message.content])).digest("hex").slice(0, 32);
}

/** Identity of the history a new process was started with. */
export function historyMark(messages: ApiMessage[]): RelayHistoryMark {
  const hash = createHash("sha256");
  for (const message of messages) hash.update(`${message.role}:${deliveryKey(message)}\n`);
  return { count: messages.length, key: hash.digest("hex").slice(0, 32) };
}

function capText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * The notification message shown before a turn Claude Code started by itself,
 * in the format of Exocortex's own notifications: agents like a finished
 * subagent, other tasks like a finished background command.
 */
export function buildWakeText(notes: readonly TaskNote[]): string {
  if (notes.length === 0) return "[notification] Claude Code resumed work on its own.";
  return notes.map((note) => {
    const status = note.status === "completed" || note.status === "failed" ? note.status : "stopped";
    // Claude Code often reports a task's description as its summary.
    const summary = note.summary && note.summary !== note.title ? note.summary : undefined;
    if (AGENT_TASK_TOOLS.has(note.toolName)) return [
      `[notification] ${note.toolName} ${status}: ${note.id}`,
      `Task: ${note.title}`,
      ...(summary ? ["", `${status === "failed" ? "Error" : "Result"}:`, capText(summary, AGENT_RESULT_CHARS)] : []),
      ...(note.outputFile ? ["", `Output: ${note.outputFile}`] : []),
    ].join("\n");
    return [
      `[notification] Background task ${status}: ${note.id}`,
      `${note.toolName === "Bash" ? "Command" : "Task"}: ${note.title}`,
      ...(summary ? [`Status: ${summary}`] : []),
      ...(note.outputFile ? [`Output: ${note.outputFile}`] : []),
    ].join("\n");
  }).join("\n\n");
}

export class ClaudeCodeSession {
  readonly key: string;
  sessionId: string | null = null;
  private readonly input = new PromptQueue();
  private readonly runtime: ClaudeRuntime;
  private readonly relay: ClaudeRelay | null;
  /** Started by an earlier daemon. */
  private readonly adopted: boolean;
  /** History ending here matches the process: where it forked, then its latest committed round or turn. */
  private resumePoint: RelayResumePoint | null;
  /** Without a resume point, history starting like this matches it. */
  private readonly history: RelayHistoryMark | null;
  private turn: Turn | null = null;
  /** Messages of a turn Claude Code started while no Exocortex turn was showing it. */
  private buffer: SdkRecord[] = [];
  /** Wake queued for the buffered turn. */
  private wakeId: string | null = null;
  /** An adopted process's turn, held for the conversation's replay to show instead of a wake. */
  private held = false;
  /** Exocortex messages the process has received, and the wakes it raised (deliveryKey). */
  private readonly delivered = new Set<string>();
  /** Last main-thread message read; with a relay, what an interrupt has consumed. */
  private lastSeenUuid: string | null = null;
  /** For an adopted process, when its relay first saw each task. */
  private readonly taskStarts: Record<string, number>;
  /** Finished tasks Claude Code has yet to answer, each with a turn of its own, in order. */
  private notes: TaskNote[] = [];
  /** Main-thread model calls Claude Code has made since its last result. */
  private callsSinceResult = 0;
  private tasks = new Map<string, LiveTask>();
  /** Every task seen, kept after it ends: its notification can arrive after it left `tasks`. */
  private readonly seenTasks = new Map<string, LiveTask>();
  /** Titles of every task and agent seen, kept after they end so later calls can name them. */
  private readonly taskTitles = new Map<string, string>();
  private titlesFromHistory = false;
  /** After an interrupt, the rest of the interrupted turn up to its result. */
  private discard: { promptUuid: string | null; deadline: ReturnType<typeof setTimeout>; closeAfter: boolean } | null = null;
  private bindingWaiters: Array<{ resolve(binding: HostToolBinding): void; reject(error: Error): void }> = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Claude Code reports what becomes of each message it is sent; without that, queued input waits for the turn to end. */
  private reportsLifecycle = false;
  private closed = false;

  constructor(private readonly convId: string | undefined, key: string, start: StartClaudeRuntime, options: ClaudeCodeSessionOptions = {}) {
    this.key = key;
    this.relay = options.relay ?? null;
    const hello = this.relay?.hello ?? null;
    this.adopted = hello !== null;
    const resume = hello ? hello.resume : options.resume;
    this.resumePoint = resume ? { sessionId: resume.sessionId, resumeAt: resume.resumeAt } : null;
    this.history = (hello ? hello.meta.history : options.history) ?? null;
    this.taskStarts = hello?.taskStarts ?? {};
    if (hello) {
      for (const deliveredKey of hello.delivered) this.delivered.add(deliveredKey);
      this.held = hello.pending;
    }
    this.runtime = start(this.input, () => this.turnBinding());
    void this.read();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Whether the next turn can run here: same settings, and history still ends
   * where this process does (`pending` follows `resume`, the history's latest
   * resume point).
   */
  canContinue(key: string, resume: ResumeData | null, pending: ApiMessage[] = []): boolean {
    if (this.closed || this.turn || key !== this.key) return false;
    if (this.resumePoint) {
      return resume?.sessionId === this.resumePoint.sessionId && resume.resumeAt === this.resumePoint.resumeAt;
    }
    // A new session that has not committed anything yet: history must still start as it did.
    const history = this.history;
    return resume === null && history !== null && pending.length >= history.count
      && historyMark(pending.slice(0, history.count)).key === history.key;
  }

  /** The process has seen everything but user messages it was not sent; notifications it raised itself are not new. */
  planInput(pending: ApiMessage[]): LiveTurnInput {
    const tail = trailingUserMessages(pending);
    const fresh = tail.filter(message => !this.delivered.has(deliveryKey(message)));
    if (fresh.length > 0) return { kind: "prompt", content: buildLiveSessionContent(fresh), messages: fresh };
    if (this.wakeId !== null || this.held) return { kind: "wake" };
    if (tail.length === 0) return { kind: "prompt", content: buildLiveSessionContent([]), messages: [] };
    return { kind: "none" };
  }

  /**
   * Run one Exocortex turn: send `content` (stamped with the state's prompt
   * uuid) and stream until its result, or with null content show the turn
   * Claude Code is running by itself. `sent` are the messages `content`
   * carries; `queued`, messages queued to join the turn.
   */
  /** Learn the agents the conversation started before this process, once. */
  rememberAgentTitles(history: readonly ApiMessage[]): void {
    if (this.titlesFromHistory) return;
    this.titlesFromHistory = true;
    for (const [id, title] of agentTitlesInHistory(history)) if (!this.taskTitles.has(id)) this.taskTitles.set(id, title);
  }

  run(
    state: ClaudeStreamState,
    content: SdkContent | null,
    execute: ToolExecutor | undefined,
    signal: AbortSignal | undefined,
    sent: ApiMessage[] = [],
    queued?: QueuedInputSource,
  ): Promise<StreamResult> {
    if (this.closed) return Promise.reject(new Error("Claude Code exited before finishing the turn."));
    if (this.turn) return Promise.reject(new Error("A Claude Code turn is already running in this conversation."));
    if (signal?.aborted) return Promise.reject(createAbortError());
    // Every turn of this process names the tasks and agents it has seen.
    state.taskTitles = this.taskTitles;

    return new Promise<StreamResult>((resolve, reject) => {
      const heartbeat = setInterval(() => state.callbacks.onActivity?.(), HEARTBEAT_INTERVAL_MS);
      const onAbort = () => this.abort(turn, signal?.reason);
      const turn: Turn = {
        state,
        binding: execute ? { execute, signal } : null,
        source: queued ?? null,
        input: null,
        backlog: null,
        finish: (result, error) => {
          clearInterval(heartbeat);
          signal?.removeEventListener("abort", onAbort);
          if (result) resolve(result);
          else reject(error);
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const onProviderRound = state.callbacks.onProviderRound;
      if (onProviderRound) {
        state.callbacks = {
          ...state.callbacks,
          onProviderRound: (round) => {
            onProviderRound(round);
            this.committed(round.messages.at(-1)?.providerData?.anthropic);
          },
        };
      }

      this.turn = turn;
      this.clearIdleTimer();
      if (turn.binding) {
        for (const waiter of this.bindingWaiters.splice(0)) waiter.resolve(turn.binding);
      }

      if (this.held) {
        // This turn shows the adopted process's turn: wakes an earlier daemon queued for it are moot.
        this.held = false;
        for (const deliveredKey of this.delivered) {
          if (deliveredKey.startsWith(WAKE_KEY_PREFIX)) hooks?.cancelWake(this.convId ?? "", deliveredKey.slice(WAKE_KEY_PREFIX.length));
        }
      }
      if (content !== null && this.wakeId) {
        // This turn shows the work Claude Code started before the prompt runs.
        hooks?.cancelWake(this.convId ?? "", this.wakeId);
      }
      this.wakeId = null;
      while (this.turn === turn && this.buffer.length > 0) this.deliver(turn, this.buffer.shift()!);
      // The shown turn ended with more buffered: another turn Claude Code started.
      for (const message of this.buffer.splice(0)) this.route(message);
      if (content !== null && this.turn === turn) {
        this.markDelivered(sent.map(deliveryKey));
        // A prompt can carry what finished before it; at worst a later turn of its own goes unexplained.
        this.takeInNotes();
        this.input.push({ type: "user", uuid: state.promptUuid ?? randomUUID(), message: { role: "user", content }, parent_tool_use_id: null } as SDKUserMessage);
      } else if (this.turn === turn) {
        this.startInput(turn);
      }
    });
  }

  close(reason: string): void {
    this.end(reason, true);
  }

  /**
   * Let go of the process without stopping it: its relay keeps it running for
   * the next daemon. A running turn ends here as detached, and continues there.
   */
  detach(reason: string): void {
    this.end(reason, false);
  }

  /** Close the process and wait (briefly) until its relay has stopped it. */
  async stop(reason: string): Promise<void> {
    const relay = this.relay;
    this.close(reason);
    await relay?.terminate();
  }

  private end(reason: string, stop: boolean): void {
    if (this.closed) return;
    const detaching = !stop && this.relay !== null;
    this.closed = true;
    if (this.convId && sessions.get(this.convId) === this) sessions.delete(this.convId);
    this.clearIdleTimer();
    if (this.discard) clearTimeout(this.discard.deadline);
    log("info", `anthropic: ${detaching ? "detaching from" : "closing"} the Claude Code process for ${this.convId ?? "a turn"} (${reason})`);
    // Queued messages it was sent stay queued for the next daemon's turn to send.
    if (detaching) for (const uuid of this.turn?.input?.untaken ?? []) void this.withdrawInput(uuid);
    this.turn?.input?.end();
    // Detached first, so closing the SDK side neither ends its input nor kills it.
    if (detaching) this.relay!.detach();
    this.input.close();
    try { this.runtime.close(); } catch { /* best-effort */ }
    this.setTasks(new Map());
    const turn = this.turn;
    this.turn = null;
    turn?.finish(null, detaching ? createDetachedTurnError() : new Error("Claude Code exited before finishing the turn."));
    for (const waiter of this.bindingWaiters.splice(0)) waiter.reject(new Error("The Claude Code process closed."));
  }

  private async read(): Promise<void> {
    try {
      for await (const message of this.runtime) {
        const record = asRecord(message);
        if (record) this.dispatch(record);
      }
      this.fail(new Error("Claude Code exited before finishing the turn."));
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    const turn = this.turn;
    this.turn = null;
    turn?.input?.end();
    turn?.finish(null, error);
    this.close(`it stopped: ${error instanceof Error ? error.message : String(error)}`);
  }

  private dispatch(message: SdkRecord): void {
    if (message.type === "command_lifecycle") this.reportsLifecycle = true;
    const sessionId = str(message.session_id);
    if (sessionId) this.sessionId = sessionId;
    const uuid = str(message.uuid);
    if (uuid && !message.parent_tool_use_id) this.lastSeenUuid = uuid;
    if (message.type === "system" && message.subtype === "background_tasks_changed") this.updateTasks(message.tasks);
    this.route(message);
  }

  /** Hand a message to the turn showing it, or hold it for a turn Claude Code started by itself. */
  private route(message: SdkRecord): void {
    if (this.closed) return;
    if (this.discard) {
      if (message.type !== "result") return;
      const { closeAfter } = this.discard;
      if (endsInterruptedTurn(this.discard.promptUuid, message)) {
        clearTimeout(this.discard.deadline);
        this.discard = null;
      }
      this.notes = [];
      // Interrupting a process an earlier daemon started is how to get a fresh
      // one (current tools and instructions); background tasks still keep it.
      if (closeAfter && !this.discard && !this.turn && this.tasks.size === 0 && this.wakeId === null) {
        this.close("its interrupted turn ended, and an earlier daemon started it");
        return;
      }
      this.settle();
      return;
    }
    if (this.turn) {
      if (this.turn.backlog) this.turn.backlog.push(message);
      else this.deliver(this.turn, message);
      return;
    }
    if (this.wakeId !== null || this.held) {
      this.buffer.push(message);
      return;
    }
    this.noteProgress(message);
    if (startsClaudeTurn(message)) {
      this.buffer.push(message);
      this.requestWake();
    }
  }

  /**
   * Track the finished tasks Claude Code's turns of its own answer. Claude
   * Code answers each finished task with a turn of its own, whose result names
   * the task's run, unless a running turn takes it in first: a model call after
   * a tool round carries every task that finished before it.
   */
  private noteProgress(message: SdkRecord): void {
    if (message.type === "result") {
      this.answered(message);
      this.callsSinceResult = 0;
    } else if (message.type === "system" && message.subtype === "task_notification") {
      this.noteTask(message);
    } else if (message.type === "stream_event" && !message.parent_tool_use_id && asRecord(message.event)?.type === "message_start") {
      if (this.callsSinceResult++ > 0) this.takeInNotes();
    }
  }

  private takeInNotes(): void {
    for (const note of this.notes) note.takenIn = true;
  }

  /** Forget the finished tasks a turn answered or took in. */
  private answered(result: SdkRecord): void {
    const origin = asRecord(result.origin);
    const runId = origin?.kind === "task-notification" ? str(origin.runId) : undefined;
    // Without a run id, Claude Code answered the task shown for the turn.
    const answeredIndex = origin?.kind !== "task-notification" ? -1
      : runId ? this.notes.findIndex(note => note.runId === runId)
      : this.notes.findIndex(note => note.shown);
    this.notes = this.notes.filter((note, i) => i !== answeredIndex && !note.takenIn);
  }

  private deliver(turn: Turn, message: SdkRecord): void {
    if (message.type === "command_lifecycle") {
      this.lifecycle(turn, message);
      return;
    }
    try {
      this.noteProgress(message);
      pushClaudeMessage(turn.state, message);
    } catch (error) {
      this.failTurn(turn, error);
      return;
    }
    if (message.type === "result" && turn.state.done) turn.through = str(message.uuid);
    this.complete(turn);
  }

  /** End the turn at its result, unless Claude Code has queued input of it still to take in. */
  private complete(turn: Turn): void {
    if (this.turn !== turn || !turn.state.done || turn.backlog || turn.input?.waiting) return;
    let result: StreamResult;
    try {
      result = finalizeClaudeStream(turn.state);
    } catch (error) {
      this.failTurn(turn, error);
      return;
    }
    this.turn = null;
    turn.input?.end();
    turn.finish(result);
    this.committed(result.assistantProviderData?.anthropic, turn.through);
    // Kept briefly even without tasks: a task that ended late in the turn can
    // still get a turn of its own, and a quick follow-up reuses the process.
    this.settle();
  }

  private failTurn(turn: Turn, error: unknown): void {
    if (this.turn !== turn) return;
    this.turn = null;
    turn.input?.end();
    turn.finish(null, error);
    this.close(`its turn failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  /** What became of a message Claude Code was sent. */
  private lifecycle(turn: Turn, message: SdkRecord): void {
    const uuid = str(message.command_uuid);
    if (!uuid) return;
    if (message.state === "started") {
      // Queued input waits until the turn's own prompt has started, so that prompt is taken first.
      if (uuid === turn.state.promptUuid) this.startInput(turn);
      const input = turn.input?.take(uuid);
      if (input) this.takeInput(turn, uuid, input);
    } else if (message.state === "cancelled") {
      turn.input?.drop(uuid);
    }
  }

  private startInput(turn: Turn): void {
    if (turn.input || !turn.source || !this.reportsLifecycle || this.turn !== turn) return;
    turn.input = new TurnInput(
      turn.source,
      (uuid, input) => this.input.push({ type: "user", uuid, priority: "next", message: { role: "user", content: buildQueuedInputContent(input) }, parent_tool_use_id: null } as SDKUserMessage),
      (uuid) => this.withdrawInput(uuid),
      () => this.complete(turn),
    );
  }

  private withdrawInput(uuid: string): Promise<boolean> {
    const withdrawn = this.runtime.cancelAsyncMessage?.(uuid) ?? Promise.resolve(false);
    return withdrawn.catch((error) => {
      log("warn", `anthropic: withdrawing a queued message from Claude Code failed: ${error instanceof Error ? error.message : error}`);
      return false;
    });
  }

  /**
   * Claude Code took in queued input: commit it to the conversation where it
   * joined the turn, holding what Claude Code sends meanwhile.
   */
  private takeInput(turn: Turn, uuid: string, input: QueuedInput): void {
    const onQueuedInput = turn.state.callbacks.onQueuedInput;
    takeQueuedInput(turn.state, uuid);
    if (!onQueuedInput) return;
    turn.backlog = [];
    onQueuedInput([input]).then((messages) => {
      this.markDelivered(messages.map(deliveryKey));
      const backlog = turn.backlog ?? [];
      turn.backlog = null;
      for (const message of backlog) this.route(message);
    }, (error) => {
      turn.backlog = null;
      this.failTurn(turn, error);
    });
  }

  /**
   * A stopped turn keeps its in-flight tool calls. Only the turn is
   * interrupted, as in Claude Code itself: background tasks keep running, and
   * a steering message or follow-up continues in this process. A daemon
   * restart instead leaves the turn running for the next daemon to show.
   */
  private abort(turn: Turn, reason: unknown): void {
    if (this.turn !== turn) return;
    if (reason === "daemon-restart" && this.relay) {
      this.detach("the daemon is restarting");
      return;
    }
    this.turn = null;
    // Queued messages Claude Code has not taken in stay queued for the next turn.
    const untaken = turn.input?.untaken ?? [];
    turn.input?.end();
    commitInterruptedRound(turn.state);
    turn.finish(null, createAbortError());
    if (this.closed) return;
    if (turn.state.done) {
      // Its result is in: Claude Code was only still to take in queued input.
      this.relay?.commit(this.lastSeenUuid, null);
      for (const uuid of untaken) void this.withdrawInput(uuid);
    } else {
      // The Claude Code turn now running answers the last queued input it took in, or the prompt.
      const promptUuid = turn.state.inputUuids.at(-1) ?? turn.state.promptUuid;
      // Everything read so far is saved; the relay drops the rest of the turn.
      this.relay?.commit(this.lastSeenUuid, null, { promptUuid });
      const deadline = setTimeout(() => this.close("its interrupted turn did not end"), INTERRUPT_GRACE_MS);
      deadline.unref?.();
      this.discard = { promptUuid, deadline, closeAfter: this.adopted };
      this.runtime.interrupt(untaken.length > 0 ? { cancelQueued: true } : undefined).catch((error) => this.fail(error));
    }
    const backlog = turn.backlog ?? [];
    turn.backlog = null;
    for (const message of backlog) this.route(message);
  }

  private requestWake(): void {
    const wakeId = randomUUID();
    this.wakeId = wakeId;
    this.markDelivered([`${WAKE_KEY_PREFIX}${wakeId}`]);
    this.clearIdleTimer();
    // Claude Code answers finished tasks in order, one turn each.
    const note = this.notes.find(candidate => !candidate.shown);
    if (note) note.shown = true;
    const text = buildWakeText(note ? [note] : []);
    if (this.convId && hooks?.wake(this.convId, text, wakeId)) return;
    // A restarting daemon queues nothing; the next one adopts the process and shows the turn.
    if (getDaemonShutdownMode() === "restart") this.detach("the daemon is restarting");
    else this.close("no turn can show what it started by itself");
  }

  private markDelivered(keys: string[]): void {
    for (const deliveredKey of keys) this.delivered.add(deliveredKey);
    this.relay?.delivered(keys);
  }

  /** History now ends at `data`: the process continues from here, and its relay can forget what came before. */
  private committed(data: ResumeData | undefined, through?: string): void {
    if (!data?.resumeAt) return;
    this.resumePoint = { sessionId: data.sessionId, resumeAt: data.resumeAt };
    this.relay?.commit(through ?? data.resumeAt, this.resumePoint);
  }

  private noteTask(message: SdkRecord): void {
    const id = str(message.task_id);
    const status = str(message.status);
    // Ambient tasks (watchers) are not activity.
    if (!id || !status || !TERMINAL_TASK_STATUSES.has(status) || message.ambient === true) return;
    const task = this.tasks.get(id) ?? this.seenTasks.get(id);
    // A task a subagent launched reports to that subagent, as an Exocortex subagent's own tasks do.
    if (task?.parentTaskId) return;
    const summary = str(message.summary);
    // Only the tasks Claude Code answers with a turn of their own are noted.
    if ((status === "stopped" || status === "killed") && !SELF_STOPPED_SUMMARY.test(summary ?? "")) return;
    const runId = str(message.run_id);
    this.notes.push({
      id,
      ...(runId ? { runId } : {}),
      status,
      title: task?.title ?? summary ?? id,
      toolName: task?.toolName ?? "Task",
      ...(summary ? { summary } : {}),
      ...(str(message.output_file) ? { outputFile: str(message.output_file) } : {}),
    });
  }

  private updateTasks(raw: unknown): void {
    const live = new Map<string, LiveTask>();
    for (const entry of Array.isArray(raw) ? raw : []) {
      const task = asRecord(entry);
      const id = str(task?.task_id);
      // Ambient tasks (watchers) are not activity.
      if (!task || !id || task.ambient === true) continue;
      const taskType = str(task.task_type) ?? "task";
      const parentTaskId = str(task.parent_task_id);
      const seen: LiveTask = {
        title: str(task.description) || id,
        toolName: task.shell_kind === "monitor" ? "Monitor" : BACKGROUND_TASK_TOOLS[taskType] ?? taskType,
        ...(parentTaskId ? { parentTaskId } : {}),
      };
      this.seenTasks.set(id, { ...seen });
      this.taskTitles.set(id, seen.title);
      live.set(id, seen);
    }
    this.setTasks(live);
    this.settle();
  }

  /** Mirror Claude Code's live tasks as the conversation's background tasks. */
  private setTasks(live: Map<string, LiveTask>): void {
    const convId = this.convId;
    if (!convId) {
      this.tasks = live;
      return;
    }
    let changed = false;
    for (const id of this.tasks.keys()) {
      if (!live.has(id)) changed = setBackgroundTaskActive(convId, id, false) || changed;
    }
    for (const [id, task] of live) {
      const known = this.tasks.get(id);
      task.startedAt = known?.startedAt ?? this.taskStarts[id] ?? Date.now();
      // A known task is updated only when its description or kind changed.
      if (known && known.title === task.title && known.toolName === task.toolName) continue;
      const startedAt = task.startedAt;
      changed = setBackgroundTaskActive(convId, id, true, {
        title: task.title,
        startedAt,
        toolName: task.toolName,
        backgroundedAt: startedAt,
        // Claude Code starts no turn for a task it was told to stop, so the
        // stop is never shown as a turn's reason: nothing to suppress.
        stop: () => {
          this.runtime.stopTask(id).catch((error) => {
            log("warn", `anthropic: stopping Claude Code task ${id} failed: ${error instanceof Error ? error.message : error}`);
            // It runs on, so it can be stopped again.
            restoreRunningBackgroundTask(id);
          });
          return true;
        },
      }) || changed;
    }
    this.tasks = live;
    if (changed) hooks?.tasksChanged(convId);
  }

  /** Close once nothing needs the process: no turn, task, pending wake or interrupted turn. */
  private settle(): void {
    if (this.closed || this.turn || this.tasks.size > 0 || this.wakeId !== null || this.held || this.discard) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.close("idle with no background tasks"), IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** The turn a host tool call runs under; Claude Code can make one before its own turn is shown. */
  private turnBinding(): Promise<HostToolBinding> {
    const current = this.turn?.binding;
    if (current) return Promise.resolve(current);
    if (this.closed) return Promise.reject(new Error("The Claude Code process closed."));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (binding: HostToolBinding) => { clearTimeout(timer); resolve(binding); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
      const timer = setTimeout(() => {
        this.bindingWaiters = this.bindingWaiters.filter(entry => entry !== waiter);
        reject(new Error("No Exocortex turn is showing this Claude Code turn, so its Exocortex tools are unavailable."));
      }, BINDING_WAIT_MS);
      this.bindingWaiters.push(waiter);
    });
  }
}
