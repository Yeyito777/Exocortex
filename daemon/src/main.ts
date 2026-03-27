/**
 * exocortexd — the Exocortex daemon.
 *
 * A persistent background process that owns all AI state and exposes
 * a Unix socket for clients (TUI, future GUIs, scripts) to connect to.
 *
 * Usage:
 *   bun run src/main.ts          Start the daemon
 *   bun run src/main.ts login [provider]    Authenticate a provider
 */

import { loadEnvFile } from "./env";
loadEnvFile();

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { connect as netConnect } from "net";
import { log } from "./log";
import { hasConfiguredCredentials } from "./auth";
import { DaemonServer } from "./server";
import { createHandler } from "./handler";
import { handleLogin } from "./cli";
import * as convStore from "./conversations";
import { startScheduler, stopScheduler, getCronDir, getJobs } from "./scheduler";
import { startWatchdog, stopWatchdog } from "./watchdog";
import { initExternalTools, stopExternalToolsAsync, getExternalToolCount, getSupervisedDaemonCount, getExternalToolStyles } from "./external-tools";
import { getToolDisplayInfo } from "./tools/registry";
import { getProviders, refreshProviders } from "./providers/registry";
import { socketPath, pidPath, runtimeDir, worktreeName, isWindows } from "@exocortex/shared/paths";

// ── Paths ───────────────────────────────────────────────────────────

mkdirSync(runtimeDir(), { recursive: true });

const SOCKET_PATH = socketPath();
const PID_PATH = pidPath();

// ── Singleton guard ─────────────────────────────────────────────────

function probeSocket(): Promise<boolean> {
  // Named pipes on Windows don't exist as files — skip the filesystem check
  if (!isWindows && !existsSync(SOCKET_PATH)) return Promise.resolve(false);
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
        try { process.kill(pid, 0); if (await probeSocket()) return true; } catch { /* process gone — stale PID */ }
      }
    } catch { /* corrupt PID file — treat as stale */ }
    try { unlinkSync(PID_PATH); } catch { /* already gone */ }
  }
  if (await probeSocket()) return true;
  // Named pipes on Windows don't leave stale files — no cleanup needed
  if (!isWindows && existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
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
    stopWatchdog();
    if (!isWindows) {
      stopScheduler();
      await stopExternalToolsAsync();
    }
    convStore.flushAll();
    await server.stop();
    try { unlinkSync(PID_PATH); } catch { /* best-effort cleanup */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Windows doesn't deliver SIGTERM — ensure cleanup runs on exit regardless
  process.on("exit", () => {
    try { unlinkSync(PID_PATH); } catch { /* best-effort */ }
  });

  await server.start();

  // Load persisted conversations
  convStore.loadFromDisk();

  // Initialize external tools (scan + watch for changes)
  if (!isWindows) {
    initExternalTools(() => {
      // Broadcast updated tool styles to all connected clients
      const externalStyles = getExternalToolStyles();
      server.broadcast({
        type: "tools_available",
        providers: getProviders(),
        tools: getToolDisplayInfo(),
        ...(externalStyles.length > 0 ? { externalToolStyles: externalStyles } : {}),
      });
    });
  }

  void refreshProviders(true).then((changed) => {
    if (!changed) return;
    const externalStyles = isWindows ? [] : getExternalToolStyles();
    server.broadcast({
      type: "tools_available",
      providers: getProviders(),
      tools: getToolDisplayInfo(),
      ...(externalStyles.length > 0 ? { externalToolStyles: externalStyles } : {}),
    });
  }).catch((err) => {
    log("warn", `exocortexd: initial provider refresh failed: ${err instanceof Error ? err.message : err}`);
  });

  // Start cron scheduler + stale stream watchdog
  if (!isWindows) {
    startScheduler();
  }
  startWatchdog();

  // Check auth status
  const authSummary = getProviders()
    .map((provider) => `${provider.id}=${hasConfiguredCredentials(provider.id) ? "✓" : "✗"}`)
    .join(" ");

  const wt = worktreeName();
  const cronJobs = isWindows ? [] : getJobs();
  const extToolCount = isWindows ? 0 : getExternalToolCount();
  const supervisedCount = isWindows ? 0 : getSupervisedDaemonCount();
  console.log(`\n  exocortexd running (pid ${process.pid})${wt ? ` [worktree: ${wt}]` : ""}`);
  console.log(`  socket: ${SOCKET_PATH}`);
  console.log(`  auth:   ${authSummary || "none configured"}`);
  console.log(`  cron:   ${cronJobs.length} job(s) in ${getCronDir()}`);
  console.log(`  tools:  ${extToolCount} external tool(s)${supervisedCount > 0 ? `, ${supervisedCount} supervised daemon(s)` : ""}`);
  console.log(`\n  Waiting for connections...\n`);

  log("info", `exocortexd: ready on ${SOCKET_PATH} (auth=${authSummary}, cron=${cronJobs.length})`);
}

// ── Main ────────────────────────────────────────────────────────────

const command = process.argv[2];

if (command === "login") {
  handleLogin(process.argv[3]).catch((err) => {
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
