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

import { homedir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { connect as netConnect } from "net";
import { log } from "./log";
import { loadAuth, saveAuth, isTokenExpired } from "./store";
import { login, refreshTokens, verifyAuth } from "./auth";
import { DaemonServer } from "./server";
import { createHandler } from "./handler";
import * as convStore from "./conversations";

// ── Paths ───────────────────────────────────────────────────────────

function runtimeDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const dir = join(xdg, "exocortex", "runtime");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SOCKET_PATH = join(runtimeDir(), "exocortexd.sock");
const PID_PATH = join(runtimeDir(), "exocortexd.pid");

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

// ── Login subcommand ────────────────────────────────────────────────

async function handleLogin(): Promise<void> {
  console.log("\n  Exocortex — Authentication\n");

  // Check existing credentials
  const existing = loadAuth();
  if (existing?.tokens?.accessToken && !isTokenExpired(existing.tokens)) {
    const valid = await verifyAuth(existing.tokens.accessToken);
    if (valid) {
      console.log(`  ✓ Already authenticated as ${existing.profile?.email ?? "unknown"}\n`);
      return;
    }
  }

  // Try token refresh
  if (existing?.tokens?.refreshToken) {
    try {
      const newTokens = await refreshTokens(existing.tokens.refreshToken);
      saveAuth({ ...existing, tokens: newTokens, updatedAt: new Date().toISOString() });
      console.log(`  ✓ Session refreshed (${existing.profile?.email ?? "unknown"})\n`);
      return;
    } catch {}
  }

  // Full OAuth flow
  const result = await login((msg) => console.log(`  ${msg}`));
  saveAuth({ tokens: result.tokens, profile: result.profile, updatedAt: new Date().toISOString() });
  console.log(`\n  ✓ Authenticated as ${result.profile?.email ?? "unknown"}\n`);
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

  console.log(`\n  exocortexd running (pid ${process.pid})`);
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
