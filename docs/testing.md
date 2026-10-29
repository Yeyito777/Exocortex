# Tests

```bash
bun run check                      # everything, ~12 s on whale (12 cores)
bun run check daemon tui           # some steps: typecheck, shared, daemon, tui
bun run check --jobs 4             # workers per suite (default: 2/3 of the cores)
bun run check --update-timings     # also rewrite test/timings/*.json
cd daemon && bun test src/foo.test.ts   # one file
cd daemon && bun test              # one suite, serially (~55 s for the daemon)
```

`scripts/dev/check.ts` runs the three typechecks and the shared, daemon and
TUI suites at the same time. It prints one line per step, then each failure
with its file and test name and the error, and exits 1 on any failure.

## What it does

- **Typechecks are incremental.** Each `tsconfig.json` sets `incremental`, with
  build info in `node_modules/.cache/tsc/` (per checkout). An unchanged
  package checks in a second or two; a cold one takes the full ~9 s.
- **Suites run `bun test --parallel`.** Each test file runs in a fresh global
  in one of N worker processes. Files start slowest first, ordered by
  `test/timings/<suite>.json` (tracked) and by this checkout's last run
  (`node_modules/.cache/exocortex-check/`).
- **Every file has its own config dir.** `test/setup-config.ts` (the preload
  in each `bunfig.toml`) makes a fresh `EXOCORTEX_CONFIG_DIR` per file, and
  refuses the live config. Nothing a test does reaches the main daemon.
- **One temp root per run.** The check points `TMPDIR` at `/tmp/exck-…` and
  removes it at the end, also after a failure, a timeout or Ctrl-C. Plain
  `bun test` sweeps its own leftover config dirs.
- **Nothing hangs.** Each test has bun's 5 s timeout. Each step runs in its own
  session; one still running after `--timeout` (default 300 s) is listed with
  what it was running and killed with all of its processes.

## Writing tests that stay fast

- **Don't sleep on a real timer.** Make the wait injectable and shrink it in
  the test, e.g. `setOpenAIWaitsForTest`, `setRelayHelloTimeoutsForTest`,
  `setClientExecLivenessForTest`, or freeze the clock with `setSystemTime`.
- **Poll for the outcome, with a bound.** `for (… i < N && !done(); …) await
  Bun.sleep(10)` returns as soon as the work is done and fails if it never
  is. A fixed `sleep(100)` before an assert is slow when it passes and flaky
  under load.
- **Never race two things.** Gate the slower side on something the test
  controls (a file, a promise), as in `tools/bash-backgrounding.test.ts`.
- **Assume other files run at the same time.** Use `tmpdir()` and
  `mkdtemp`, never fixed paths, ports or checkout directories (point
  `EXOCORTEX_TEST_EXTERNAL_TOOLS_DIR` at a temp dir to add external tools).
  Restore any module or `process.env` state you change; plain `bun test`
  runs every file in one global.
- **Keep files short in time.** A file runs on one worker, so the slowest
  file sets the floor for its suite. Split one that grows past a few seconds,
  as `tools/bash.test.ts` was.
- **Kill what you spawn.** Kill process groups, not just the leader, and give
  `spawnSync` a `timeout`.
