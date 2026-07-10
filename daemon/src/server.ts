/**
 * Unix domain socket server for exocortexd.
 *
 * Accepts client connections, parses JSON-lines commands,
 * routes them to handlers, and sends events back.
 */

import { createServer, type Server, type Socket } from "net";
import { existsSync, unlinkSync } from "fs";
import { isWindows } from "@exocortex/shared/paths";
import { log } from "./log";
import type { Command, Event } from "./protocol";

// ── Client tracking ─────────────────────────────────────────────────

let clientIdCounter = 0;

export interface ConnectedClient {
  id: string;
  socket: Socket;
  subscriptions: Set<string>;
  buffer: string;
  capabilities: Set<"history-pagination">;
}

export type CommandHandler = (client: ConnectedClient, command: Command) => void | Promise<void>;

// ── Server ──────────────────────────────────────────────────────────

export class DaemonServer {
  private server: Server | null = null;
  private clients = new Map<string, ConnectedClient>();
  private handler: CommandHandler;
  private socketPath: string;

  constructor(socketPath: string, handler: CommandHandler) {
    this.socketPath = socketPath;
    this.handler = handler;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Named pipes on Windows don't leave stale files — no cleanup needed
      if (!isWindows && existsSync(this.socketPath)) {
        try { unlinkSync(this.socketPath); } catch (err) {
          reject(new Error(`Cannot remove stale socket: ${err}`));
          return;
        }
      }

      this.server = createServer((socket) => this.onConnection(socket));
      this.server.on("error", (err) => {
        log("error", `server: ${err.message}`);
        reject(err);
      });
      this.server.listen(this.socketPath, () => {
        log("info", `server: listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    for (const client of this.clients.values()) client.socket.destroy();
    this.clients.clear();
    if (this.server) {
      await new Promise<void>((r) => this.server!.close(() => r()));
      this.server = null;
    }
    // Named pipes on Windows don't leave stale files — no cleanup needed
    if (!isWindows && existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* already gone */ }
    }
    log("info", "server: stopped");
  }

  // ── Connection lifecycle ────────────────────────────────────────

  private onConnection(socket: Socket): void {
    const id = `c${++clientIdCounter}`;
    const client: ConnectedClient = { id, socket, subscriptions: new Set(), buffer: "", capabilities: new Set() };
    this.clients.set(id, client);
    log("info", `server: ${id} connected (${this.clients.size} total)`);

    socket.on("data", (data) => this.onData(client, data));
    socket.on("close", () => {
      this.clients.delete(id);
      log("info", `server: ${id} disconnected (${this.clients.size} remaining)`);
    });
    socket.on("error", (err) => {
      log("warn", `server: ${id} error: ${err.message}`);
      this.clients.delete(id);
    });
  }

  private onData(client: ConnectedClient, data: Buffer | string): void {
    client.buffer += typeof data === "string" ? data : data.toString("utf-8");

    let idx: number;
    while ((idx = client.buffer.indexOf("\n")) !== -1) {
      const line = client.buffer.slice(0, idx).trim();
      client.buffer = client.buffer.slice(idx + 1);
      if (!line) continue;

      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
          this.sendTo(client, { type: "error", message: "Invalid command: missing 'type'" });
          continue;
        }
        const cmd = parsed as Command;
        const result = this.handler(client, cmd);
        if (result instanceof Promise) {
          result.catch((err: Error) => {
            log("error", `server: handler error for ${cmd.type}: ${err.message}`);
          });
        }
      } catch {
        this.sendTo(client, { type: "error", message: "Invalid JSON" });
      }
    }
  }

  // ── Event dispatch ──────────────────────────────────────────────

  sendTo(client: ConnectedClient, event: Event): void {
    if (client.socket.destroyed) return;
    try { client.socket.write(JSON.stringify(event) + "\n"); } catch { /* socket dead — client will be cleaned up on close */ }
  }

  broadcast(event: Event): void {
    for (const client of this.clients.values()) this.sendTo(client, event);
  }

  sendToSubscribers(convId: string, event: Event): void {
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(convId)) this.sendTo(client, event);
    }
  }

  sendToSubscribersExcept(convId: string, event: Event, except: ConnectedClient): void {
    for (const client of this.clients.values()) {
      if (client !== except && client.subscriptions.has(convId)) this.sendTo(client, event);
    }
  }

  /** Send capability-appropriate canonical history without breaking older clients. */
  sendHistoryUpdatedToSubscribers(
    convId: string,
    legacyEvent: Extract<Event, { type: "history_updated" }>,
    paginatedEvent: Extract<Event, { type: "history_updated" }>,
  ): void {
    for (const client of this.clients.values()) {
      if (!client.subscriptions.has(convId)) continue;
      this.sendTo(client, client.capabilities.has("history-pagination") ? paginatedEvent : legacyEvent);
    }
  }

  // ── Subscriptions ───────────────────────────────────────────────

  subscribe(client: ConnectedClient, convId: string): void {
    client.subscriptions.add(convId);
  }

  unsubscribe(client: ConnectedClient, convId: string): void {
    client.subscriptions.delete(convId);
  }

  /** Check if any connected client is subscribed to a conversation. */
  hasSubscribers(convId: string): boolean {
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(convId)) return true;
    }
    return false;
  }

  get clientCount(): number { return this.clients.size; }
}
