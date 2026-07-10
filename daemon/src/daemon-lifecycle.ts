/** Process-local lifecycle state shared by shutdown and turn orchestration. */

export type DaemonShutdownMode = "stop" | "restart";

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

export function resolveDaemonShutdownMode(exitCode: number, hasRestartMarker: boolean): DaemonShutdownMode {
  return shutdownMode ?? (exitCode !== 0 || hasRestartMarker ? "restart" : "stop");
}

/** Test-only reset for modules exercised in the same Bun process. */
export function resetDaemonShutdownModeForTest(): void {
  shutdownMode = null;
}
