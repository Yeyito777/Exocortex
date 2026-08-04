/**
 * Windows compiled entry point.
 *
 * The Bash/PowerShell tool uses a separate process so command output cannot
 * starve the daemon socket. A compiled executable cannot launch the original
 * TypeScript runner by path, so it re-enters this executable with a private
 * mode and loads only the isolated runner.
 */
if (process.argv[2] === "__exocortex_bash_runner") {
  await import("./tools/bash-runner");
} else {
  await import("./main");
}

export {};
