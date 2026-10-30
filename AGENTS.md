# Agent notes

- Never stop an Exocortex daemon with `pkill`, `killall` or a command-line
  pattern (`bun run src/main.ts` also matches the main daemon). Use
  `scripts/dev/testd start|stop <worktree>` or `scripts/dev/exotest`, or kill
  only a PID you recorded yourself. See [docs/dev-daemons.md](docs/dev-daemons.md).
- Never stop the main daemon (`exocortexd-main …`); restart it only through the
  exo tool's restart action.
- Worktree daemons read the main logins and never write or refresh them
  (docs/dev-daemons.md#credentials-in-worktree-daemons). Never point a
  worktree's `config/secrets` back at the main directory.
- Before a merge, run `bun run check` at the repo root (all typechecks and
  test suites in parallel, ~12 s). Not three separate `bun test` and typecheck
  runs. Tests must poll, not sleep, and fail fast; they must pass in parallel
  with every other file. See [docs/testing.md](docs/testing.md).
