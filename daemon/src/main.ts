/**
 * exocortexd — the Exocortex daemon.
 *
 * A persistent background process that owns all AI state and exposes
 * a Unix socket for clients (TUI, future GUIs, scripts) to connect to.
 *
 * Usage:
 *   bun run src/main.ts          Start the daemon
 *   bun run src/main.ts login    Authenticate with Anthropic
 */

import { loadEnvFile } from "./env";
loadEnvFile();

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { connect as netConnect } from "net";
import { log } from "./log";
import { loadAuth, isTokenExpired } from "./store";
import { DaemonServer } from "./server";
import { createHandler } from "./handler";
import { handleLogin } from "./cli";
import * as convStore from "./conversations";
import { socketPath, pidPath, runtimeDir, worktreeName } from "@exocortex/shared/paths";

// ── Paths ───────────────────────────────────────────────────────────

mkdirSync(runtimeDir(), { recursive: true });

const SOCKET_PATH = socketPath();
const PID_PATH = pidPath();

// ── Singleton guard ─────────────────────────────────────────────────

function probeSocket(): Promise<boolean> {
  if (!existsSync(SOCKET_PATH)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const client = netConnect(SOCKET_PATH);
    const timer = setTimeout(() => { client.destroy(); resolve(false); }, 1000);
    client.on("connect", () => { clearTimeout(timer); client.end(); resolve(true); });
    client.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

async function isAlreadyRunning(): Promise<boolean> {
  if (existsSync(PID_PATH)) {
    try {
      const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
      if (!isNaN(pid) && pid !== process.pid) {
        try { process.kill(pid, 0); if (await probeSocket()) return true; } catch {}
      }
    } catch {}
    try { unlinkSync(PID_PATH); } catch {}
  }
  if (await probeSocket()) return true;
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch {}
  }
  return false;
}

// ── Daemon startup ──────────────────────────────────────────────────

async function startDaemon(): Promise<void> {
  log("info", "exocortexd: starting");

  if (await isAlreadyRunning()) {
    console.error("  ✗ exocortexd is already running");
    process.exit(1);
  }

  // Write PID file
  writeFileSync(PID_PATH, String(process.pid));

  // Create server — handler is set up with a forward reference
  // since the handler needs the server instance for sending events.
  let commandHandler: ((client: import("./server").ConnectedClient, cmd: import("./protocol").Command) => void | Promise<void>) | null = null;
  const server = new DaemonServer(SOCKET_PATH, (client, cmd) => commandHandler?.(client, cmd));
  commandHandler = createHandler(server);

  // Graceful shutdown
  const shutdown = async () => {
    log("info", "exocortexd: shutting down");
    convStore.flushAll();
    await server.stop();
    try { unlinkSync(PID_PATH); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.start();

  // Load persisted conversations
  convStore.loadFromDisk();

  // Check auth status
  const auth = loadAuth();
  const authOk = auth?.tokens?.accessToken && !isTokenExpired(auth.tokens);

  const wt = worktreeName();
  console.log(`\n  exocortexd running (pid ${process.pid})${wt ? ` [worktree: ${wt}]` : ""}`);
  console.log(`  socket: ${SOCKET_PATH}`);
  console.log(`  auth:   ${authOk ? `✓ ${auth?.profile?.email ?? "authenticated"}` : "✗ not authenticated — run: bun run login"}`);
  console.log(`\n  Waiting for connections...\n`);

  log("info", `exocortexd: ready on ${SOCKET_PATH} (auth=${!!authOk})`);
}

// ── Main ────────────────────────────────────────────────────────────

const command = process.argv[2];

if (command === "login") {
  handleLogin().catch((err) => {
    console.error(`\n  ✗ Login failed: ${err.message}\n`);
    process.exit(1);
  });
} else {
  startDaemon().catch((err) => {
    log("error", `exocortexd: fatal: ${err.stack ?? err.message}`);
    console.error(`\n  ✗ Failed to start: ${err.message}\n`);
    process.exit(1);
  });
}
