import { spawn } from "child_process";
import { basename, join } from "path";

/** Shared launch policy for both shell tool surfaces. Detached work must not
 * remain in the main daemon's systemd control group on Linux. */
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
