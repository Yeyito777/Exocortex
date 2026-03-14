/**
 * Promise-based daemon client for the CLI.
 *
 * Unlike the TUI's event-driven client, every operation here is
 * request/response: connect, send a command, wait for matching
 * event(s), return. Stateless — each CLI invocation creates a
 * fresh connection and tears it down when done.
 */

import { connect, type Socket } from "net";
import { existsSync } from "fs";
import { socketPath } from "@exocortex/shared/paths";
import type { Command, Event } from "@exocortex/shared/protocol";

export class Connection {
  private socket: Socket | null = null;
  private buffer = "";
  private listeners: Array<(event: Event) => void> = [];

  /** Connect to the daemon. Throws if socket doesn't exist or connection fails. */
  async connect(): Promise<void> {
    const path = socketPath();
    if (!existsSync(path)) {
      throw new Error(
        "exocortexd socket not found. Is the daemon running?\n" +
        "Start it with: cd daemon && bun run start"
      );
    }

    return new Promise((resolve, reject) => {
      const socket = connect(path);
      let resolved = false;

      socket.on("connect", () => {
        this.socket = socket;
        resolved = true;
        resolve();
      });
      socket.on("data", (data) => this.onData(data));
      socket.on("error", (err) => {
        if (!resolved) reject(new Error(`Connection failed: ${err.message}`));
      });
      socket.on("close", () => {
        this.socket = null;
      });
    });
  }

  disconnect(): void {
    this.socket?.end();
    this.socket = null;
  }

  /** Send a command to the daemon. */
  send(command: Command): void {
    if (!this.socket) throw new Error("Not connected");
    this.socket.write(JSON.stringify(command) + "\n");
  }

  /** Register a listener for all incoming events. */
  onEvent(listener: (event: Event) => void): void {
    this.listeners.push(listener);
  }

  /** Remove a previously registered listener. */
  offEvent(listener: (event: Event) => void): void {
    const idx = this.listeners.indexOf(listener);
    if (idx !== -1) this.listeners.splice(idx, 1);
  }

  /**
   * Send a command and wait for a single event matching the predicate.
   * Returns the matched event. Rejects on timeout or error events.
   */
  request<T extends Event>(
    command: Command,
    match: (event: Event) => event is T,
    timeoutMs = 10_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for response to ${command.type}`));
      }, timeoutMs);

      const handler = (event: Event) => {
        // Match error events to this request by reqId
        if (event.type === "error" && event.reqId && event.reqId === command.reqId) {
          cleanup();
          reject(new Error(event.message));
          return;
        }
        if (match(event)) {
          cleanup();
          resolve(event);
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.offEvent(handler);
      };

      this.listeners.push(handler);
      this.send(command);
    });
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
        for (const listener of [...this.listeners]) listener(event);
      } catch {
        // Malformed event — skip
      }
    }
  }
}
