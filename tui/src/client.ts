/**
 * Unix socket client for connecting to exocortexd.
 *
 * JSON-lines protocol over a Unix domain socket.
 */

import { connect, type Socket } from "net";
import { existsSync } from "fs";
import type { Command, Event, QueueTiming } from "./protocol";
import type { ProviderId, ModelId, EffortLevel, ImageAttachment } from "./messages";
import { socketPath, isWindows } from "@exocortex/shared/paths";

export type EventHandler = (event: Event) => void;
export type LlmCompleteCallback = (text: string) => void;
export type LlmErrorCallback = (message: string) => void;

export class DaemonClient {
  private socket: Socket | null = null;
  private buffer = "";
  private handler: EventHandler;
  private _connected = false;
  private socketPath: string;
  private onDisconnect: (() => void) | null = null;
  private llmCallbacks = new Map<string, { onSuccess: LlmCompleteCallback; onError?: LlmErrorCallback }>();
  private nextReqId = 0;

  constructor(handler: EventHandler, overrideSocketPath?: string) {
    this.handler = handler;
    this.socketPath = overrideSocketPath ?? socketPath();
  }

  get connected(): boolean { return this._connected; }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Named pipes on Windows don't exist as files — skip the filesystem check
      if (!isWindows && !existsSync(this.socketPath)) {
        reject(new Error(
          "exocortexd socket not found. Is the daemon running?\n" +
          "Start it with: cd daemon && bun run start"
        ));
        return;
      }

      const socket = connect(this.socketPath);
      let resolved = false;

      socket.on("connect", () => {
        this.socket = socket;
        this._connected = true;
        resolved = true;
        resolve();
      });
      socket.on("data", (data) => this.onData(data));
      socket.on("close", () => {
        this._connected = false;
        this.socket = null;
        this.onDisconnect?.();
      });
      socket.on("error", (err) => {
        this._connected = false;
        if (!resolved) {
          const code = (err as NodeJS.ErrnoException).code;
          if (isWindows && (code === "ENOENT" || code === "ECONNREFUSED")) {
            reject(new Error(
              "exocortexd socket not found. Is the daemon running?\n" +
              "Start it with: cd daemon && bun run start"
            ));
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
    this.socket?.end();
    this.socket = null;
    this._connected = false;
  }

  send(command: Command): void {
    if (!this.socket || !this._connected) throw new Error("Not connected");
    this.socket.write(JSON.stringify(command) + "\n");
  }

  // ── Convenience methods ─────────────────────────────────────────

  createConversation(provider?: ProviderId, model?: import("./protocol").ModelId, title?: string, effort?: EffortLevel): void {
    this.send({ type: "new_conversation", provider, model, title, effort });
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

  ping(): void {
    this.send({ type: "ping" });
  }

  abort(convId: string): void {
    this.send({ type: "abort", convId });
  }

  setModel(convId: string, model: ModelId): void {
    this.send({ type: "set_model", convId, model });
  }

  setEffort(convId: string, effort: EffortLevel): void {
    this.send({ type: "set_effort", convId, effort });
  }

  deleteConversation(convId: string): void {
    this.send({ type: "delete_conversation", convId });
  }

  undoDelete(): void {
    this.send({ type: "undo_delete" });
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

  queueMessage(convId: string, text: string, timing: QueueTiming, images?: ImageAttachment[]): void {
    this.send({ type: "queue_message", convId, text, timing, ...(images?.length ? { images } : {}) });
  }

  unqueueMessage(convId: string, text: string): void {
    this.send({ type: "unqueue_message", convId, text });
  }

  unwindConversation(convId: string, userMessageIndex: number): void {
    this.send({ type: "unwind_conversation", convId, userMessageIndex });
  }

  listConversations(): void {
    this.send({ type: "list_conversations" });
  }

  loadConversation(convId: string): void {
    this.send({ type: "load_conversation", convId });
  }

  login(provider?: ProviderId): void {
    this.send({ type: "login", provider });
  }

  logout(provider?: ProviderId): void {
    this.send({ type: "logout", provider });
  }

  getSystemPrompt(): void {
    this.send({ type: "get_system_prompt" });
  }

  llmComplete(
    system: string, userText: string,
    onSuccess: LlmCompleteCallback, onError?: LlmErrorCallback,
    provider?: ProviderId, model?: ModelId, maxTokens?: number,
  ): void {
    const reqId = `llm_${++this.nextReqId}_${Date.now()}`;
    this.llmCallbacks.set(reqId, { onSuccess, onError });
    this.send({ type: "llm_complete", reqId, system, userText, provider, model, maxTokens });
  }

  // ── Internal ────────────────────────────────────────────────────

  private onData(data: Buffer | string): void {
    this.buffer += typeof data === "string" ? data : data.toString("utf-8");

    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as Event;
        // Intercept llm_complete responses — resolve the matching callback
        if (event.type === "llm_complete_result" && event.reqId) {
          const cbs = this.llmCallbacks.get(event.reqId);
          if (cbs) {
            this.llmCallbacks.delete(event.reqId);
            cbs.onSuccess(event.text);
          }
        } else if (event.type === "error" && event.reqId) {
          const cbs = this.llmCallbacks.get(event.reqId);
          if (cbs) {
            this.llmCallbacks.delete(event.reqId);
            cbs.onError?.(event.message);
          }
        }
        this.handler(event);
      } catch (err) {
        // TUI owns stdout for rendering — stderr is safe for diagnostics.
        console.error("[daemon event error]", err);
      }
    }
  }
}
