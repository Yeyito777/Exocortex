/**
 * Unix domain socket server for exocortexd.
 *
 * Accepts client connections, parses JSON-lines commands,
 * routes them to handlers, and sends events back.
 */

import { createServer, type Server, type Socket } from "net";
import { existsSync, unlinkSync } from "fs";
import { StringDecoder } from "node:string_decoder";
import { isWindows } from "@exocortex/shared/paths";
import { LineSplitter } from "./line-splitter";
import { log } from "./log";
import { budgetHistoryUpdatedEvent } from "./history-pagination";
import type { AppClientInfo, ClientCapability, Command, Event, ProviderId, TokenStatsSnapshot, UsageData } from "./protocol";
import { PROVIDER_PROXY_LINK_EVENT_TYPES } from "@exocortex/shared/provider-proxy";
import type { SidebarDigest } from "@exocortex/shared/sidebar-digest";
import type { SidebarViewHint } from "@exocortex/shared/sidebar-first-page";
import type { UpdateStatus } from "@exocortex/shared/updatecheck";

// ── Client tracking ─────────────────────────────────────────────────

let clientIdCounter = 0;

export interface ConnectedClient {
  id: string;
  socket: Socket;
  subscriptions: Set<string>;
  lines: LineSplitter;
  /** Per-connection UTF-8 state; bytes can split a character across reads. */
  decoder?: StringDecoder;
  capabilities: Set<"history-pagination" | ClientCapability>;
  /**
   * A /proxy link from another daemon (provider_proxy_hello). It gets only
   * provider-proxy events and errors, never broadcasts.
   */
  providerProxyLink?: boolean;
  /** Single-use: the list this client already holds (sidebar-digest-sync). */
  sidebarDigest?: SidebarDigest;
  /** sidebar-incremental: the view the next bootstrap's first page is for (used once). */
  sidebarView?: SidebarViewHint;
  /**
   * An app client (docs/app-api.md): it gets only answers to its requests and
   * the events of conversations it subscribes to, never broadcasts.
   */
  app?: AppClientInfo;
}

/** The conversation an event is about, when it names one. */
function eventConversationId(event: Event): string | undefined {
  const named = event as { convId?: unknown; summary?: { id?: unknown } };
  if (typeof named.convId === "string") return named.convId;
  if (named.summary && typeof named.summary.id === "string") return named.summary.id;
  return undefined;
}

export type CommandHandler = (client: ConnectedClient, command: Command) => void | Promise<void>;

// ── Usage fan-out ───────────────────────────────────────────────────

const lastBroadcastUsage = new WeakMap<object, Map<ProviderId, string>>();

/**
 * Usage is re-fetched after every turn and on response headers, and usually
 * comes back unchanged. Connected clients already hold the last value (new
 * ones get it in their bootstrap), so identical repeats are not re-sent.
 */
export function broadcastUsageUpdate(server: Pick<DaemonServer, "broadcast">, provider: ProviderId, usage: UsageData | null): void {
  let last = lastBroadcastUsage.get(server);
  if (!last) lastBroadcastUsage.set(server, last = new Map());
  const serialized = JSON.stringify(usage);
  if (last.get(provider) === serialized) return;
  last.set(provider, serialized);
  server.broadcast({ type: "usage_update", provider, usage });
}

// ── Server ──────────────────────────────────────────────────────────

export class DaemonServer {
  private server: Server | null = null;
  private clients = new Map<string, ConnectedClient>();
  private handler: CommandHandler;
  private socketPath: string;
  private closeListeners = new Set<(client: ConnectedClient) => void>();
  /** Hidden conversations' events reach only their subscribers (app-registry.ts). */
  private isHiddenConversation: (convId: string) => boolean = () => false;

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
    const client: ConnectedClient = {
      id,
      socket,
      subscriptions: new Set(),
      lines: new LineSplitter(),
      decoder: new StringDecoder("utf8"),
      capabilities: new Set(),
    };
    this.clients.set(id, client);
    log("info", `server: ${id} connected (${this.clients.size} total)`);

    socket.on("data", (data) => this.onData(client, data));
    socket.on("close", () => {
      this.clients.delete(id);
      log("info", `server: ${id} disconnected (${this.clients.size} remaining)`);
      this.notifyClosed(client);
    });
    socket.on("error", (err) => {
      log("warn", `server: ${id} error: ${err.message}`);
      this.clients.delete(id);
      this.notifyClosed(client);
    });
  }

  private readonly closed = new WeakSet<ConnectedClient>();

  private notifyClosed(client: ConnectedClient): void {
    if (this.closed.has(client)) return;
    this.closed.add(client);
    for (const listener of this.closeListeners) {
      try { listener(client); } catch (err) {
        log("error", `server: close listener failed for ${client.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Told once when a connection closes. */
  onClientClosed(listener: (client: ConnectedClient) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  setHiddenConversationFilter(isHidden: (convId: string) => boolean): void {
    this.isHiddenConversation = isHidden;
  }

  /**
   * Whether a broadcast goes to this client. App clients and hidden
   * conversations' events go only to subscribers; app clients also learn of a
   * daemon shutdown.
   */
  private receivesBroadcast(client: ConnectedClient, event: Event, convId: string | undefined, hidden: boolean): boolean {
    if (!client.app && !hidden) return true;
    if (convId !== undefined && client.subscriptions.has(convId)) return true;
    return client.app !== undefined && event.type === "daemon_shutdown";
  }

  private onData(client: ConnectedClient, data: Buffer | string): void {
    const chunk = typeof data === "string" ? data : (client.decoder ??= new StringDecoder("utf8")).write(data);
    client.lines.push(chunk, (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.sendTo(client, { type: "error", message: "Invalid JSON" });
        return;
      }
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
        this.sendTo(client, { type: "error", message: "Invalid command: missing 'type'" });
        return;
      }
      const cmd = parsed as Command;
      // A failed handler still answers the request, so the client's pending
      // reqId (and any optimistic state keyed on it) settles instead of hanging.
      const fail = (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log("error", `server: handler error for ${cmd.type}: ${message}`);
        const reqId = "reqId" in cmd && typeof cmd.reqId === "string" ? cmd.reqId : undefined;
        const convId = "convId" in cmd && typeof cmd.convId === "string" ? cmd.convId : undefined;
        this.sendTo(client, { type: "error", ...(reqId ? { reqId } : {}), ...(convId ? { convId } : {}), message });
      };
      try {
        const result = this.handler(client, cmd);
        if (result instanceof Promise) result.catch(fail);
      } catch (err) {
        fail(err);
      }
    });
  }

  // ── Event dispatch ──────────────────────────────────────────────

  sendTo(client: ConnectedClient, event: Event, measureBytes = false): number {
    if (client.socket.destroyed) return 0;
    if (client.providerProxyLink && event.type !== "error" && !PROVIDER_PROXY_LINK_EVENT_TYPES.has(event.type)) return 0;
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
    const convId = eventConversationId(event);
    const hidden = convId !== undefined && this.isHiddenConversation(convId);
    for (const client of this.clients.values()) {
      if (this.receivesBroadcast(client, event, convId, hidden)) this.sendTo(client, event);
    }
  }

  /** broadcast() to everyone but `except`. */
  broadcastExcept(event: Event, except: ConnectedClient): void {
    const convId = eventConversationId(event);
    const hidden = convId !== undefined && this.isHiddenConversation(convId);
    for (const client of this.clients.values()) {
      if (client !== except && this.receivesBroadcast(client, event, convId, hidden)) this.sendTo(client, event);
    }
  }

  /** Only connections that asked for pushes; older clients poll with ping updateStatusOnly. */
  broadcastUpdateStatus(status: UpdateStatus): void {
    for (const client of this.clients.values()) {
      if (client.capabilities.has("update-status-push")) this.sendTo(client, { type: "update_status", status });
    }
  }

  /** Changed history revisions, to TUIs that keep opened pages (never app clients). */
  broadcastHistoryRevisions(revs: Record<string, string>): void {
    for (const client of this.clients.values()) {
      if (client.capabilities.has("history-revisions") && !client.app) this.sendTo(client, { type: "history_revisions", revs });
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
      if (client.app) continue;
      if (client.capabilities.has("sidebar-reorder-delta")) {
        this.sendTo(client, event);
      } else {
        legacy ??= legacyEvent();
        this.sendTo(client, legacy);
      }
    }
  }

  /**
   * Send structural sidebar upserts/removals to capable clients. Older clients
   * still receive the canonical full snapshot, materialized at most once.
   */
  broadcastSidebarStatePatched(
    event: Extract<Event, { type: "sidebar_state_patched" }>,
    legacyEvent: () => Extract<Event, { type: "conversation_moved" }>,
  ): void {
    let legacy: Extract<Event, { type: "conversation_moved" }> | undefined;
    for (const client of this.clients.values()) {
      if (client.app) continue;
      if (client.capabilities.has("sidebar-state-patch")) {
        this.sendTo(client, event);
      } else {
        legacy ??= legacyEvent();
        this.sendTo(client, legacy);
      }
    }
  }

  /**
   * Push token statistics only to clients that still expect them unprompted.
   * The snapshot is large and costly, so it is built at most once and only
   * when such a client is connected; capable clients ask with get_token_stats.
   */
  broadcastLegacyTokenStats(snapshot: () => TokenStatsSnapshot): void {
    let event: Extract<Event, { type: "token_stats" }> | undefined;
    for (const client of this.clients.values()) {
      if (client.capabilities.has("token-stats-on-demand") || client.providerProxyLink || client.app) continue;
      this.sendTo(client, event ??= { type: "token_stats", stats: snapshot() });
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
    let budgetedEvent: Extract<Event, { type: "history_updated" }> | undefined;
    for (const client of this.clients.values()) {
      if (!client.subscriptions.has(convId)) continue;
      if (client.capabilities.has("history-block-pagination") && client.capabilities.has("history-pagination")) {
        this.sendTo(client, budgetedEvent ??= budgetHistoryUpdatedEvent(paginatedEvent));
        continue;
      }
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
    const hidden = this.isHiddenConversation(event.convId);
    for (const client of this.clients.values()) {
      if (client !== requester && !broadcast) continue;
      if (client !== requester && (client.app || hidden) && !client.subscriptions.has(event.convId)) continue;
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
