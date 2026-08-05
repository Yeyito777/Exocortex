/**
 * Windows compiled entry point.
 *
 * Isolated tool runners keep command output and filesystem traversal from
 * starving the daemon socket. A compiled executable cannot launch the original
 * TypeScript runner by path, so it re-enters this executable with a private
 * mode and loads only the requested runner.
 */
if (process.argv[2] === "__exocortex_bash_runner") {
  await import("./tools/bash-runner");
} else if (process.argv[2] === "__exocortex_glob_runner") {
  await import("./tools/glob-runner");
} else {
  await import("./main");
}

export {};
