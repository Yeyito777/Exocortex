/**
 * Unix socket client for connecting to exocortexd.
 *
 * JSON-lines protocol over a Unix domain socket.
 */

import { connect, type Socket } from "net";
import { existsSync } from "fs";
import type { Command, Event } from "./protocol";
import type { ModelId } from "./messages";
import { socketPath } from "@exocortex/shared/paths";

export type EventHandler = (event: Event) => void;

export class DaemonClient {
  private socket: Socket | null = null;
  private buffer = "";
  private handler: EventHandler;
  private _connected = false;
  private socketPath: string;
  private onDisconnect: (() => void) | null = null;

  constructor(handler: EventHandler, overrideSocketPath?: string) {
    this.handler = handler;
    this.socketPath = overrideSocketPath ?? socketPath();
  }

  get connected(): boolean { return this._connected; }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!existsSync(this.socketPath)) {
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
        if (!resolved) reject(new Error(`Failed to connect: ${err.message}`));
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

  createConversation(model?: import("./protocol").ModelId): void {
    this.send({ type: "new_conversation", model });
  }

  subscribe(convId: string): void {
    this.send({ type: "subscribe", convId });
  }

  unsubscribe(convId: string): void {
    this.send({ type: "unsubscribe", convId });
  }

  sendMessage(convId: string, text: string, startedAt: number): void {
    this.send({ type: "send_message", convId, text, startedAt });
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

  listConversations(): void {
    this.send({ type: "list_conversations" });
  }

  loadConversation(convId: string): void {
    this.send({ type: "load_conversation", convId });
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
        this.handler(JSON.parse(line) as Event);
      } catch {
        // Malformed event or handler error — log to stderr for debugging.
        // Silent in production since the TUI owns stdout for rendering.
      }
    }
  }
}
