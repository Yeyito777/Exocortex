# Agent notes

- Never stop an Exocortex daemon with `pkill`, `killall` or a command-line
  pattern (`bun run src/main.ts` also matches the main daemon). Use
  `scripts/dev/testd start|stop <worktree>` or `scripts/dev/exotest`, or kill
  only a PID you recorded yourself. See [docs/dev-daemons.md](docs/dev-daemons.md).
- Never stop the main daemon (`exocortexd-main …`); restart it only through the
  exo tool's restart action.
