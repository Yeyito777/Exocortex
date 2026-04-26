import type { ManifestShell } from "./external-tools-shell";

export interface ManifestDaemon {
  /** Shell command to run from the tool directory (executed via `bash -lc`). */
  command: string;
  /**
   * When to restart the daemon after it exits.
   *   "on-failure" (default) — restart only on non-zero exit code
   *   "always"               — restart on any exit
   *   "never"                — don't restart
   */
  restart?: "on-failure" | "always" | "never";
  /** Additional environment variables merged into the process env. */
  env?: Record<string, string>;
}

export interface Manifest {
  name: string;
  bin: string;
  systemHint: string;
  display: {
    label: string;
    color: string;
  };
  /** Optional shell invocation hints for the bash harness. */
  shell?: ManifestShell;
  /** Optional long-running daemon that exocortexd will spawn and supervise. */
  daemon?: ManifestDaemon;
}

export interface LoadedTool {
  manifest: Manifest;
  /** Absolute path to the directory containing the binary. */
  binDir: string;
  /** Absolute path to the tool's root directory. */
  toolDir: string;
}

export type ExternalToolDaemonAction = "start" | "stop" | "restart" | "status";

export interface ExternalToolDaemonStatus {
  toolName: string;
  action: ExternalToolDaemonAction;
  configured: boolean;
  managed: boolean;
  running: boolean;
  pid: number | null;
  restartPolicy: Exclude<ManifestDaemon["restart"], undefined> | null;
  message: string;
}
