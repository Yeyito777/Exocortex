/**
 * The daemon's end of two small helpers the Antigravity CLI runs for an
 * Exocortex conversation (both standalone scripts beside this file):
 *
 * - mcp-bridge.ts: a stdio MCP server, listed in the ACP session's
 *   mcpServers, that offers Exocortex's host tools (exo, chrono, ...) and
 *   forwards their calls here, where the turn's tool executor runs them.
 * - hook.ts: a PreToolUse hook (hooks.ts installs it) that asks here before
 *   each of the agent's own tool calls, for the safety denylist and the
 *   built-ins Exocortex replaces.
 *
 * Both reach this daemon over one unix socket and name their process by a
 * per-process token, which only that process's environment carries.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Socket, UnixSocketListener } from "bun";
import { runtimeDir } from "@exocortex/shared/paths";
import { log } from "../../log";

export interface BridgeToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BridgeCallResult {
  text: string;
  isError: boolean;
}

export interface BridgePreToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface BridgeDecision {
  decision: "deny";
  reason: string;
}

/** What one Antigravity process's helpers are served by. */
export interface BridgeTarget {
  tools(): { tools: BridgeToolDef[]; instructions: string };
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<BridgeCallResult>;
  preToolUse(call: BridgePreToolCall, cwd: string): BridgeDecision | null;
}

interface Request {
  token?: string;
  id?: number;
  type?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  toolCall?: BridgePreToolCall;
  cwd?: string;
  /** For cancel: the call request to stop. */
  target?: number;
}

interface ConnectionState {
  buffer: string;
  calls: Map<number, AbortController>;
}

const targets = new Map<string, BridgeTarget>();
let listener: UnixSocketListener<ConnectionState> | null = null;
let listenerPath: string | null = null;

/** The bridge socket path: in the runtime directory unless that is too long for a socket. */
function bridgeSocketPath(): string {
  const candidate = join(runtimeDir(), "gemini-tools.sock");
  if (Buffer.byteLength(candidate) < 100) return candidate;
  const digest = createHash("sha256").update(candidate).digest("hex").slice(0, 16);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `exo-gemini-${uid}-${digest}.sock`);
}

function reply(socket: Socket<ConnectionState>, message: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

async function handle(socket: Socket<ConnectionState>, request: Request): Promise<void> {
  const target = request.token ? targets.get(request.token) : undefined;
  const id = request.id;
  if (!target) {
    reply(socket, { id, error: "This Antigravity process is no longer attached to an Exocortex conversation." });
    return;
  }
  try {
    switch (request.type) {
      case "list":
        reply(socket, { id, result: target.tools() });
        return;
      case "call": {
        const controller = new AbortController();
        if (typeof id === "number") socket.data.calls.set(id, controller);
        try {
          const result = await target.call(request.name ?? "", request.arguments ?? {}, controller.signal);
          reply(socket, { id, result });
        } finally {
          if (typeof id === "number") socket.data.calls.delete(id);
        }
        return;
      }
      case "cancel":
        // The CLI gave up on the call (its three-minute limit): stop it here too.
        if (typeof request.target === "number") socket.data.calls.get(request.target)?.abort();
        return;
      case "pretool": {
        const decision = request.toolCall ? target.preToolUse(request.toolCall, request.cwd ?? "") : null;
        reply(socket, { id, result: decision ?? {} });
        return;
      }
      default:
        reply(socket, { id, error: `Unknown request ${request.type}` });
    }
  } catch (error) {
    reply(socket, { id, error: error instanceof Error ? error.message : String(error) });
  }
}

function ensureListener(): string {
  if (listener && listenerPath) return listenerPath;
  const path = bridgeSocketPath();
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  listener = Bun.listen<ConnectionState>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { buffer: "", calls: new Map() };
      },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        let newline: number;
        while ((newline = socket.data.buffer.indexOf("\n")) >= 0) {
          const line = socket.data.buffer.slice(0, newline).trim();
          socket.data.buffer = socket.data.buffer.slice(newline + 1);
          if (!line) continue;
          let request: Request;
          try {
            request = JSON.parse(line) as Request;
          } catch {
            continue;
          }
          void handle(socket, request);
        }
      },
      close(socket) {
        // The helper went away (its MCP call was cancelled): stop what it asked for.
        for (const controller of socket.data.calls.values()) controller.abort();
        socket.data.calls.clear();
      },
      error(_socket, error) {
        log("warn", `gemini: tool bridge connection error: ${error.message}`);
      },
    },
  });
  listenerPath = path;
  log("info", `gemini: tool bridge listening on ${path}`);
  return path;
}

/** Serve one Antigravity process's helpers. Returns its socket path and token; `release` stops serving it. */
export function attachBridgeTarget(target: BridgeTarget): { socketPath: string; token: string; release: () => void } {
  const socketPath = ensureListener();
  const token = randomBytes(24).toString("hex");
  targets.set(token, target);
  return { socketPath, token, release: () => { targets.delete(token); } };
}

/** For tests: stop listening and forget every target. */
export function closeBridgeForTest(): void {
  listener?.stop(true);
  if (listenerPath) rmSync(listenerPath, { force: true });
  listener = null;
  listenerPath = null;
  targets.clear();
}

export const MCP_BRIDGE_SCRIPT = join(import.meta.dir, "mcp-bridge.ts");
export const HOOK_SCRIPT = join(import.meta.dir, "hook.ts");
