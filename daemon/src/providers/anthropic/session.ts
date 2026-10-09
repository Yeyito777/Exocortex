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
 * A process run by a relay (relay.ts) also outlives the daemon. A restart
 * detaches it instead of interrupting its turn, and the next daemon adopts it:
 * the relay replays what the old daemon had not saved, and replaying the
 * conversation shows the rest of the turn.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAbortError, createDetachedTurnError } from "../../abort";
import type { ToolExecutor } from "../../agent";
import { setBackgroundTaskActive } from "../../conversation-activity";
import { getDaemonShutdownMode } from "../../daemon-lifecycle";
import { log } from "../../log";
import type { ApiMessage } from "../../messages";
import type { StreamResult } from "../types";
import type { HostToolBinding } from "./host-tools";
import { buildLiveSessionContent, trailingUserMessages } from "./prompt";
import type { ClaudeRelay } from "./relay-client";
import { endsInterruptedTurn, startsClaudeTurn, type RelayHistoryMark, type RelayResumePoint } from "./relay-protocol";
import { commitInterruptedRound, finalizeClaudeStream, pushClaudeMessage, type ClaudeStreamState } from "./stream";
import type { AnthropicAssistantProviderData } from "./types";

type SdkRecord = Record<string, unknown>;
type SdkContent = SDKUserMessage["message"]["content"];
type ResumeData = AnthropicAssistantProviderData["anthropic"];

export type ClaudeRuntime = Pick<Query, "interrupt" | "stopTask" | "close"> & AsyncIterable<unknown>;
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
const BACKGROUND_TASK_TOOLS: Record<string, string> = { local_bash: "Bash", local_agent: "Agent" };
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
}

interface TaskNote {
  id: string;
  status: string;
  title: string;
  summary?: string;
  outputFile?: string;
}

interface Turn {
  state: ClaudeStreamState;
  binding: HostToolBinding | null;
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

/** The notification message shown before a turn Claude Code started by itself. */
export function buildWakeText(notes: readonly TaskNote[]): string {
  if (notes.length === 0) return "[notification] Claude Code resumed work on its own.";
  return notes.map(note => [
    `[notification] Background task ${note.status === "completed" || note.status === "failed" ? note.status : "stopped"}: ${note.id}`,
    `Command: ${note.title}`,
    ...(note.summary ? [`Status: ${note.summary}`] : []),
    ...(note.outputFile ? [`Output: ${note.outputFile}`] : []),
  ].join("\n")).join("\n\n");
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
  /** Finished tasks since Claude Code's last result: what its next turn of its own answers. */
  private notes: TaskNote[] = [];
  private tasks = new Map<string, LiveTask>();
  /** After an interrupt, the rest of the interrupted turn up to its result. */
  private discard: { promptUuid: string | null; deadline: ReturnType<typeof setTimeout>; closeAfter: boolean } | null = null;
  private bindingWaiters: Array<{ resolve(binding: HostToolBinding): void; reject(error: Error): void }> = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
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
   * Claude Code is running by itself. `sent` are the messages `content` carries.
   */
  run(
    state: ClaudeStreamState,
    content: SdkContent | null,
    execute: ToolExecutor | undefined,
    signal: AbortSignal | undefined,
    sent: ApiMessage[] = [],
  ): Promise<StreamResult> {
    if (this.closed) return Promise.reject(new Error("Claude Code exited before finishing the turn."));
    if (this.turn) return Promise.reject(new Error("A Claude Code turn is already running in this conversation."));
    if (signal?.aborted) return Promise.reject(createAbortError());

    return new Promise<StreamResult>((resolve, reject) => {
      const heartbeat = setInterval(() => state.callbacks.onActivity?.(), HEARTBEAT_INTERVAL_MS);
      const onAbort = () => this.abort(turn, signal?.reason);
      const turn: Turn = {
        state,
        binding: execute ? { execute, signal } : null,
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
        this.input.push({ type: "user", uuid: state.promptUuid ?? randomUUID(), message: { role: "user", content }, parent_tool_use_id: null } as SDKUserMessage);
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
    turn?.finish(null, error);
    this.close(`it stopped: ${error instanceof Error ? error.message : String(error)}`);
  }

  private dispatch(message: SdkRecord): void {
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
      this.deliver(this.turn, message);
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

  /** Track finished tasks since Claude Code's last result: what its next turn answers. */
  private noteProgress(message: SdkRecord): void {
    if (message.type === "result") this.notes = [];
    else if (message.type === "system" && message.subtype === "task_notification") this.noteTask(message);
  }

  private deliver(turn: Turn, message: SdkRecord): void {
    let result: StreamResult | null = null;
    try {
      this.noteProgress(message);
      pushClaudeMessage(turn.state, message);
      if (turn.state.done) result = finalizeClaudeStream(turn.state);
    } catch (error) {
      this.turn = null;
      turn.finish(null, error);
      this.close(`its turn failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!result) return;
    this.turn = null;
    turn.finish(result);
    this.committed(result.assistantProviderData?.anthropic, str(message.uuid));
    // Kept briefly even without tasks: a task that ended late in the turn can
    // still get a turn of its own, and a quick follow-up reuses the process.
    this.settle();
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
    commitInterruptedRound(turn.state);
    turn.finish(null, createAbortError());
    if (this.closed) return;
    // Everything read so far is saved; the relay drops the rest of the turn.
    this.relay?.commit(this.lastSeenUuid, null, { promptUuid: turn.state.promptUuid });
    const deadline = setTimeout(() => this.close("its interrupted turn did not end"), INTERRUPT_GRACE_MS);
    deadline.unref?.();
    this.discard = { promptUuid: turn.state.promptUuid, deadline, closeAfter: this.adopted };
    this.runtime.interrupt().catch((error) => this.fail(error));
  }

  private requestWake(): void {
    const wakeId = randomUUID();
    this.wakeId = wakeId;
    this.markDelivered([`${WAKE_KEY_PREFIX}${wakeId}`]);
    this.clearIdleTimer();
    const text = buildWakeText(this.notes);
    this.notes = [];
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
    if (!id || !status || !TERMINAL_TASK_STATUSES.has(status)) return;
    const summary = str(message.summary);
    this.notes.push({
      id,
      status,
      title: this.tasks.get(id)?.title ?? summary ?? id,
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
      live.set(id, { title: str(task.description) || id, toolName: BACKGROUND_TASK_TOOLS[taskType] ?? taskType });
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
      if (this.tasks.has(id)) continue;
      const startedAt = this.taskStarts[id] ?? Date.now();
      changed = setBackgroundTaskActive(convId, id, true, {
        title: task.title,
        startedAt,
        toolName: task.toolName,
        backgroundedAt: startedAt,
        stop: () => {
          this.runtime.stopTask(id).catch((error) => log("warn", `anthropic: stopping Claude Code task ${id} failed: ${error instanceof Error ? error.message : error}`));
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
