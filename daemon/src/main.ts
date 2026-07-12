/**
 * exocortexd — the Exocortex daemon.
 *
 * A persistent background process that owns all AI state and exposes
 * a Unix socket for clients (TUI, future GUIs, scripts) to connect to.
 *
 * Usage:
 *   bun run src/main.ts          Start the daemon
 *   bun run src/main.ts login [provider]    Authenticate a provider
 *   bun run src/main.ts prepare-restart     Save/interrupt streams before service restart
 */

import { loadEnvFile } from "./env";
loadEnvFile();

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { connect as netConnect } from "net";
import { agentWorkingDirectory } from "@exocortex/shared/config";
import { log } from "./log";
import { getAuthByProvider, getAuthInfoByProvider, hasConfiguredCredentials } from "./auth";
import { DaemonServer } from "./server";
import { createHandler } from "./handler";
import { handleLogin } from "./cli";
import * as convStore from "./conversations";
import { getRunningConversationIds, prepareRestartForReplay, prepareStopWithoutReplay } from "./control";
import { clearRestartRecoveryForStop, deliverPendingSubagentNotifications, hasActiveGoalRestartMarker, prepareCatchableShutdownForReplay, prepareCatchableShutdownWithoutReplay, recoverActiveGoals, recoverInterruptedStreams } from "./restart-recovery";
import { startChronoService, stopChronoService, listChronoSchedules } from "./chrono-service";
import { startWatchdog, stopWatchdog } from "./watchdog";
import { initExternalTools, stopExternalToolsAsync, getExternalToolCount, getSupervisedDaemonCount, getExternalToolStyles } from "./external-tools";
import { recoverPendingTitles } from "./titlegen";
import { beginDaemonShutdown, resolveDaemonShutdownMode } from "./daemon-lifecycle";
import { getToolDisplayInfo } from "./tools/registry";
import { getProviders, refreshProviders } from "./providers/registry";
import { socketPath, pidPath, runtimeDir, worktreeName, isWindows } from "@exocortex/shared/paths";
import { stopAllBackgroundTasks, waitForBackgroundTasksToStop } from "./conversation-activity";

// ── Startup profiling ────────────────────────────────────────────────

const STARTUP_PROFILE = process.env.EXOCORTEX_PROFILE_STARTUP === "1" || process.argv.includes("--profile-startup");

function profileMark(event: string, details: object = {}): void {
  if (!STARTUP_PROFILE) return;
  console.error(`[startup-profile] ${JSON.stringify({ process: "daemon", event, elapsedMs: Math.round(performance.now() * 1000) / 1000, ...details })}`);
}

// ── Working directory / paths ───────────────────────────────────────

function useDefaultWorkingDirectory(): void {
  const cwd = agentWorkingDirectory();
  mkdirSync(cwd, { recursive: true });
  process.chdir(cwd);
}

useDefaultWorkingDirectory();

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
      const requestedMode = resolveDaemonShutdownMode(exitCode, hasActiveGoalRestartMarker());
      const shutdownMode = beginDaemonShutdown(requestedMode);
      log("info", `exocortexd: shutting down (${reason}, mode=${shutdownMode})`);
      stopWatchdog();
      stopChronoService();

      if (shutdownMode === "restart") {
        const replayPrep = await prepareCatchableShutdownForReplay();
        if (replayPrep.convIds.length > 0) {
          log("info", `exocortexd: scheduled ${replayPrep.convIds.length} interrupted conversation(s) for replay on next start: ${replayPrep.convIds.join(", ")}`);
        }
        if (replayPrep.stillStreaming.length > 0) {
          log("warn", `exocortexd: ${replayPrep.stillStreaming.length} conversation(s) still streaming after graceful interrupt timeout: ${replayPrep.stillStreaming.join(", ")}; next start will replay from saved history`);
        }
      } else {
        const stopPrep = await prepareCatchableShutdownWithoutReplay();
        if (stopPrep.convIds.length > 0) {
          log("info", `exocortexd: stopped ${stopPrep.convIds.length} active conversation(s) without scheduling replay: ${stopPrep.convIds.join(", ")}`);
        }
        if (stopPrep.stillStreaming.length > 0) {
          log("warn", `exocortexd: ${stopPrep.stillStreaming.length} conversation(s) still shutting down after stop timeout: ${stopPrep.stillStreaming.join(", ")}`);
        }
      }

      const stoppedBackgroundTasks = stopAllBackgroundTasks();
      if (stoppedBackgroundTasks > 0) {
        const remaining = await waitForBackgroundTasksToStop();
        log(
          remaining > 0 ? "warn" : "info",
          `exocortexd: requested stop for ${stoppedBackgroundTasks} managed background task(s)${remaining > 0 ? `; ${remaining} still closing` : ""}`,
        );
      }

      if (!isWindows) {
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
  if (!isWindows) {
    process.on("SIGHUP", () => { void shutdown(0, "SIGHUP"); });
    process.on("SIGQUIT", () => { void shutdown(0, "SIGQUIT"); });
    process.on("SIGUSR1", () => { void shutdown(0, "SIGUSR1"); });
    process.on("SIGUSR2", () => { void shutdown(0, "SIGUSR2"); });
  }
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
  const queuedMessageCount = convStore.loadQueuedMessagesFromDisk();
  // If the daemon crashed after persisting a queued user message but before
  // removing its queue copy, the transcript's durable queueEntryId wins.
  const deliveredQueueIds = new Set<string>();
  for (const queued of convStore.listQueuedMessages()) {
    const conversation = convStore.get(queued.convId);
    if (conversation?.messages.some(message => message.metadata?.queueEntryId === queued.id)) {
      deliveredQueueIds.add(queued.id);
    }
  }
  if (deliveredQueueIds.size > 0) convStore.removeQueuedMessagesById(deliveredQueueIds);
  profileMark("message_queue_loaded", { queuedMessageCount, deduplicated: deliveredQueueIds.size });
  const chronoScheduleCount = await startChronoService();
  profileMark("chrono_started", { scheduleCount: chronoScheduleCount });
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

  // Start stale stream watchdog. Durable scheduling is owned by Chrono.
  startWatchdog();

  // Check auth status
  const authSummary = getProviders()
    .map((provider) => `${provider.id}=${hasConfiguredCredentials(provider.id) ? "✓" : "✗"}`)
    .join(" ");
  profileMark("auth_checked", { authSummary });

  const wt = worktreeName();
  const chronoSchedules = listChronoSchedules();
  const extToolCount = isWindows ? 0 : getExternalToolCount();
  const supervisedCount = isWindows ? 0 : getSupervisedDaemonCount();
  console.log(`\n  exocortexd running (pid ${process.pid})${wt ? ` [worktree: ${wt}]` : ""}`);
  console.log(`  socket: ${SOCKET_PATH}`);
  console.log(`  auth:   ${authSummary || "none configured"}`);
  console.log(`  chrono: ${chronoSchedules.length} durable schedule(s)`);
  console.log(`  tools:  ${extToolCount} external tool(s)${supervisedCount > 0 ? `, ${supervisedCount} supervised daemon(s)` : ""}`);
  console.log(`\n  Waiting for connections...\n`);

  log("info", `exocortexd: ready on ${SOCKET_PATH} (auth=${authSummary}, chrono=${chronoSchedules.length})`);
  profileMark("ready", { chronoSchedules: chronoSchedules.length, externalToolCount: extToolCount, supervisedDaemonCount: supervisedCount });

  const recoveredStreams = recoverInterruptedStreams(server);
  if (recoveredStreams.length > 0) {
    console.log(`  replay: scheduled ${recoveredStreams.length} interrupted conversation(s): ${recoveredStreams.join(", ")}`);
    profileMark("interrupted_streams_recovered", { count: recoveredStreams.length });
  }
  const recoveredGoals = recoverActiveGoals(server, recoveredStreams);
  if (recoveredGoals.length > 0) {
    console.log(`  goals: scheduled ${recoveredGoals.length} active goal continuation(s): ${recoveredGoals.join(", ")}`);
    profileMark("active_goals_recovered", { count: recoveredGoals.length });
  }
  const pendingNotifications = deliverPendingSubagentNotifications(server);
  if (pendingNotifications > 0) {
    console.log(`  subagents: resumed delivery of ${pendingNotifications} parent notification(s)`);
    profileMark("subagent_notifications_recovered", { count: pendingNotifications });
  }
}

// ── Main ────────────────────────────────────────────────────────────

const command = process.argv[2];

async function main(): Promise<void> {
  if (command === "login") {
    try {
      await handleLogin(process.argv[3], process.argv[4]);
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

  if (command === "prepare-restart") {
    try {
      const result = await prepareRestartForReplay();
      if (result.convIds.length > 0) process.stdout.write(`${result.convIds.join("\n")}\n`);
      if (result.stillStreaming.length > 0) {
        console.error(`  ⚠ Still streaming after graceful interrupt timeout: ${result.stillStreaming.join(", ")}; restart will replay from saved history.`);
      }
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  ✗ Failed to prepare restart: ${message}\n`);
      process.exit(1);
    }
  }

  if (command === "prepare-stop") {
    try {
      await prepareStopWithoutReplay();
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  ✗ Failed to prepare stop: ${message}\n`);
      process.exit(1);
    }
  }

  if (command === "cancel-recovery") {
    clearRestartRecoveryForStop();
    return;
  }

  await startDaemon();
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log("error", `exocortexd: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  console.error(`\n  ✗ Failed to start: ${message}\n`);
  process.exit(1);
});
