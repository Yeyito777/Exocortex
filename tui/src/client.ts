/**
 * Unix socket client for connecting to exocortexd.
 *
 * JSON-lines protocol over a Unix domain socket.
 */

import { connect, type Socket } from "net";
import { existsSync } from "fs";
import type { Command, Event, GoalAction, MoveSidebarItemsOptions, OpenAILoginMethod, QueueTiming, QueueWaitTarget, TrimMode, SidebarItemRef } from "./protocol";
import type { ProviderId, ModelId, EffortLevel, ImageAttachment, TokenUsageSource } from "./messages";
import { socketPath, isWindows } from "@exocortex/shared/paths";

export type EventHandler = (event: Event) => void;
export type LlmCompleteCallback = (text: string) => void;
export type LlmErrorCallback = (message: string) => void;
export type TranscriptionCallback = (text: string) => void;
export type TranscriptionErrorCallback = (message: string) => void;

export interface ConnectResult {
  /** Commands that entered the offline queue before this socket became ready. */
  replayedCommands: Command[];
}

type ReplayableQueueCommand = Extract<Command, { type: "queue_message" | "unqueue_message" }>;

function replayableQueueCommandKey(command: Command): string | null {
  if (command.type === "queue_message" && command.queueId) return `enqueue:${command.queueId}`;
  if (command.type === "unqueue_message" && command.queueId) return `unqueue:${command.queueId}`;
  return null;
}

export class DaemonClient {
  private socket: Socket | null = null;
  private buffer = "";
  private handler: EventHandler;
  private _connected = false;
  private socketPath: string;
  private onDisconnect: (() => void) | null = null;
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
  /** Original issuance order shared by connected-unresolved and offline commands. */
  private commandSequences = new WeakMap<Command, number>();
  private nextCommandSequence = 0;
  private llmCallbacks = new Map<string, { onSuccess: LlmCompleteCallback; onError?: LlmErrorCallback }>();
  private transcriptionCallbacks = new Map<string, { onSuccess: TranscriptionCallback; onError?: TranscriptionErrorCallback }>();
  private nextReqId = 0;

  constructor(handler: EventHandler, overrideSocketPath?: string) {
    this.handler = handler;
    this.socketPath = overrideSocketPath ?? socketPath();
  }

  get connected(): boolean { return this._connected; }

  async connect(): Promise<ConnectResult> {
    return new Promise((resolve, reject) => {
      // Named pipes on Windows don't exist as files — skip the filesystem check
      if (!isWindows && !existsSync(this.socketPath)) {
        reject(this.socketMissingError());
        return;
      }

      this.intentionalDisconnect = false;
      this.buffer = "";

      const socket = connect(this.socketPath);
      let resolved = false;

      socket.on("connect", () => {
        this.socket = socket;
        this._connected = true;
        resolved = true;
        // Report the queue state atomically with the flush. Input can enqueue a
        // command while the socket attempt is still in flight, so a pre-connect
        // queue snapshot would already be stale here.
        const replayedCommands = this.flushPendingCommands();
        resolve({ replayedCommands });
      });
      socket.on("data", (data) => this.onData(data));
      socket.on("close", () => {
        const wasCurrentSocket = this.socket === socket;
        if (wasCurrentSocket) {
          this._connected = false;
          this.socket = null;
          this.buffer = "";
        }
        if (resolved && wasCurrentSocket && !this.intentionalDisconnect) this.onDisconnect?.();
      });
      socket.on("error", (err) => {
        this._connected = false;
        if (!resolved) {
          const code = (err as NodeJS.ErrnoException).code;
          if (isWindows && (code === "ENOENT" || code === "ECONNREFUSED")) {
            reject(this.socketMissingError());
          } else {
            reject(new Error(`Failed to connect: ${err.message}`));
          }
        }
      });
    });
  }

  onConnectionLost(handler: () => void): void {
    this.onDisconnect = handler;
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
    this._connected = false;
    this.buffer = "";
  }

  send(command: Command): void {
    const sequence = ++this.nextCommandSequence;
    this.commandSequences.set(command, sequence);
    const queueCommandKey = replayableQueueCommandKey(command);
    if (queueCommandKey) {
      this.unresolvedQueueCommands.set(queueCommandKey, { command: command as ReplayableQueueCommand, sequence });
    }
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
  ): void {
    this.send({ type: "new_conversation", ...(convId ? { convId } : {}), provider, model, title, titleContext, effort, fastMode, initialMessage, folderId, goalObjective, goalPausable, goalCompletable });
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

  ping(): void {
    this.send({ type: "ping" });
  }

  abort(convId: string): void {
    this.send({ type: "abort", convId });
  }

  backgroundTool(convId: string): void {
    this.send({ type: "background_tool", convId });
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
      source?: "daemon" | "global-idle";
      target?: "conversation" | "new-conversation";
      provider?: ProviderId;
      model?: ModelId;
      effort?: EffortLevel;
      fastMode?: boolean;
      folderId?: string | null;
      waitTarget?: QueueWaitTarget;
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

  unwindConversation(convId: string, userMessageIndex: number): void {
    this.send({ type: "unwind_conversation", convId, userMessageIndex });
  }

  setSystemInstructions(convId: string, text: string): void {
    this.send({ type: "set_system_instructions", convId, text });
  }

  listConversations(): void {
    this.send({ type: "list_conversations" });
  }

  loadConversation(convId: string): void {
    this.send({ type: "load_conversation", convId, turns: 5 });
  }

  loadConversationHistory(convId: string, beforeEntryIndex: number, turns: number): string {
    const reqId = `history_${++this.nextReqId}_${Date.now()}`;
    this.send({ type: "load_conversation_history", reqId, convId, beforeEntryIndex, turns });
    return reqId;
  }

  loadToolOutputs(convId: string): void {
    this.send({ type: "load_tool_outputs", convId });
  }

  login(provider?: ProviderId, apiKey?: string, action?: "add" | "remove", target?: string, method?: OpenAILoginMethod): void {
    this.send({ type: "login", provider, apiKey, action, target, method });
  }

  account(provider?: ProviderId, target?: string): void {
    this.send({ type: "account", provider, target });
  }

  logout(provider?: ProviderId): void {
    this.send({ type: "logout", provider });
  }

  getSystemPrompt(convId?: string): void {
    this.send({ type: "get_system_prompt", convId });
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
      .filter(command => replayableQueueCommandKey(command) === null)
      .map(command => ({ command, sequence: this.commandSequences.get(command) ?? ++this.nextCommandSequence }));
    const replayed = [...ordinary, ...this.unresolvedQueueCommands.values()]
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

  private onData(data: Buffer | string): void {
    this.buffer += typeof data === "string" ? data : data.toString("utf-8");

    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as Event;
        this.settleQueueCommands(event);
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
