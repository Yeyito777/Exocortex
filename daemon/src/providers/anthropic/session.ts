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
 */

import { randomUUID } from "node:crypto";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAbortError } from "../../abort";
import type { ToolExecutor } from "../../agent";
import { setBackgroundTaskActive } from "../../conversation-activity";
import { log } from "../../log";
import type { ApiMessage } from "../../messages";
import type { StreamResult } from "../types";
import type { HostToolBinding } from "./host-tools";
import { buildLiveSessionContent, isPlainUserMessage } from "./prompt";
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

/** What a turn sends into a running process. */
export type LiveTurnInput =
  | { kind: "prompt"; content: SdkContent }
  /** Show the turn Claude Code started by itself. */
  | { kind: "wake" }
  /** Only notifications whose work an earlier turn already showed. */
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

let hooks: ClaudeCodeSessionHooks | null = null;
const sessions = new Map<string, ClaudeCodeSession>();

export function configureClaudeCodeSessions(next: ClaudeCodeSessionHooks | null): void {
  hooks = next;
}

export function getClaudeCodeSession(convId: string): ClaudeCodeSession | undefined {
  return sessions.get(convId);
}

/** Start a process for a conversation, replacing any it still had. */
export function openClaudeCodeSession(convId: string | undefined, key: string, start: StartClaudeRuntime): ClaudeCodeSession {
  if (convId) sessions.get(convId)?.close("replaced by a new Claude Code process");
  const session = new ClaudeCodeSession(convId, key, start);
  if (convId) sessions.set(convId, session);
  return session;
}

export function closeAllClaudeCodeSessions(reason: string): void {
  for (const session of [...sessions.values()]) session.close(reason);
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

/** A main-thread message of a model turn (not task bookkeeping, not subagent traffic). */
function startsTurn(message: SdkRecord): boolean {
  if (message.parent_tool_use_id) return false;
  if (message.type === "system") return message.subtype === "init";
  return message.type === "stream_event" || message.type === "assistant" || (message.type === "user" && !message.isReplay);
}

function resultUuids(message: SdkRecord): string[] {
  if (Array.isArray(message.user_message_uuids)) return message.user_message_uuids.filter((id): id is string => typeof id === "string");
  return typeof message.user_message_uuid === "string" ? [message.user_message_uuid] : [];
}

/** Whether a result ends an interrupted turn: its prompt's own result, or any for a turn Claude Code started itself. */
function endsInterruptedTurn(promptUuid: string | null, message: SdkRecord): boolean {
  if (!promptUuid) return true;
  const uuids = resultUuids(message);
  if (uuids.length > 0) return uuids.includes(promptUuid);
  return asRecord(message.origin)?.kind !== "task-notification";
}

function wakeIdOf(message: ApiMessage): string | null {
  const automation = message.metadata?.automation;
  return automation?.kind === WAKE_AUTOMATION_KIND && automation.sourceId ? automation.sourceId : null;
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
  /** Latest resume point this process reported; history ending elsewhere has moved on from it. */
  lastResumeAt: string | null = null;
  private readonly input = new PromptQueue();
  private readonly runtime: ClaudeRuntime;
  private turn: Turn | null = null;
  /** Messages of a turn Claude Code started while no Exocortex turn was showing it. */
  private buffer: SdkRecord[] = [];
  /** Wake queued for the buffered turn. */
  private wakeId: string | null = null;
  private readonly issuedWakes = new Set<string>();
  /** Finished tasks since Claude Code's last result: what its next turn of its own answers. */
  private notes: TaskNote[] = [];
  private tasks = new Map<string, LiveTask>();
  /** After an interrupt, the rest of the interrupted turn up to its result. */
  private discard: { promptUuid: string | null; deadline: ReturnType<typeof setTimeout> } | null = null;
  private bindingWaiters: Array<{ resolve(binding: HostToolBinding): void; reject(error: Error): void }> = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly convId: string | undefined, key: string, start: StartClaudeRuntime) {
    this.key = key;
    this.runtime = start(this.input, () => this.turnBinding());
    void this.read();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Whether the next turn can run here: same settings, and history still ends where this process does. */
  canContinue(key: string, resume: ResumeData | null): boolean {
    return !this.closed && !this.turn && key === this.key
      && resume?.sessionId === this.sessionId && resume.resumeAt === this.lastResumeAt;
  }

  /** The process has seen everything but new user messages; notifications it raised itself are not new. */
  planInput(pending: ApiMessage[]): LiveTurnInput {
    let start = pending.length;
    while (start > 0 && isPlainUserMessage(pending[start - 1])) start--;
    const tail = pending.slice(start);
    const fresh = tail.filter(message => !this.issuedWakes.has(wakeIdOf(message) ?? ""));
    if (fresh.length > 0 || tail.length === 0) return { kind: "prompt", content: buildLiveSessionContent(fresh) };
    if (this.wakeId && tail.some(message => wakeIdOf(message) === this.wakeId)) return { kind: "wake" };
    return { kind: "none" };
  }

  /**
   * Run one Exocortex turn: send `content` (stamped with the state's prompt
   * uuid) and stream until its result, or with null content show the turn
   * Claude Code started by itself.
   */
  run(state: ClaudeStreamState, content: SdkContent | null, execute: ToolExecutor | undefined, signal: AbortSignal | undefined): Promise<StreamResult> {
    if (this.closed) return Promise.reject(new Error("Claude Code exited before finishing the turn."));
    if (this.turn) return Promise.reject(new Error("A Claude Code turn is already running in this conversation."));
    if (signal?.aborted) return Promise.reject(createAbortError());

    return new Promise<StreamResult>((resolve, reject) => {
      const heartbeat = setInterval(() => state.callbacks.onActivity?.(), HEARTBEAT_INTERVAL_MS);
      const onAbort = () => this.abort(turn);
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
            this.noteResumePoint(round.messages.at(-1)?.providerData?.anthropic);
            onProviderRound(round);
          },
        };
      }

      this.turn = turn;
      this.clearIdleTimer();
      if (turn.binding) {
        for (const waiter of this.bindingWaiters.splice(0)) waiter.resolve(turn.binding);
      }

      if (content !== null && this.wakeId) {
        // This turn shows the work Claude Code started before the prompt runs.
        this.issuedWakes.add(this.wakeId);
        hooks?.cancelWake(this.convId ?? "", this.wakeId);
      }
      this.wakeId = null;
      while (this.turn === turn && this.buffer.length > 0) this.deliver(turn, this.buffer.shift()!);
      // The shown turn ended with more buffered: another turn Claude Code started.
      for (const message of this.buffer.splice(0)) this.route(message);
      if (content !== null && this.turn === turn) {
        this.input.push({ type: "user", uuid: state.promptUuid ?? randomUUID(), message: { role: "user", content }, parent_tool_use_id: null } as SDKUserMessage);
      }
    });
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.convId && sessions.get(this.convId) === this) sessions.delete(this.convId);
    this.clearIdleTimer();
    if (this.discard) clearTimeout(this.discard.deadline);
    log("info", `anthropic: closing the Claude Code process for ${this.convId ?? "a turn"} (${reason})`);
    this.input.close();
    try { this.runtime.close(); } catch { /* best-effort */ }
    this.setTasks(new Map());
    const turn = this.turn;
    this.turn = null;
    turn?.finish(null, new Error("Claude Code exited before finishing the turn."));
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
    if (message.type === "system" && message.subtype === "background_tasks_changed") this.updateTasks(message.tasks);
    this.route(message);
  }

  /** Hand a message to the turn showing it, or hold it for a turn Claude Code started by itself. */
  private route(message: SdkRecord): void {
    if (this.closed) return;
    if (this.discard) {
      if (message.type !== "result") return;
      if (endsInterruptedTurn(this.discard.promptUuid, message)) {
        clearTimeout(this.discard.deadline);
        this.discard = null;
      }
      this.notes = [];
      this.settle();
      return;
    }
    if (this.turn) {
      this.deliver(this.turn, message);
      return;
    }
    if (this.wakeId !== null) {
      this.buffer.push(message);
      return;
    }
    this.noteProgress(message);
    if (startsTurn(message)) {
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
    this.noteResumePoint(result.assistantProviderData?.anthropic);
    this.turn = null;
    turn.finish(result);
    // Kept briefly even without tasks: a task that ended late in the turn can
    // still get a turn of its own, and a quick follow-up reuses the process.
    this.settle();
  }

  /**
   * A stopped turn keeps its in-flight tool calls. Only the turn is
   * interrupted, as in Claude Code itself: background tasks keep running, and
   * a steering message or follow-up continues in this process.
   */
  private abort(turn: Turn): void {
    if (this.turn !== turn) return;
    this.turn = null;
    commitInterruptedRound(turn.state);
    turn.finish(null, createAbortError());
    if (this.closed) return;
    const deadline = setTimeout(() => this.close("its interrupted turn did not end"), INTERRUPT_GRACE_MS);
    deadline.unref?.();
    this.discard = { promptUuid: turn.state.promptUuid, deadline };
    this.runtime.interrupt().catch((error) => this.fail(error));
  }

  private requestWake(): void {
    const wakeId = randomUUID();
    this.wakeId = wakeId;
    this.issuedWakes.add(wakeId);
    this.clearIdleTimer();
    const text = buildWakeText(this.notes);
    this.notes = [];
    if (!this.convId || !hooks?.wake(this.convId, text, wakeId)) {
      this.close("no turn can show what it started by itself");
    }
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
      const now = Date.now();
      changed = setBackgroundTaskActive(convId, id, true, {
        title: task.title,
        startedAt: now,
        toolName: task.toolName,
        backgroundedAt: now,
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
    if (this.closed || this.turn || this.tasks.size > 0 || this.wakeId !== null || this.discard) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.close("idle with no background tasks"), IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private noteResumePoint(data: ResumeData | undefined): void {
    if (data?.resumeAt) this.lastResumeAt = data.resumeAt;
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
