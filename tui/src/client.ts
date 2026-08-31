/**
 * Client for connecting to exocortexd through a local socket or an SSH proxy.
 *
 * Both transports carry the same JSON-lines protocol.
 */

import { connect } from "net";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { hostname } from "os";
import type { Command, DaemonShutdownMode, Event, GoalAction, MoveSidebarItemsOptions, OpenAILoginMethod, QueuedCommandInvocation, QueueTiming, QueueWaitTarget, ToolPolicyMutation, TrimMode, SidebarItemRef } from "./protocol";
import type { ProviderId, ModelId, EffortLevel, ImageAttachment, TokenUsageSource } from "./messages";
import { socketPath, isWindows } from "@exocortex/shared/paths";
import { PERFORMANCE_PROFILING_ENABLED } from "@exocortex/shared/performance-profiling";
import type { RealtimeVoice } from "@exocortex/shared/realtime";
import { log } from "./log";
import { BtwMutationReplay, isBtwMutation } from "./btw/replay";
import {
  DEFAULT_SSH_PROBE_TIMEOUT_MS,
  appendSshStderr,
  probeSshProxy,
  spawnSshProxy,
  sshStderrSuffix,
  validateSshAlias,
  type ProbedSshConnection,
  type SpawnSshProcess,
  type SshProcess,
} from "./ssh-transport";

export type EventHandler = (event: Event) => void;
export type LlmCompleteCallback = (text: string) => void;
export type LlmErrorCallback = (message: string) => void;
export type TranscriptionCallback = (text: string) => void;
export type TranscriptionErrorCallback = (message: string) => void;

export interface ConnectResult {
  /** Commands that entered the offline queue before this socket became ready. */
  replayedCommands: Command[];
  /** The adopted SSH probe already requested the normal daemon bootstrap. */
  bootstrapAlreadyRequested?: boolean;
}

interface ClientTransport {
  write(data: string): unknown;
  end(): unknown;
  destroy(): unknown;
}

interface ActiveSshConnection {
  transport: ClientTransport;
  stderr: string;
  connected: boolean;
  intentionalClose: boolean;
  finished: boolean;
}

export interface DaemonClientTransportOptions {
  spawnSshProcess?: SpawnSshProcess;
  sshProbeTimeoutMs?: number;
  localHostname?: string;
}

type ReplayableQueueCommand = Extract<Command, { type: "queue_message" | "unqueue_message" }>;
type ReplayableUnwindCommand = Extract<Command, { type: "unwind_conversation" }>;
function replayableQueueCommandKey(command: Command): string | null {
  if (command.type === "queue_message" && command.queueId) return `enqueue:${command.queueId}`;
  if (command.type === "unqueue_message" && command.queueId) return `unqueue:${command.queueId}`;
  return null;
}

export class DaemonClient {
  // `socket` is kept as the transport field name because most client logic only
  // needs write/end/destroy. It is either a Unix socket or an SSH process facade.
  private socket: ClientTransport | null = null;
  private activeSshConnection: ActiveSshConnection | null = null;
  private buffer = "";
  private handler: EventHandler;
  private _connected = false;
  private socketPath: string;
  private onDisconnect: ((shutdownMode: DaemonShutdownMode | null) => void) | null = null;
  private announcedShutdownMode: DaemonShutdownMode | null = null;
  private intentionalDisconnect = false;
  // Commands issued while the daemon is unavailable are replayed on the next
  // successful connect so the TUI can keep accepting input during reconnect.
  private pendingCommands: Command[] = [];
  /**
   * Enqueue/unqueue mutations remain unresolved after socket.write(): the daemon
   * may disconnect before durably applying them or before its canonical response
   * reaches us. Stable queue ids make replay idempotent, so retain these commands
   * until a queue snapshot conclusively settles them.
   */
  private unresolvedQueueCommands = new Map<string, { command: ReplayableQueueCommand; sequence: number }>();
  /** Ambiguous socket writes are retried with the same durable operation UUID. */
  private unresolvedUnwindCommands = new Map<string, { command: ReplayableUnwindCommand; sequence: number }>();
  private readonly btwMutationReplay = new BtwMutationReplay();
  /** Original issuance order shared by connected-unresolved and offline commands. */
  private commandSequences = new WeakMap<Command, number>();
  private nextCommandSequence = 0;
  private llmCallbacks = new Map<string, { onSuccess: LlmCompleteCallback; onError?: LlmErrorCallback }>();
  private transcriptionCallbacks = new Map<string, { onSuccess: TranscriptionCallback; onError?: TranscriptionErrorCallback }>();
  private pendingConversationLoads = new Map<string, { convId: string; startedAt: number }>();
  private pendingConversationHistoryLoads = new Map<string, { convId: string; requestSource: "initial-backfill" | "viewport"; startedAt: number }>();
  private pendingToolOutputLoads = new Map<string, { convId: string; requested: number | null; startedAt: number }>();
  private nextReqId = 0;
  private readonly spawnSshProcess: SpawnSshProcess;
  private readonly sshProbeTimeoutMs: number;
  private readonly localHostname: string;
  private sshAlias: string | null = null;
  private sshSwitchingTo: string | null = null;
  private sshSwitchGeneration = 0;
  private cancelSshProbe: ((reason: string) => void) | null = null;
  private pendingSshConnection: (ProbedSshConnection & { alias: string }) | null = null;

  constructor(
    handler: EventHandler,
    overrideSocketPath?: string,
    private readonly performanceProfilingEnabled = PERFORMANCE_PROFILING_ENABLED,
    transportOptions: DaemonClientTransportOptions = {},
  ) {
    this.handler = handler;
    this.socketPath = overrideSocketPath ?? socketPath();
    this.spawnSshProcess = transportOptions.spawnSshProcess ?? spawnSshProxy;
    this.sshProbeTimeoutMs = transportOptions.sshProbeTimeoutMs ?? DEFAULT_SSH_PROBE_TIMEOUT_MS;
    this.localHostname = transportOptions.localHostname ?? hostname();
  }

  get connected(): boolean { return this._connected; }
  get remoteAlias(): string | null { return this.sshAlias; }

  async connect(): Promise<ConnectResult> {
    this.intentionalDisconnect = false;
    this.announcedShutdownMode = null;
    this.buffer = "";
    return this.sshAlias ? this.connectSsh(this.sshAlias) : this.connectLocal();
  }

  private async connectLocal(): Promise<ConnectResult> {
    return new Promise((resolve, reject) => {
      // Named pipes on Windows don't exist as files — skip the filesystem check
      if (!isWindows && !existsSync(this.socketPath)) {
        reject(this.socketMissingError());
        return;
      }

      const socket = connect(this.socketPath);
      // Keep the in-flight transport addressable so a local /ssh route switch
      // can cancel it before net.Socket emits connect.
      this.socket = socket;
      let resolved = false;
      let rejected = false;
      const fail = (error: Error) => {
        if (resolved || rejected) return;
        rejected = true;
        reject(error);
      };

      socket.on("connect", () => {
        if (this.socket !== socket || this.sshAlias || this.intentionalDisconnect) {
          fail(new Error("Local daemon connection was superseded by another route."));
          socket.destroy();
          return;
        }
        this._connected = true;
        resolved = true;
        this.writeCommand({ type: "client_capabilities", capabilities: ["targeted-unwind", "sidebar-reorder-delta", "sidebar-state-patch"] });
        // Report the queue state atomically with the flush. Input can enqueue a
        // command while the socket attempt is still in flight, so a pre-connect
        // queue snapshot would already be stale here.
        const replayedCommands = this.flushPendingCommands();
        resolve({ replayedCommands });
      });
      socket.on("data", (data) => {
        if (this.socket === socket) this.onData(data);
      });
      socket.on("close", () => {
        this.handleSocketClose(socket, resolved);
        fail(new Error("Local daemon connection closed before it became ready."));
      });
      socket.on("error", (err) => {
        if (this.socket === socket) this._connected = false;
        if (!resolved) {
          const code = (err as NodeJS.ErrnoException).code;
          if (isWindows && (code === "ENOENT" || code === "ECONNREFUSED")) {
            fail(this.socketMissingError());
          } else {
            fail(new Error(`Failed to connect: ${err.message}`));
          }
        }
      });
    });
  }

  private async connectSsh(alias: string): Promise<ConnectResult> {
    return new Promise((resolve, reject) => {
      const probed = this.pendingSshConnection?.alias === alias
        ? this.pendingSshConnection
        : null;
      if (probed) this.pendingSshConnection = null;
      let process: SshProcess;
      if (probed) {
        process = probed.process;
      } else {
        try {
          process = this.spawnSshProcess(alias);
        } catch (error) {
          reject(new Error(`Could not start SSH proxy for ${alias}: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
      }

      let active!: ActiveSshConnection;
      const transport: ClientTransport = {
        write: data => process.stdin.write(data),
        end: () => {
          try { process.stdin.end(); } catch { /* already closed */ }
          try { process.kill(); } catch { /* already gone */ }
        },
        destroy: () => {
          try { process.kill(); } catch { /* already gone */ }
        },
      };
      active = {
        transport,
        stderr: probed?.stderr ?? "",
        connected: false,
        intentionalClose: false,
        finished: false,
      };
      this.socket = transport;
      this.activeSshConnection = active;

      const finish = (reason: string) => {
        if (active.finished) return;
        active.finished = true;
        const wasCurrent = this.socket === transport;
        if (wasCurrent && !active.intentionalClose) {
          const message = active.connected
            ? `SSH connection to ${alias} was lost: ${reason}${sshStderrSuffix(active.stderr)}`
            : `Could not connect through SSH alias ${alias}: ${reason}${sshStderrSuffix(active.stderr)}`;
          this.handler({
            type: "ssh_status",
            mode: "remote",
            state: "failed",
            alias,
            switched: false,
            message,
          });
        }
        try { process.kill(); } catch { /* already gone */ }
        this.handleSocketClose(transport, active.connected);
        if (!active.connected) reject(new Error(
          `Could not connect through SSH alias ${alias}: ${reason}${sshStderrSuffix(active.stderr)}`,
        ));
      };

      process.stderr.on("data", chunk => {
        active.stderr = appendSshStderr(active.stderr, chunk);
      });
      process.stdout.on("data", chunk => {
        if (!active.finished && this.socket === transport) this.onData(chunk);
      });
      // Adding a data listener normally resumes a Readable. Keep an adopted
      // probe paused until the reconnect continuation has cleared route-switch
      // suppression in main.ts, then replay its unconsumed bootstrap bytes.
      if (probed) {
        process.stdout.pause();
        process.stderr.resume();
      }
      const activate = () => {
        if (active.finished) return;
        if (this.sshAlias !== alias || this.intentionalDisconnect) {
          active.intentionalClose = true;
          finish("SSH route was superseded");
          try { process.kill(); } catch { /* already gone */ }
          return;
        }
        active.connected = true;
        this._connected = true;
        this.handler(this.connectedRouteStatus(false, true));
        this.writeCommand({ type: "client_capabilities", capabilities: ["targeted-unwind", "sidebar-reorder-delta", "sidebar-state-patch"] });
        const replayedCommands = this.flushPendingCommands();
        resolve({ replayedCommands, ...(probed ? { bootstrapAlreadyRequested: true } : {}) });
      };
      if (probed) {
        activate();
        queueMicrotask(() => {
          if (active.finished || this.socket !== transport) return;
          if (probed.bufferedStdout) this.onData(probed.bufferedStdout);
          process.stdout.resume();
        });
      } else {
        process.once("spawn", activate);
      }
      process.once("error", error => finish(error.message));
      process.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        const result = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
        finish(`SSH proxy closed (${result})`);
      });
      process.stdin.once("error", error => finish(`SSH stdin error: ${error.message}`));
    });
  }

  onConnectionLost(handler: (shutdownMode: DaemonShutdownMode | null) => void): void {
    this.onDisconnect = handler;
  }

  private handleSocketClose(socket: ClientTransport, connected: boolean): void {
    const wasCurrentSocket = this.socket === socket;
    const shutdownMode = wasCurrentSocket ? this.announcedShutdownMode : null;
    if (wasCurrentSocket) {
      this._connected = false;
      this.socket = null;
      if (this.activeSshConnection?.transport === socket) this.activeSshConnection = null;
      this.buffer = "";
      this.announcedShutdownMode = null;
    }
    if (connected && wasCurrentSocket && !this.intentionalDisconnect) this.onDisconnect?.(shutdownMode);
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.abortPendingSshSwitch("TUI disconnected");
    this.discardPendingSshConnection();
    if (this.activeSshConnection) this.activeSshConnection.intentionalClose = true;
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
    this.activeSshConnection = null;
    this._connected = false;
    this.buffer = "";
    this.announcedShutdownMode = null;
  }

  send(command: Command): void {
    const sequence = ++this.nextCommandSequence;
    this.commandSequences.set(command, sequence);
    const queueCommandKey = replayableQueueCommandKey(command);
    if (queueCommandKey) {
      this.unresolvedQueueCommands.set(queueCommandKey, { command: command as ReplayableQueueCommand, sequence });
    }
    if (command.type === "unwind_conversation" && command.reqId) {
      this.unresolvedUnwindCommands.set(command.reqId, { command, sequence });
    }
    if (isBtwMutation(command)) this.btwMutationReplay.record(command, sequence);
    if (!this.socket || !this._connected) {
      this.pendingCommands.push(command);
      return;
    }
    this.writeCommand(command);
  }

  // ── Convenience methods ─────────────────────────────────────────

  createConversation(
    provider?: ProviderId,
    model?: import("./protocol").ModelId,
    title?: string,
    effort?: EffortLevel,
    fastMode?: boolean,
    initialMessage?: { text: string; startedAt: number; images?: ImageAttachment[] },
    folderId?: string | null,
    goalObjective?: string,
    convId?: string,
    goalPausable?: boolean,
    goalCompletable?: boolean,
    titleContext?: string,
    startCall?: boolean,
    draftToolPolicyId?: string,
  ): void {
    this.send({
      type: "new_conversation",
      ...(convId ? { convId } : {}),
      ...(draftToolPolicyId ? { draftToolPolicyId } : {}),
      provider, model, title, titleContext, effort, fastMode, initialMessage, folderId,
      goalObjective, goalPausable, goalCompletable, startCall,
    });
  }

  createConversationForCall(
    provider: ProviderId,
    model: ModelId,
    effort: EffortLevel,
    fastMode: boolean,
    folderId?: string | null,
    voice?: RealtimeVoice,
    convId?: string,
    draftToolPolicyId?: string,
  ): void {
    this.send({
      type: "new_conversation",
      ...(convId ? { convId } : {}),
      provider,
      model,
      effort,
      fastMode,
      folderId,
      startCall: true,
      ...(voice ? { callVoice: voice } : {}),
      ...(draftToolPolicyId ? { draftToolPolicyId } : {}),
    });
  }

  subscribe(convId: string): void {
    this.send({ type: "subscribe", convId });
  }

  unsubscribe(convId: string): void {
    this.send({ type: "unsubscribe", convId });
  }

  sendMessage(convId: string, text: string, startedAt: number, images?: ImageAttachment[]): void {
    this.send({ type: "send_message", convId, text, startedAt, images: images?.length ? images : undefined });
  }

  replayConversation(convId: string, startedAt: number): void {
    this.send({ type: "replay_conversation", convId, startedAt });
  }

  compactConversation(convId: string, startedAt: number): void {
    this.send({ type: "compact_conversation", convId, startedAt });
  }

  startBtw(convId: string, sessionId: string, query: string, startedAt: number): void {
    this.send({ type: "btw_query", convId, sessionId, query, startedAt });
  }

  followupBtw(convId: string, sessionId: string, turnId: string, query: string, startedAt: number): void {
    this.send({ type: "btw_followup", convId, sessionId, turnId, query, startedAt });
  }

  closeBtw(convId: string, sessionId?: string): void {
    this.send({ type: "btw_close", convId, sessionId });
  }

  ping(): void {
    this.send({ type: "ping" });
  }

  /**
   * Ephemeral filesystem lookup for prompt completion. Unlike user mutations,
   * this must never be queued across a route switch: a request intended for an
   * SSH daemon must not be replayed later against the local host.
   */
  requestPathDirectory(directory: string, prefix: string): string | null {
    if (!this.socket || !this._connected) return null;
    const reqId = `path_${++this.nextReqId}_${Date.now()}`;
    this.writeCommand({ type: "list_path_directory", reqId, directory, prefix });
    return reqId;
  }

  ssh(action: "connect" | "status" | "cancel", alias?: string): void {
    switch (action) {
      case "status":
        this.handler(this.connectedRouteStatus(false));
        return;
      case "cancel":
        this.cancelSshRouteSwitch();
        return;
      case "connect":
        void this.switchToSshAlias(alias ?? "");
        return;
    }
  }

  private connectedRouteStatus(switched: boolean, silent = false): Extract<Event, { type: "ssh_status" }> {
    if (this.sshAlias) {
      return {
        type: "ssh_status",
        mode: "remote",
        state: "connected",
        alias: this.sshAlias,
        switched,
        ...(silent ? { silent: true } : {}),
        message: `Connected daemon: SSH alias ${this.sshAlias} (remote Exocortex daemon).`,
      };
    }
    return {
      type: "ssh_status",
      mode: "local",
      state: "connected",
      switched,
      ...(silent ? { silent: true } : {}),
      message: `Connected daemon: local ${this.localHostname} (socket ${this.socketPath}).`,
    };
  }

  private currentRouteStatus(
    state: "switching" | "failed",
    message: string,
  ): Extract<Event, { type: "ssh_status" }> {
    return {
      type: "ssh_status",
      mode: this.sshAlias ? "remote" : "local",
      state,
      ...(this.sshAlias ? { alias: this.sshAlias } : {}),
      switched: false,
      message,
    };
  }

  private async switchToSshAlias(alias: string): Promise<void> {
    const validationError = validateSshAlias(alias);
    if (validationError) {
      this.handler(this.currentRouteStatus("failed", validationError));
      return;
    }
    if (this.sshSwitchingTo) {
      this.handler(this.currentRouteStatus(
        "failed",
        `Already switching to SSH alias ${this.sshSwitchingTo}.`,
      ));
      return;
    }
    if (alias === this.sshAlias) {
      this.handler(this.connectedRouteStatus(false));
      return;
    }

    const generation = ++this.sshSwitchGeneration;
    this.sshSwitchingTo = alias;
    this.handler(this.currentRouteStatus(
      "switching",
      `Connecting to remote Exocortex daemon through SSH alias ${alias}…`,
    ));

    const probe = probeSshProxy(alias, {
      spawnProcess: this.spawnSshProcess,
      timeoutMs: this.sshProbeTimeoutMs,
    });
    this.cancelSshProbe = probe.cancel;
    try {
      const connection = await probe.promise;
      if (generation !== this.sshSwitchGeneration || this.sshSwitchingTo !== alias) {
        try { connection.process.kill(); } catch { /* already gone */ }
        return;
      }
      this.discardPendingSshConnection();
      this.pendingSshConnection = { ...connection, alias };
    } catch (error) {
      if (generation !== this.sshSwitchGeneration) return;
      this.cancelSshProbe = null;
      this.sshSwitchingTo = null;
      const message = `Could not connect through SSH alias ${alias}: ${error instanceof Error ? error.message : String(error)}`;
      log("warn", `ssh transport: ${message}`);
      this.handler(this.currentRouteStatus("failed", message));
      return;
    }

    if (generation !== this.sshSwitchGeneration || this.sshSwitchingTo !== alias) {
      this.discardPendingSshConnection();
      return;
    }
    this.cancelSshProbe = null;
    this.sshSwitchingTo = null;
    this.sshAlias = alias;
    log("info", `ssh transport: selected remote daemon via ${alias}`);
    this.handler(this.connectedRouteStatus(true));
    this.closeCurrentTransportForRouteSwitch();
  }

  private cancelSshRouteSwitch(): void {
    if (this.sshSwitchingTo) {
      const pending = this.sshSwitchingTo;
      this.abortPendingSshSwitch(`SSH switch to ${pending} cancelled.`);
      const status = this.connectedRouteStatus(false);
      this.handler({
        ...status,
        message: `SSH switch to ${pending} cancelled. ${status.message}`,
      });
      return;
    }
    if (!this.sshAlias) {
      this.handler(this.connectedRouteStatus(false));
      return;
    }

    const previous = this.sshAlias;
    this.sshAlias = null;
    this.discardPendingSshConnection();
    log("info", `ssh transport: cancelled remote route ${previous}; using local daemon`);
    this.handler({
      ...this.connectedRouteStatus(true),
      message: `SSH connection to ${previous} cancelled. ${this.connectedRouteStatus(false).message}`,
    });
    this.closeCurrentTransportForRouteSwitch();
  }

  private abortPendingSshSwitch(reason: string): void {
    if (!this.sshSwitchingTo && !this.cancelSshProbe) return;
    this.sshSwitchGeneration += 1;
    this.sshSwitchingTo = null;
    const cancel = this.cancelSshProbe;
    this.cancelSshProbe = null;
    cancel?.(reason);
  }

  private discardPendingSshConnection(): void {
    const pending = this.pendingSshConnection;
    this.pendingSshConnection = null;
    if (!pending) return;
    try { pending.process.kill(); } catch { /* already gone */ }
  }

  private closeCurrentTransportForRouteSwitch(): void {
    if (this.activeSshConnection) this.activeSshConnection.intentionalClose = true;
    try { this.socket?.end(); } catch { /* already closed */ }
    try { this.socket?.destroy(); } catch { /* already closed */ }
  }

  abort(convId: string, expectedStartedAt?: number): void {
    this.send({ type: "abort", convId, expectedStartedAt });
  }

  backgroundTool(convId: string): void {
    this.send({ type: "background_tool", convId });
  }

  /**
   * Request an at-most-once restart from the daemon behind this exact socket.
   * Never queue this across a disconnect: replaying it into the replacement
   * daemon would create a restart loop.
   */
  restartDaemon(): boolean {
    if (!this.socket || !this._connected) return false;
    this.writeCommand({ type: "restart_daemon" });
    return true;
  }

  startCall(convId: string, voice?: RealtimeVoice): void {
    this.send({ type: "start_call", convId, ...(voice ? { voice } : {}) });
  }

  attachCallMedia(convId: string, callId: string, offerSdp: string, reqId?: string): void {
    this.send({ type: "attach_call_media", convId, callId, offerSdp, reqId });
  }

  stopCall(convId: string, callId?: string): void {
    this.send({ type: "stop_call", convId, callId });
  }

  prewarmConversation(convId: string): void {
    this.send({ type: "prewarm_conversation", convId });
  }

  setModel(convId: string, provider: ProviderId, model: ModelId): void {
    this.send({ type: "set_model", convId, provider, model });
  }

  setEffort(convId: string, effort: EffortLevel): void {
    this.send({ type: "set_effort", convId, effort });
  }

  setFastMode(convId: string, enabled: boolean): void {
    this.send({ type: "set_fast_mode", convId, enabled });
  }

  setGoal(convId: string, action: GoalAction, objective?: string, pausable?: boolean, completable?: boolean): void {
    this.send({ type: "set_goal", convId, action, objective, pausable, completable });
  }

  trimConversation(convId: string, mode: TrimMode, count: number): void {
    this.send({ type: "trim_conversation", convId, mode, count });
  }

  deleteConversation(convId: string): void {
    this.send({ type: "delete_conversation", convId });
  }

  deleteConversations(convIds: string[]): void {
    this.send({ type: "delete_conversations", convIds });
  }

  undoDelete(): void {
    this.send({ type: "undo_delete" });
  }

  redoDelete(): void {
    this.send({ type: "redo_delete" });
  }

  markConversation(convId: string, marked: boolean): void {
    this.send({ type: "mark_conversation", convId, marked });
  }

  pinConversation(convId: string, pinned: boolean): void {
    this.send({ type: "pin_conversation", convId, pinned });
  }

  muteConversation(convId: string, muted: boolean): void {
    this.send({ type: "mute_conversation", convId, muted });
  }

  moveConversation(convId: string, direction: "up" | "down"): void {
    this.send({ type: "move_conversation", convId, direction });
  }

  cloneConversation(convId: string): void {
    this.send({ type: "clone_conversation", convId });
  }

  renameConversation(convId: string, title: string): void {
    this.send({ type: "rename_conversation", convId, title });
  }

  createFolder(name: string, parentId: string | null, items: SidebarItemRef[]): void {
    this.send({ type: "create_folder", name, parentId, items });
  }

  renameFolder(folderId: string, name: string): void {
    this.send({ type: "rename_folder", folderId, name });
  }

  pinFolder(folderId: string, pinned: boolean): void {
    this.send({ type: "pin_folder", folderId, pinned });
  }

  muteFolder(folderId: string, muted: boolean): void {
    this.send({ type: "mute_folder", folderId, muted });
  }

  pinSidebarItems(pins: { item: SidebarItemRef; pinned: boolean }[]): void {
    this.send({ type: "pin_sidebar_items", pins });
  }

  moveSidebarItem(item: SidebarItemRef, direction: "up" | "down"): void {
    this.send({ type: "move_sidebar_item", item, direction });
  }

  moveSidebarItems(items: SidebarItemRef[], parentId: string | null, before?: SidebarItemRef, options: MoveSidebarItemsOptions = {}): void {
    this.send({ type: "move_sidebar_items", items, parentId, before, preservePinned: options.preservePinned, placement: options.placement });
  }

  deleteFolder(folderId: string, mode: "recursive" | "unwrap" = "recursive"): void {
    this.send({ type: "delete_folder", folderId, mode });
  }

  loadFolderInstructions(folderId: string): void {
    this.send({ type: "load_folder_instructions", folderId });
  }

  setFolderInstructions(folderId: string, text: string): void {
    this.send({ type: "set_folder_instructions", folderId, text });
  }

  generateTitle(convId: string): void {
    this.send({ type: "generate_title", convId });
  }

  queueMessage(
    convId: string,
    text: string,
    timing: QueueTiming,
    images?: ImageAttachment[],
    options: {
      queueId?: string;
      command?: QueuedCommandInvocation;
      source?: "daemon" | "global-idle";
      target?: "conversation" | "new-conversation";
      provider?: ProviderId;
      model?: ModelId;
      effort?: EffortLevel;
      fastMode?: boolean;
      folderId?: string | null;
      waitTarget?: QueueWaitTarget;
      draftToolPolicyId?: string;
    } = {},
  ): void {
    this.send({ type: "queue_message", convId, text, timing, ...(images?.length ? { images } : {}), ...options });
  }

  unqueueMessage(queueId: string): void {
    this.send({ type: "unqueue_message", queueId });
  }

  updateQueuedMessage(queueId: string, text: string, timing: QueueTiming, images?: ImageAttachment[]): void {
    this.send({ type: "update_queued_message", queueId, text, timing, ...(images?.length ? { images } : {}) });
  }

  moveQueuedMessage(queueId: string, direction: "up" | "down"): void {
    this.send({ type: "move_queued_message", queueId, direction });
  }

  unwindConversation(convId: string, userMessageIndex: number, expectedStartedAt?: number, targetFingerprint?: string): string {
    const reqId = `unwind_${++this.nextReqId}_${Date.now()}`;
    this.send({
      type: "unwind_conversation",
      reqId,
      operationId: randomUUID(),
      convId,
      userMessageIndex,
      expectedStartedAt,
      targetFingerprint,
    });
    return reqId;
  }

  setSystemInstructions(convId: string, text: string): void {
    this.send({ type: "set_system_instructions", convId, text });
  }

  listConversations(): void {
    this.send({ type: "list_conversations" });
  }

  loadConversation(convId: string): string {
    const requestedAt = Date.now();
    const reqId = `conversation_${++this.nextReqId}_${requestedAt}`;
    if (this.performanceProfilingEnabled) {
      this.pendingConversationLoads.set(reqId, { convId, startedAt: performance.now() });
      log("info", `perf: conversation_open tui_request ${JSON.stringify({ reqId, convId, requestedAt, connected: this._connected })}`);
    }
    this.send({
      type: "load_conversation",
      reqId,
      convId,
      turns: 5,
      ...(this.performanceProfilingEnabled ? { requestedAt } : {}),
    });
    if (this.performanceProfilingEnabled) {
      const waitTimer = setTimeout(() => {
        const pendingLoad = this.pendingConversationLoads.get(reqId);
        if (!pendingLoad) return;
        log("warn", `perf: conversation_open tui_waiting ${JSON.stringify({
          reqId,
          convId,
          elapsedMs: performance.now() - pendingLoad.startedAt,
          connected: this._connected,
        })}`);
      }, 1_000);
      waitTimer.unref?.();
    }
    return reqId;
  }

  loadConversationHistory(
    convId: string,
    beforeEntryIndex: number,
    turns: number,
    requestSource: "initial-backfill" | "viewport" = "viewport",
  ): string {
    const reqId = `history_${++this.nextReqId}_${Date.now()}`;
    if (this.performanceProfilingEnabled) {
      this.pendingConversationHistoryLoads.set(reqId, { convId, requestSource, startedAt: performance.now() });
      log("info", `perf: conversation_history tui_request ${JSON.stringify({ reqId, convId, requestSource, beforeEntryIndex, turns, connected: this._connected })}`);
    }
    this.send({
      type: "load_conversation_history",
      reqId,
      convId,
      beforeEntryIndex,
      turns,
      requestSource,
    });
    return reqId;
  }

  loadToolOutputs(convId: string, toolCallIds?: string[]): string {
    const reqId = `tool_outputs_${++this.nextReqId}_${Date.now()}`;
    if (this.performanceProfilingEnabled) {
      this.pendingToolOutputLoads.set(reqId, {
        convId,
        requested: toolCallIds?.length ?? null,
        startedAt: performance.now(),
      });
    }
    this.send({ type: "load_tool_outputs", reqId, convId, toolCallIds });
    return reqId;
  }

  login(provider?: ProviderId, apiKey?: string, action?: "add" | "remove", target?: string, method?: OpenAILoginMethod): void {
    this.send({ type: "login", provider, apiKey, action, target, method });
  }

  account(provider?: ProviderId, target?: string): void {
    this.send({ type: "account", provider, target });
  }

  consumeUsageReset(provider: ProviderId = "openai"): void {
    this.send({ type: "consume_usage_reset", provider });
  }

  logout(provider?: ProviderId): void {
    this.send({ type: "logout", provider });
  }

  getSystemPrompt(convId?: string): void {
    this.send({ type: "get_system_prompt", convId });
  }

  getToolPolicy(convId: string): void {
    this.send({ type: "get_tool_policy", reqId: this.requestId("tools"), convId });
  }

  setToolPolicy(convId: string, mutation: ToolPolicyMutation): void {
    this.send({ type: "set_tool_policy", reqId: this.requestId("tools"), convId, mutation });
  }

  getDraftToolPolicy(draftId: string): void {
    this.send({ type: "get_draft_tool_policy", reqId: this.requestId("tools"), draftId });
  }

  setDraftToolPolicy(draftId: string, mutation: ToolPolicyMutation): void {
    this.send({ type: "set_draft_tool_policy", reqId: this.requestId("tools"), draftId, mutation });
  }

  clearDraftToolPolicy(draftId: string): void {
    this.send({ type: "clear_draft_tool_policy", draftId });
  }

  llmComplete(
    system: string, userText: string,
    onSuccess: LlmCompleteCallback, onError?: LlmErrorCallback,
    provider?: ProviderId, model?: ModelId, maxTokens?: number,
    trackingSource?: TokenUsageSource,
  ): void {
    const reqId = `llm_${++this.nextReqId}_${Date.now()}`;
    this.llmCallbacks.set(reqId, { onSuccess, onError });
    this.send({ type: "llm_complete", reqId, system, userText, provider, model, maxTokens, trackingSource });
  }

  transcribeAudio(
    audioBase64: string,
    mimeType: string,
    onSuccess: TranscriptionCallback,
    onError?: TranscriptionErrorCallback,
  ): void {
    const reqId = `transcribe_${++this.nextReqId}_${Date.now()}`;
    this.transcriptionCallbacks.set(reqId, { onSuccess, onError });
    this.send({ type: "transcribe_audio", reqId, audioBase64, mimeType });
  }

  // ── Internal ────────────────────────────────────────────────────

  private requestId(prefix: string): string {
    return `${prefix}_${++this.nextReqId}_${Date.now()}`;
  }

  private socketMissingError(): Error {
    return new Error(
      "exocortexd socket not found. Is the daemon running?\n" +
      "Start it with: exocortexd restart"
    );
  }

  private writeCommand(command: Command): void {
    this.socket?.write(JSON.stringify(command) + "\n");
  }

  private flushPendingCommands(): Command[] {
    if (!this.socket || !this._connected) return [];
    const pending = this.pendingCommands;
    this.pendingCommands = [];

    // Queue mutations in the offline list may be stale duplicates of the latest
    // unresolved command for that key. Merge the canonical unresolved mutations
    // with ordinary offline work by original issuance order. This preserves
    // causality such as queue → unwind → unqueue across a disconnect.
    const ordinary = pending
      .filter(command => replayableQueueCommandKey(command) === null
        && (command.type !== "unwind_conversation" || !command.reqId)
        && !isBtwMutation(command))
      .map(command => ({ command, sequence: this.commandSequences.get(command) ?? ++this.nextCommandSequence }));
    const replayed = [
      ...ordinary,
      ...this.unresolvedQueueCommands.values(),
      ...this.unresolvedUnwindCommands.values(),
      ...this.btwMutationReplay.values(),
    ]
      .sort((a, b) => a.sequence - b.sequence)
      .map(entry => entry.command);
    for (const command of replayed) this.writeCommand(command);
    return replayed;
  }

  private settleQueueCommands(event: Event): void {
    if (event.type !== "queue_updated") return;
    const canonicalIds = new Set(event.messages.map(message => message.id));
    const settledIds = new Set(event.settledQueueIds ?? []);
    for (const [key, pending] of this.unresolvedQueueCommands) {
      const { command } = pending;
      const queueId = command.queueId;
      if (!queueId) continue;
      if (command.type === "queue_message") {
        if (canonicalIds.has(queueId) || settledIds.has(queueId)) this.unresolvedQueueCommands.delete(key);
      } else if (settledIds.has(queueId) && !canonicalIds.has(queueId)) {
        // An idempotent enqueue response can settle the same id while the entry
        // remains canonical. Only absence plus the targeted settlement proves
        // that an unqueue was applied.
        this.unresolvedQueueCommands.delete(key);
      }
    }
  }

  private settleUnwindCommand(event: Event): void {
    if (!(event.type === "conversation_unwound"
        || event.type === "conversation_loaded"
        || event.type === "error")
        || !event.reqId) return;
    this.unresolvedUnwindCommands.delete(event.reqId);
  }

  private onData(data: Buffer | string): void {
    // The existing prefix was completely scanned on the preceding callback.
    // Resume at its old end instead of rescanning a growing multi-megabyte JSON
    // event on every socket chunk (quadratic work for large payloads).
    let newlineSearchFrom = this.buffer.length;
    this.buffer += typeof data === "string" ? data : data.toString("utf-8");

    let idx: number;
    while ((idx = this.buffer.indexOf("\n", newlineSearchFrom)) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      newlineSearchFrom = 0;
      if (!line) continue;
      try {
        const parseStartedAt = this.performanceProfilingEnabled ? performance.now() : 0;
        const event = JSON.parse(line) as Event;
        if (event.type === "daemon_shutdown") {
          // This is transport metadata rather than a user-facing event. Retain it
          // until close so the reconnecting TUI can distinguish a planned daemon
          // restart from every other connection loss.
          this.announcedShutdownMode = event.mode;
          continue;
        }
        const parseMs = this.performanceProfilingEnabled ? performance.now() - parseStartedAt : 0;
        if (this.performanceProfilingEnabled && (event.type === "conversation_loaded" || event.type === "error") && event.reqId) {
          const pendingLoad = this.pendingConversationLoads.get(event.reqId);
          if (pendingLoad) {
            this.pendingConversationLoads.delete(event.reqId);
            const elapsedMs = performance.now() - pendingLoad.startedAt;
            log(elapsedMs >= 250 ? "warn" : "info", `perf: conversation_open tui_received ${JSON.stringify({
              reqId: event.reqId,
              convId: pendingLoad.convId,
              elapsedMs,
              responseType: event.type,
              wireBytes: Buffer.byteLength(line),
              parseMs,
              entries: event.type === "conversation_loaded" ? event.entries.length : null,
              historyTotalEntries: event.type === "conversation_loaded" ? event.historyTotalEntries ?? null : null,
            })}`);
          }
        }
        if (this.performanceProfilingEnabled && (event.type === "conversation_history_loaded" || event.type === "error") && event.reqId) {
          const pendingLoad = this.pendingConversationHistoryLoads.get(event.reqId);
          if (pendingLoad) {
            this.pendingConversationHistoryLoads.delete(event.reqId);
            const elapsedMs = performance.now() - pendingLoad.startedAt;
            log(elapsedMs >= 250 ? "warn" : "info", `perf: conversation_history tui_received ${JSON.stringify({
              reqId: event.reqId,
              convId: pendingLoad.convId,
              requestSource: pendingLoad.requestSource,
              elapsedMs,
              responseType: event.type,
              wireBytes: Buffer.byteLength(line),
              parseMs,
              entries: event.type === "conversation_history_loaded" ? event.entries.length : null,
              historyTotalEntries: event.type === "conversation_history_loaded" ? event.historyTotalEntries : null,
            })}`);
          }
        }
        if (this.performanceProfilingEnabled && (event.type === "tool_outputs_loaded" || event.type === "error") && event.reqId) {
          const pendingLoad = this.pendingToolOutputLoads.get(event.reqId);
          if (pendingLoad) {
            this.pendingToolOutputLoads.delete(event.reqId);
            const elapsedMs = performance.now() - pendingLoad.startedAt;
            log(elapsedMs >= 100 ? "warn" : "info", `perf: tool_outputs tui_received ${JSON.stringify({
              reqId: event.reqId,
              convId: pendingLoad.convId,
              requested: pendingLoad.requested,
              returned: event.type === "tool_outputs_loaded" ? event.outputs.length : null,
              elapsedMs,
              responseType: event.type,
              wireBytes: Buffer.byteLength(line),
              parseMs,
            })}`);
          }
        }
        this.settleQueueCommands(event);
        this.settleUnwindCommand(event);
        this.btwMutationReplay.settle(event);
        let handledByCallback = false;

        // Intercept request-scoped responses so they do not also surface as
        // generic global events.
        if (event.type === "llm_complete_result" && event.reqId) {
          const cbs = this.llmCallbacks.get(event.reqId);
          if (cbs) {
            this.llmCallbacks.delete(event.reqId);
            cbs.onSuccess(event.text);
            handledByCallback = true;
          }
        } else if (event.type === "transcription_result" && event.reqId) {
          const cbs = this.transcriptionCallbacks.get(event.reqId);
          if (cbs) {
            this.transcriptionCallbacks.delete(event.reqId);
            cbs.onSuccess(event.text);
            handledByCallback = true;
          }
        } else if (event.type === "error" && event.reqId) {
          const llmCbs = this.llmCallbacks.get(event.reqId);
          if (llmCbs) {
            this.llmCallbacks.delete(event.reqId);
            llmCbs.onError?.(event.message);
            handledByCallback = true;
          }
          const transcriptionCbs = this.transcriptionCallbacks.get(event.reqId);
          if (transcriptionCbs) {
            this.transcriptionCallbacks.delete(event.reqId);
            transcriptionCbs.onError?.(event.message);
            handledByCallback = true;
          }
        }

        if (!handledByCallback) {
          this.handler(event);
        }
      } catch (err) {
        // TUI owns stdout for rendering — stderr is safe for diagnostics.
        console.error("[daemon event error]", err);
      }
    }
  }
}
