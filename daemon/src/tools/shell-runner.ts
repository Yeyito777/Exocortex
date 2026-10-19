import { spawn } from "child_process";
import { mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { basename, join } from "path";
import { runtimeDir } from "@exocortex/shared/paths";

/** Shared launch policy for both shell tool surfaces. Detached work must not
 * remain in the main daemon's systemd control group on Linux.
 *
 * Environment contract for every caller (legacy Bash and Codex exec alike):
 * pass the daemon's configured environment plus invocation overrides BOTH here
 * and in the runner's `start.env` protocol field. Under systemd, options.env is
 * the environment of the systemd-run client, NOT the launched service. Omitting
 * start.env silently loses external-tool PATH entries, Git/auth configuration,
 * and Exocortex routing variables even if direct-spawn tests pass.
 * Send that environment only through the private stdin protocol, not command
 * arguments or logs: it can contain credentials.
 */
export function spawnShellRunner(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  executionId: string;
  runnerPathOverride?: string | null;
}) {
  const windows = process.platform === "win32";
  const compiledWindows = windows && !/^bun(?:\.exe)?$/i.test(basename(process.execPath));
  const args = compiledWindows && !options.runnerPathOverride
    ? ["__exocortex_bash_runner"]
    : [options.runnerPathOverride ?? join(import.meta.dir, "bash-runner.ts")];
  const transient = process.platform === "linux" && Boolean(process.env.INVOCATION_ID)
    && process.env.EXOCORTEX_DISABLE_TRANSIENT_BASH_UNITS !== "1" && !options.runnerPathOverride;
  return spawn(transient ? "systemd-run" : process.execPath, transient ? [
    "--user", "--quiet", "--collect", "--pipe", `--unit=exocortex-bash-${process.pid}-${options.executionId}`,
    process.execPath, ...args,
  ] : args, {
    cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: windows,
  });
}

/** Untouched for this long, a capture file belongs to nothing still running. */
const TOOL_OUTPUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let toolOutputSwept = false;

/**
 * Where shell tools capture command output: on disk under the runtime
 * directory, not /tmp, which is RAM-backed (tmpfs) on Linux. Files untouched
 * for a week are removed the first time a process asks.
 */
export function toolOutputPath(prefix: string, id: string): string {
  const dir = join(runtimeDir(), "tool-output");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!toolOutputSwept) {
    toolOutputSwept = true;
    const cutoff = Date.now() - TOOL_OUTPUT_MAX_AGE_MS;
    try {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        try { if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true }); } catch { /* raced */ }
      }
    } catch { /* best effort */ }
  }
  return join(dir, `${prefix}-${process.pid}-${id}.tmp`);
}
