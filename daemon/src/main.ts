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
import { getAuthByProvider, getAuthInfoByProvider, hasConfiguredCredentials } from "./auth";
import { DaemonServer } from "./server";
import { createHandler } from "./handler";
import { handleLogin } from "./cli";
import * as convStore from "./conversations";
import { getRunningConversationIds } from "./control";
import { startScheduler, stopScheduler, getCronDir, getJobs } from "./scheduler";
import { startWatchdog, stopWatchdog } from "./watchdog";
import { initExternalTools, stopExternalToolsAsync, getExternalToolCount, getSupervisedDaemonCount, getExternalToolStyles } from "./external-tools";
import { recoverPendingTitles } from "./titlegen";
import { getToolDisplayInfo } from "./tools/registry";
import { getProviders, refreshProviders } from "./providers/registry";
import { socketPath, pidPath, runtimeDir, worktreeName, isWindows } from "@exocortex/shared/paths";

// ── Startup profiling ────────────────────────────────────────────────

const STARTUP_PROFILE = process.env.EXOCORTEX_PROFILE_STARTUP === "1" || process.argv.includes("--profile-startup");

function profileMark(event: string, details: object = {}): void {
  if (!STARTUP_PROFILE) return;
  console.error(`[startup-profile] ${JSON.stringify({ process: "daemon", event, elapsedMs: Math.round(performance.now() * 1000) / 1000, ...details })}`);
}

// ── Paths ───────────────────────────────────────────────────────────

mkdirSync(runtimeDir(), { recursive: true });

const SOCKET_PATH = socketPath();
const PID_PATH = pidPath();

profileMark("module_ready");

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
  profileMark("startDaemon_begin");
  log("info", "exocortexd: starting");

  if (await isAlreadyRunning()) {
    console.error("  ✗ exocortexd is already running");
    process.exit(1);
  }
  profileMark("singleton_checked");

  // Write PID file
  writeFileSync(PID_PATH, String(process.pid));
  profileMark("pid_written");

  // Create server — handler is set up with a forward reference
  // since the handler needs the server instance for sending events.
  let commandHandler: ((client: import("./server").ConnectedClient, cmd: import("./protocol").Command) => void | Promise<void>) | null = null;
  const server = new DaemonServer(SOCKET_PATH, (client, cmd) => commandHandler?.(client, cmd));
  commandHandler = createHandler(server);
  profileMark("server_constructed");

  const formatFatal = (err: unknown): string => err instanceof Error ? (err.stack ?? err.message) : String(err);

  // Graceful shutdown
  let shutdownPromise: Promise<never> | null = null;
  const shutdown = (exitCode = 0, reason = "shutdown"): Promise<never> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      log("info", `exocortexd: shutting down (${reason})`);
      stopWatchdog();
      if (!isWindows) {
        stopScheduler();
        await stopExternalToolsAsync();
      }
      convStore.flushAll();
      await server.stop();
      try { unlinkSync(PID_PATH); } catch { /* best-effort cleanup */ }
      process.exit(exitCode);
    })().catch((err) => {
      log("error", `exocortexd: shutdown failed: ${formatFatal(err)}`);
      try { unlinkSync(PID_PATH); } catch { /* best-effort cleanup */ }
      process.exit(exitCode || 1);
    }) as Promise<never>;

    return shutdownPromise;
  };

  process.on("SIGINT", () => { void shutdown(0, "SIGINT"); });
  process.on("SIGTERM", () => { void shutdown(0, "SIGTERM"); });
  process.on("uncaughtException", (err) => {
    log("error", `exocortexd: uncaught exception: ${formatFatal(err)}`);
    console.error(`\n  ✗ Uncaught exception: ${err instanceof Error ? err.message : String(err)}\n`);
    void shutdown(1, "uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    log("error", `exocortexd: unhandled rejection: ${formatFatal(reason)}`);
    console.error(`\n  ✗ Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
    void shutdown(1, "unhandledRejection");
  });

  // Windows doesn't deliver SIGTERM — ensure cleanup runs on exit regardless
  process.on("exit", () => {
    try { unlinkSync(PID_PATH); } catch { /* best-effort */ }
  });

  await server.start();
  profileMark("clients_can_connect", { socket: SOCKET_PATH });

  // Load persisted conversations
  const conversationLoadStats = convStore.loadFromDisk();
  profileMark("conversations_loaded", conversationLoadStats);
  recoverPendingTitles(server);
  profileMark("pending_titles_recovered");

  const broadcastToolsAvailable = () => {
    const externalStyles = isWindows ? [] : getExternalToolStyles();
    server.broadcast({
      type: "tools_available",
      providers: getProviders(),
      tools: getToolDisplayInfo(),
      authByProvider: getAuthByProvider(),
      authInfoByProvider: getAuthInfoByProvider(),
      ...(externalStyles.length > 0 ? { externalToolStyles: externalStyles } : {}),
    });
  };

  // Initialize external tools (scan + watch for changes)
  if (!isWindows) {
    initExternalTools(() => {
      // Broadcast updated tool styles to all connected clients
      broadcastToolsAvailable();
    });
  }
  profileMark("external_tools_initialized", { externalToolCount: isWindows ? 0 : getExternalToolCount(), supervisedDaemonCount: isWindows ? 0 : getSupervisedDaemonCount() });

  void refreshProviders(true).then((changed) => {
    if (!changed) return;
    broadcastToolsAvailable();
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
  profileMark("auth_checked", { authSummary });

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
  profileMark("ready", { cronJobs: cronJobs.length, externalToolCount: extToolCount, supervisedDaemonCount: supervisedCount });
}

// ── Main ────────────────────────────────────────────────────────────

const command = process.argv[2];

async function main(): Promise<void> {
  if (command === "login") {
    try {
      await handleLogin(process.argv[3]);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  ✗ Login failed: ${message}\n`);
      process.exit(1);
    }
  }

  if (command === "running-conversations") {
    try {
      const convIds = await getRunningConversationIds();
      if (convIds.length > 0) process.stdout.write(`${convIds.join("\n")}\n`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  ✗ Failed to query running conversations: ${message}\n`);
      process.exit(1);
    }
  }

  await startDaemon();
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log("error", `exocortexd: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  console.error(`\n  ✗ Failed to start: ${message}\n`);
  process.exit(1);
});
