/** Process-local lifecycle state shared by shutdown and turn orchestration. */

export type DaemonShutdownMode = "stop" | "restart";

/** Exit status consumed by systemd and the exotest supervisor as a restart request. */
export const DAEMON_RESTART_EXIT_CODE = 75;

let shutdownMode: DaemonShutdownMode | null = null;

export function beginDaemonShutdown(mode: DaemonShutdownMode): DaemonShutdownMode {
  // An explicit stop is allowed to cancel stale/partially prepared restart
  // intent; once stopping, later fatal/signal inference must not re-enable it.
  if (shutdownMode === null || mode === "stop") shutdownMode = mode;
  return shutdownMode;
}

export function getDaemonShutdownMode(): DaemonShutdownMode | null {
  return shutdownMode;
}

/**
 * Only `exocortexd stop` stops for real: it selects "stop" over IPC and leaves
 * a fresh stop request for the signal that follows. Every other exit (a direct
 * `systemctl stop`, a reboot, a stray kill, a crash) is a restart, so the next
 * start replays the turns it interrupted.
 */
export function resolveDaemonShutdownMode(stopRequested: boolean): DaemonShutdownMode {
  return shutdownMode ?? (stopRequested ? "stop" : "restart");
}

/** Test-only reset for modules exercised in the same Bun process. */
export function resetDaemonShutdownModeForTest(): void {
  shutdownMode = null;
}
