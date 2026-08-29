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
import type { ClientCapability, Command, Event } from "./protocol";

// ── Client tracking ─────────────────────────────────────────────────

let clientIdCounter = 0;

export interface ConnectedClient {
  id: string;
  socket: Socket;
  subscriptions: Set<string>;
  buffer: string;
  capabilities: Set<"history-pagination" | ClientCapability>;
  /** Endpoint-switch barrier: no local daemon events may follow ssh_status. */
  routeClosing?: boolean;
  /** This session's ordinary protocol stream is owned by an SSH bridge. */
  forwarding?: boolean;
}

export type CommandHandler = (client: ConnectedClient, command: Command) => void | Promise<void>;

/** Optional transport-level router for protocol-transparent forwarding. */
export interface RawCommandRouter {
  /** Return true when the frame was consumed and must not reach the local handler. */
  route(client: ConnectedClient, rawFrame: string, parsed: { type: string }): boolean;
  onClientConnected?(client: ConnectedClient): void;
  onClientDisconnected?(client: ConnectedClient): void;
  stop?(): void | Promise<void>;
}

// ── Server ──────────────────────────────────────────────────────────

export class DaemonServer {
  private server: Server | null = null;
  private clients = new Map<string, ConnectedClient>();
  private handler: CommandHandler;
  private socketPath: string;
  private router: RawCommandRouter | null;

  constructor(socketPath: string, handler: CommandHandler, router?: RawCommandRouter) {
    this.socketPath = socketPath;
    this.handler = handler;
    this.router = router ?? null;
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
    await this.router?.stop?.();
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
    const client: ConnectedClient = {
      id,
      socket,
      subscriptions: new Set(),
      buffer: "",
      capabilities: new Set(),
      routeClosing: false,
      forwarding: false,
    };
    this.clients.set(id, client);
    log("info", `server: ${id} connected (${this.clients.size} total)`);
    this.router?.onClientConnected?.(client);

    socket.on("data", (data) => this.onData(client, data));
    socket.on("close", () => {
      this.router?.onClientDisconnected?.(client);
      this.clients.delete(id);
      log("info", `server: ${id} disconnected (${this.clients.size} remaining)`);
    });
    socket.on("error", (err) => {
      log("warn", `server: ${id} error: ${err.message}`);
      this.router?.onClientDisconnected?.(client);
      this.clients.delete(id);
    });
  }

  private onData(client: ConnectedClient, data: Buffer | string): void {
    client.buffer += typeof data === "string" ? data : data.toString("utf-8");

    let idx: number;
    while ((idx = client.buffer.indexOf("\n")) !== -1) {
      const frame = client.buffer.slice(0, idx);
      const line = frame.trim();
      client.buffer = client.buffer.slice(idx + 1);
      if (!line) continue;

      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
          this.sendTo(client, { type: "error", message: "Invalid command: missing 'type'" });
          continue;
        }
        if (this.router?.route(client, `${frame}\n`, parsed)) continue;
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

  sendTo(client: ConnectedClient, event: Event, measureBytes = false): number {
    // Forwarded sessions belong wholly to the remote daemon. Local background
    // streams and global broadcasts must never contaminate that byte stream.
    if (client.forwarding) return 0;
    return this.writeEvent(client, event, measureBytes);
  }

  /** Send a local transport-control event even when the protocol is forwarded. */
  sendTransportTo(client: ConnectedClient, event: Event): number {
    return this.writeEvent(client, event, false);
  }

  private writeEvent(client: ConnectedClient, event: Event, measureBytes: boolean): number {
    if (client.socket.destroyed || client.routeClosing) return 0;
    try {
      const payload = JSON.stringify(event) + "\n";
      client.socket.write(payload);
      return measureBytes ? Buffer.byteLength(payload) : 0;
    } catch {
      // Socket dead — client will be cleaned up on close.
      return 0;
    }
  }

  broadcast(event: Event): void {
    for (const client of this.clients.values()) this.sendTo(client, event);
  }

  /** Broadcast a routing-control event to local and forwarded sessions alike. */
  broadcastTransport(event: Event): void {
    for (const client of this.clients.values()) this.sendTransportTo(client, event);
  }

  /** Gracefully close every client after already-queued status bytes are flushed. */
  disconnectClients(): void {
    for (const client of this.clients.values()) {
      if (client.socket.destroyed) continue;
      // The switch status was queued before this call. Establish a hard barrier
      // so racing local stream/sidebar broadcasts cannot follow it on the wire.
      client.routeClosing = true;
      client.socket.end();
      const timer = setTimeout(() => client.socket.destroy(), 250);
      timer.unref?.();
    }
  }

  /**
   * Send the compact reorder delta to capable clients. Materialize the legacy
   * full sidebar snapshot at most once, and only when an older client needs it.
   */
  broadcastSidebarItemsReordered(
    event: Extract<Event, { type: "sidebar_items_reordered" }>,
    legacyEvent: () => Extract<Event, { type: "conversation_moved" }>,
  ): void {
    let legacy: Extract<Event, { type: "conversation_moved" }> | undefined;
    for (const client of this.clients.values()) {
      if (client.capabilities.has("sidebar-reorder-delta")) {
        this.sendTo(client, event);
      } else {
        legacy ??= legacyEvent();
        this.sendTo(client, legacy);
      }
    }
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

  /** Whether compatibility requires materializing a complete history refresh. */
  hasLegacyHistorySubscribers(convId: string): boolean {
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(convId)
          && !client.capabilities.has("history-pagination")) return true;
    }
    return false;
  }

  hasLegacyUnwindSubscribers(convId: string): boolean {
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(convId)
          && !client.capabilities.has("targeted-unwind")) return true;
    }
    return false;
  }

  /**
   * Deliver the small delta to capable clients. Legacy clients receive their
   * old summary event and, only when subscribed to this conversation, a full
   * history fallback. This compatibility path never writes the sidebar index.
   */
  deliverConversationUnwind(
    event: Extract<Event, { type: "conversation_unwound" }>,
    requester: ConnectedClient,
    requesterEvent: Extract<Event, { type: "conversation_unwound" }>,
    broadcast: boolean,
    legacyHistory?: {
      legacy: Extract<Event, { type: "history_updated" }>;
      paginated: Extract<Event, { type: "history_updated" }>;
    },
  ): void {
    for (const client of this.clients.values()) {
      if (client !== requester && !broadcast) continue;
      if (client.capabilities.has("targeted-unwind")) {
        this.sendTo(client, client === requester ? requesterEvent : event);
        continue;
      }
      this.sendTo(client, { type: "conversation_updated", summary: event.summary });
      if (legacyHistory && client.subscriptions.has(event.convId)) {
        this.sendTo(client, client.capabilities.has("history-pagination")
          ? legacyHistory.paginated
          : legacyHistory.legacy);
      }
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
