/**
 * One Antigravity CLI process (`agy acp`) per Gemini conversation, holding
 * its ACP session.
 *
 * A process stays 30 minutes after its turn, so the conversation's next turn
 * continues in it; it closes sooner when its workspace, instructions or tool
 * text change, history moves past it, or more than MAX_IDLE processes are
 * idle. A new process loads the conversation's session from the CLI's own
 * store (session/load) when its newest point is where history continues
 * (prompt.ts), or starts a new one.
 *
 * Exocortex's host tools reach the turn's tool executor through the MCP
 * bridge, and every tool call of the agent passes the PreToolUse hook (both
 * in bridge.ts), which the process's environment points at.
 */

import { createHash } from "node:crypto";
import { log } from "../../log";
import { createAbortError } from "../../abort";
import type { ToolExecutor } from "../../agent";
import type { ModelInfo } from "../../messages";
import { evaluatePathSafety, evaluateToolCallSafety, formatSafetyBlock } from "../../safety";
import { ANTIGRAVITY_REPLACED_TOOLS, antigravityEquivalent } from "../../tools/antigravity";
import { hostToolDefs, hostToolServerInstructions, type ToolDef } from "../anthropic/host-tools";
import { rememberHostToolAttachments } from "../anthropic/host-tool-attachments";
import { connectivity } from "../../connectivity";
import { setBackgroundTaskActive } from "../../conversation-activity";
import { AuthError } from "../errors";
import { AcpError, AcpProcess } from "./acp";
import { noteGeminiPlan, noteGeminiSignInWorking } from "./auth";
import { attachBridgeTarget, HOOK_SCRIPT, MCP_BRIDGE_SCRIPT, type BridgeCallResult, type BridgeDecision, type BridgePreToolCall } from "./bridge";
import { agyBinary, agyEnv, GeminiUnreachableError, isAgyUnreachableText } from "./cli";
import { ensureExocortexHook } from "./hooks";
import { agyModelLevel } from "./models";
import type { AcpContentBlock } from "./prompt";
import { commitInterruptedRound, finishGeminiTurn, pushGeminiUpdate, runningBackgroundTasks, takeBackgroundedCommands, type GeminiStreamState } from "./stream";
import type { StreamResult } from "../types";

const IDLE_CLOSE_MS = 30 * 60_000;
const MAX_IDLE = 6;
const MCP_SERVER_NAME = "exocortex";

type Json = Record<string, unknown>;

interface TurnBinding {
  execute: ToolExecutor;
  signal?: AbortSignal;
}

export interface GeminiProcessKey {
  cwd: string;
  /** Instructions and host tool text: a process takes them when its session starts. */
  fingerprint: string;
}

const processes = new Map<string, GeminiProcess>();

export interface GeminiSessionHooks {
  /** A conversation's task list changed (a command moved to the background, or one ended). */
  tasksChanged(convId: string): void;
}

let hooks: GeminiSessionHooks | null = null;

export function configureGeminiSessions(next: GeminiSessionHooks | null): void {
  hooks = next;
}

/**
 * How a running prompt is watched. The CLI sends nothing while its own tools
 * run (a command can run for an hour), and nothing either when a model call
 * hangs on a dead connection, which it does not retry by itself. So every
 * tick:
 * - while a tool call is open, the turn is alive: a heartbeat keeps the
 *   stale-stream watchdog off, and commands that moved to the background are
 *   listed as the conversation's tasks;
 * - while no tool call is open and nothing came for `silentMs`, the daemon
 *   checks the network (onNetworkTrouble), which shows the turn waiting for it
 *   when it is down; while it is down the turn is not stale either. Once the
 *   network has been down and is back, a call still silent `recoverMs` later
 *   is stopped and the prompt fails as a network failure, so the turn sends
 *   it again (network-wait.ts) and continues.
 */
export interface GeminiPromptWatch {
  tickMs: number;
  silentMs: number;
  recoverMs: number;
  /** How long a cancelled prompt may take to answer before its process is stopped. */
  cancelGraceMs: number;
  isOnline(): boolean;
}

const DEFAULT_WATCH: GeminiPromptWatch = {
  tickMs: 15_000,
  silentMs: 90_000,
  recoverMs: 60_000,
  cancelGraceMs: 15_000,
  isOnline: () => connectivity.isOnline(),
};

let watch: GeminiPromptWatch = DEFAULT_WATCH;

export function setGeminiPromptWatchForTest(next: Partial<GeminiPromptWatch> | null): void {
  watch = next ? { ...DEFAULT_WATCH, ...next } : DEFAULT_WATCH;
}

export function fingerprintOf(system: string, tools: readonly ToolDef[]): string {
  return createHash("sha256").update(system).update("\u0000").update(JSON.stringify(tools.map(t => [t.name, t.description, t.input_schema]))).digest("hex");
}

/** A tool call of the agent Exocortex refuses, with the reason the agent is told, or null. */
export function geminiToolDenial(call: BridgePreToolCall, cwd: string): string | null {
  const name = call.name ?? "";
  const replaced = ANTIGRAVITY_REPLACED_TOOLS[name];
  if (replaced) return `This tool is disabled in Exocortex. ${replaced}`;
  const equivalent = antigravityEquivalent(name, call.args ?? {});
  if (!equivalent) return null;
  const textual = evaluateToolCallSafety(equivalent.tool.name, equivalent.input);
  if (!textual.allowed) return formatSafetyBlock(textual);
  const resolved = evaluatePathSafety(equivalent.tool.name, equivalent.input, cwd);
  return resolved.allowed ? null : formatSafetyBlock(resolved);
}

export class GeminiProcess {
  readonly acp: AcpProcess;
  sessionId: string | null = null;
  private model: string | null = null;
  private level: string | null = null;
  /** The session offered a model choice: the CLI has Google's model list. */
  private hasModelList = false;
  /** Tasks listed for the running prompt's background commands. */
  private readonly backgroundTasks = new Set<string>();
  private binding: TurnBinding | null = null;
  private state: GeminiStreamState | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly releaseBridge: () => void;
  private tools: ToolDef[];
  private instructions: string;
  /** Last completed or committed point, the session's head (prompt.ts). */
  head: string | null = null;
  busy = false;
  lastUsedAt = Date.now();
  closed = false;

  constructor(readonly convId: string, readonly key: GeminiProcessKey, private readonly system: string, toolsList: unknown[] | undefined) {
    this.tools = hostToolDefs(toolsList);
    this.instructions = hostToolServerInstructions(this.tools);
    ensureExocortexHook();
    const bridge = attachBridgeTarget({
      tools: () => ({
        tools: this.tools.map(def => ({ name: def.name, description: def.description, inputSchema: def.input_schema })),
        instructions: this.instructions,
      }),
      call: (name, args, signal) => this.callHostTool(name, args, signal),
      preToolUse: (call, cwd) => this.preToolUse(call, cwd),
    });
    this.releaseBridge = bridge.release;
    this.bridgeEnv = {
      EXOCORTEX_GEMINI_SOCKET: bridge.socketPath,
      EXOCORTEX_GEMINI_TOKEN: bridge.token,
    };
    this.acp = new AcpProcess({
      binary: agyBinary(),
      // Exocortex has no permission prompt; the hook applies its denylist instead.
      args: ["acp", "--dangerously-skip-permissions"],
      cwd: key.cwd,
      env: agyEnv({
        ...this.bridgeEnv,
        EXOCORTEX_GEMINI_HOOK: HOOK_SCRIPT,
        EXOCORTEX_GEMINI_BUN: process.execPath,
      }),
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onExit: (code, stderr) => {
        if (!this.closed) log("warn", `gemini: Antigravity CLI for ${convId} exited (code ${code})${stderr ? `: ${stderr}` : ""}`);
        this.dispose();
      },
    });
  }

  private readonly bridgeEnv: Record<string, string>;

  private mcpServers(): Json[] {
    if (this.tools.length === 0) return [];
    return [{
      name: MCP_SERVER_NAME,
      command: process.execPath,
      args: [MCP_BRIDGE_SCRIPT],
      env: Object.entries(this.bridgeEnv).map(([name, value]) => ({ name, value })),
    }];
  }

  private sessionMeta(): Json {
    return this.system ? { antigravity: { systemPrompt: { append: this.system } } } : {};
  }

  async initialize(): Promise<void> {
    await this.acp.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "exocortex", version: "1" },
    });
  }

  /** Load `resume` if the CLI still has it, else start a new session. Returns whether it loaded. */
  async openSession(resume: string | null): Promise<boolean> {
    if (resume) {
      try {
        const result = await this.acp.request<Json>("session/load", { sessionId: resume, cwd: this.key.cwd, mcpServers: this.mcpServers(), _meta: this.sessionMeta() });
        this.sessionId = resume;
        this.noteSession(result);
        return true;
      } catch (error) {
        log("warn", `gemini: loading session ${resume} failed (${error instanceof Error ? error.message : error}); starting a new one`);
      }
    }
    const result = await this.acp.request<Json>("session/new", { cwd: this.key.cwd, mcpServers: this.mcpServers(), _meta: this.sessionMeta() });
    const sessionId = typeof result.sessionId === "string" ? result.sessionId : null;
    if (!sessionId) throw new Error("The Antigravity CLI started no session.");
    this.sessionId = sessionId;
    this.noteSession(result);
    return false;
  }

  private noteSession(result: Json): void {
    const tier = ((result._meta as Json | undefined)?.antigravity as Json | undefined)?.tier as Json | undefined;
    if (typeof tier?.name === "string") noteGeminiPlan(tier.name);
    this.readConfig(result.configOptions);
  }

  private readConfig(options: unknown): void {
    for (const option of Array.isArray(options) ? options as Json[] : []) {
      if (option.id === "model") this.hasModelList = Array.isArray(option.options) ? option.options.length > 0 : true;
      if (option.id === "model" && typeof option.currentValue === "string") this.model = option.currentValue;
      if (option.id === "thought_level" && typeof option.currentValue === "string") this.level = option.currentValue;
    }
  }

  async configure(model: string, modelInfo: ModelInfo | null, effort: Parameters<typeof agyModelLevel>[1]): Promise<void> {
    const sessionId = this.sessionId!;
    // Offline, the CLI starts sessions without a model choice and then refuses every model.
    if (!this.hasModelList) throw new GeminiUnreachableError("the session came up without its model list");
    if (this.model !== model) {
      const result = await this.acp.request<Json>("session/set_config_option", { sessionId, configId: "model", value: model });
      this.readConfig(result.configOptions);
      if (this.model !== model) throw new Error(`The Antigravity CLI does not offer ${model} on this account.`);
    }
    const level = agyModelLevel(modelInfo, effort);
    if (this.level !== level) {
      try {
        const result = await this.acp.request<Json>("session/set_config_option", { sessionId, configId: "thought_level", value: level });
        this.readConfig(result.configOptions);
      } catch (error) {
        log("warn", `gemini: thinking level ${level} refused for ${model} (${error instanceof Error ? error.message : error})`);
      }
    }
  }

  /** Run one prompt to its result. */
  async prompt(state: GeminiStreamState, content: AcpContentBlock[], execute: ToolExecutor | undefined, signal: AbortSignal | undefined): Promise<StreamResult> {
    if (signal?.aborted) throw createAbortError();
    this.cancelIdle();
    this.busy = true;
    this.state = state;
    this.binding = execute ? { execute, signal } : null;
    let cancelled = false;
    let networkLost: GeminiUnreachableError | null = null;
    let cancelTimer: ReturnType<typeof setTimeout> | null = null;
    const cancel = () => {
      state.cancelling = true;
      this.acp.notify("session/cancel", { sessionId: this.sessionId });
      // The CLI answers a cancel with the prompt's result; if it does not, stop it. Only this
      // prompt: a steer sends the next one into the same process right after the cancel.
      cancelTimer ??= setTimeout(() => { if (this.state === state) this.close("it did not stop after a cancel"); }, watch.cancelGraceMs);
      cancelTimer.unref?.();
    };
    const onAbort = () => {
      cancelled = true;
      cancel();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const tasks = this.backgroundTasks;
    state.onBackgroundEnd = (taskId) => {
      if (tasks.delete(taskId) && setBackgroundTaskActive(this.convId, taskId, false)) hooks?.tasksChanged(this.convId);
    };
    let sawOffline = false;
    let onlineAgainAt: number | null = null;
    let lastTroubleAt = 0;
    const ticker = setInterval(() => {
      if (cancelled || networkLost) return;
      const now = state.now();
      if (state.openToolUses.size > 0) {
        // The CLI's own tools are running: alive, however long they take.
        state.callbacks.onActivity?.();
        this.listBackgroundTasks(state);
        sawOffline = false;
        onlineAgainAt = null;
        return;
      }
      if (now - state.lastUpdateAt < watch.silentMs) {
        sawOffline = false;
        onlineAgainAt = null;
        return;
      }
      if (!watch.isOnline()) {
        // Silent because the network is down, which the turn shows and waits out: not a stale stream.
        state.callbacks.onActivity?.();
        sawOffline = true;
        onlineAgainAt = null;
        return;
      }
      if (sawOffline) {
        onlineAgainAt ??= now;
        if (now - onlineAgainAt >= watch.recoverMs && now - state.lastUpdateAt >= watch.recoverMs) {
          log("warn", `gemini: no reply from the Antigravity CLI for ${this.convId} since the network dropped; stopping the request to send it again`);
          networkLost = new GeminiUnreachableError("no reply since the network dropped");
          cancel();
        }
        return;
      }
      // Silent with the network seemingly up: have the daemon check it.
      if (now - lastTroubleAt >= watch.silentMs) {
        lastTroubleAt = now;
        state.callbacks.onNetworkTrouble?.();
      }
    }, watch.tickMs);
    ticker.unref?.();
    try {
      const result = await this.acp.request<Json>("session/prompt", { sessionId: this.sessionId, prompt: content });
      if (networkLost && !signal?.aborted) {
        commitInterruptedRound(state);
        throw networkLost;
      }
      if (cancelled || signal?.aborted || result.stopReason === "cancelled") {
        commitInterruptedRound(state);
        throw createAbortError();
      }
      const finished = finishGeminiTurn(state, result);
      return finished;
    } catch (error) {
      if (cancelled || signal?.aborted) {
        commitInterruptedRound(state);
        throw createAbortError();
      }
      // Keep what the agent did before the failure.
      commitInterruptedRound(state);
      if (networkLost) throw networkLost;
      throw translateAcpError(error);
    } finally {
      clearInterval(ticker);
      if (cancelTimer) clearTimeout(cancelTimer);
      signal?.removeEventListener("abort", onAbort);
      // The session holds everything up to its newest committed point, finished turn or not.
      if (state.lastMark) this.head = state.lastMark;
      for (const taskId of [...tasks, ...runningBackgroundTasks(state)]) state.onBackgroundEnd?.(taskId);
      state.onBackgroundEnd = undefined;
      this.state = null;
      this.binding = null;
      this.busy = false;
      this.lastUsedAt = Date.now();
      if (!this.closed) this.scheduleIdle();
    }
  }

  /** List commands that moved to the background as the conversation's tasks. */
  private listBackgroundTasks(state: GeminiStreamState): void {
    let changed = false;
    for (const command of takeBackgroundedCommands(state)) {
      const title = command.command.replace(/\s+/g, " ").trim().slice(0, 200) || "Background command";
      this.backgroundTasks.add(command.taskId);
      changed = setBackgroundTaskActive(this.convId, command.taskId, true, {
        title,
        startedAt: command.startedAt,
        toolName: "run_command",
        backgroundedAt: state.now(),
        cwd: this.key.cwd,
        ...(command.logPath ? { outputPath: command.logPath } : {}),
      }) || changed;
    }
    if (changed) hooks?.tasksChanged(this.convId);
  }

  private onNotification(method: string, params: Json): void {
    if (method !== "session/update") return;
    if (params.sessionId !== this.sessionId) return;
    const update = params.update as Json | undefined;
    if (!update) return;
    // Outside a prompt (a session/load replaying history): nothing to show.
    if (!this.state) return;
    // The CLI is answering: its sign-in works, so a retry need not check it again.
    noteGeminiSignInWorking();
    pushGeminiUpdate(this.state, update);
  }

  private async onRequest(method: string, params: Json): Promise<unknown> {
    if (method === "session/request_permission") {
      // Unattended, as under --dangerously-skip-permissions; the hook already refused what Exocortex refuses.
      const options = Array.isArray(params.options) ? params.options as Json[] : [];
      const allow = options.find(option => option.kind === "allow_once") ?? options.find(option => String(option.kind ?? "").startsWith("allow"));
      return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
    }
    throw new Error(`Exocortex does not support ${method}`);
  }

  private async callHostTool(name: string, args: Json, signal: AbortSignal): Promise<BridgeCallResult> {
    if (!this.tools.some(tool => tool.name === name)) return { text: `Unknown tool: ${name}`, isError: true };
    const binding = this.binding;
    if (!binding) return { text: "No Exocortex turn is running to execute this tool.", isError: true };
    // A chrono wait may name a background task the agent was just told about: list it first.
    if (this.state) this.listBackgroundTasks(this.state);
    // Match the call the agent announced, so history and Tasks UI entries agree.
    const id = this.openCallFor(name, args);
    const [result] = await binding.execute([{ id, name, input: args }], binding.signal ? AbortSignal.any([binding.signal, signal]) : signal);
    if (!result) return { text: `${name} returned no result.`, isError: true };
    // The CLI gave up on the call (its three-minute limit): its own message is what the agent saw.
    if (signal.aborted) return { text: result.output, isError: true };
    if (result.attachments?.length) rememberHostToolAttachments(id, result.attachments);
    this.state?.hostResults.set(id, { output: result.output, isError: result.isError });
    return { text: result.output, isError: result.isError };
  }

  /** The open tool call this host tool call answers: the oldest open one of that name whose input matches. */
  private openCallFor(name: string, args: Json): string {
    const state = this.state;
    if (state) {
      const wanted = JSON.stringify(args);
      let fallback: string | null = null;
      for (const id of state.openToolUses) {
        if (state.toolNames.get(id) !== name || state.hostResults.has(id)) continue;
        const block = state.blocks.find(b => b.type === "tool_call" && b.id === id);
        if (block?.type === "tool_call" && JSON.stringify(block.input) === wanted) return id;
        fallback ??= id;
      }
      if (fallback) return fallback;
    }
    return `gemini-host-${Date.now().toString(36)}`;
  }

  private preToolUse(call: BridgePreToolCall, cwd: string): BridgeDecision | null {
    const reason = geminiToolDenial(call, cwd || this.key.cwd);
    if (reason) log("info", `gemini: refused ${call.name} for ${this.convId}: ${reason.split("\n")[0]}`);
    return reason ? { decision: "deny", reason } : null;
  }

  matches(key: GeminiProcessKey): boolean {
    return !this.closed && this.key.cwd === key.cwd && this.key.fingerprint === key.fingerprint;
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdle(): void {
    this.cancelIdle();
    this.idleTimer = setTimeout(() => this.close("it was idle for 30 minutes"), IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
    capIdleProcesses();
  }

  close(reason: string): void {
    if (this.closed) return;
    log("info", `gemini: closing the Antigravity CLI for ${this.convId}: ${reason}`);
    this.dispose();
    this.acp.close();
  }

  private dispose(): void {
    this.closed = true;
    this.cancelIdle();
    this.releaseBridge();
    if (processes.get(this.convId) === this) processes.delete(this.convId);
  }
}

function capIdleProcesses(): void {
  const idle = [...processes.values()].filter(p => !p.busy && !p.closed).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  while (idle.length > MAX_IDLE) idle.shift()!.close("too many idle Antigravity processes");
}

export function getGeminiProcess(convId: string): GeminiProcess | undefined {
  const process = processes.get(convId);
  return process && !process.closed ? process : undefined;
}

export function openGeminiProcess(convId: string, key: GeminiProcessKey, system: string, tools: unknown[] | undefined): GeminiProcess {
  processes.get(convId)?.close("the conversation started a new one");
  const created = new GeminiProcess(convId, key, system, tools);
  processes.set(convId, created);
  return created;
}

export function closeAllGeminiProcesses(reason: string): void {
  for (const process of [...processes.values()]) process.close(reason);
}

export class GeminiQuotaError extends Error {
  override readonly name = "GeminiQuotaError";
}

/** An ACP error as the error Exocortex acts on: sign-in, quota, or the CLI's own message. */
export function translateAcpError(error: unknown): Error {
  if (error instanceof GeminiUnreachableError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/authentication required|not signed in|please sign in|login required|unauthenticated|invalid_grant/i.test(message)) {
    return new AuthError(`The Antigravity CLI lost its Google sign-in: ${message}. Run \`exocortexd login gemini\` in a terminal.`);
  }
  if (/quota|resource.?exhausted|rate.?limit|429|limit (?:reached|exceeded)|out of credits/i.test(message)) {
    return new GeminiQuotaError(`Gemini usage limit reached on the Google AI plan: ${message}`);
  }
  if (isAgyUnreachableText(message)) return new GeminiUnreachableError(message);
  if (error instanceof AcpError) return new Error(`Antigravity CLI: ${message}`);
  return error instanceof Error ? error : new Error(message);
}
