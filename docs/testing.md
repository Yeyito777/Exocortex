# Tests

```bash
bun run check                      # everything, ~15 s on whale (12 cores), more when it's busy
bun run check --changed            # only what this branch's changes can reach
bun run check daemon tui           # some steps: typecheck, shared, daemon, tui
scripts/dev/test-select.ts --explain FILE   # which change picked FILE, and through what
bun run check --jobs 4             # workers per suite (default: 7/6 of the cores for the daemon, half for the others)
bun run typecheck                  # the three typechecks with tsc
bun run check --update-timings     # also rewrite test/timings/*.json
cd daemon && bun test src/foo.test.ts   # one file
cd daemon && bun test              # one suite, serially (~55 s for the daemon)
```

`scripts/dev/check.ts` runs the three typechecks and the shared, daemon and
TUI suites at the same time. It prints one line per step, then each failure
with its file and test name and the error, and exits 1 on any failure.

While iterating, run `bun run check --changed`; before merging, run the full
`bun run check`.

## What it does

- **Typechecks use tsgo and are incremental.** tsgo is TypeScript's native
  compiler (`@typescript/native-preview`, pinned in `package.json`). Each
  `tsconfig.json` sets `incremental`; the check keeps tsgo's build info in
  `node_modules/.cache/tsgo/` (per checkout), beside tsc's. A warm daemon
  typecheck takes ~1.7 s (tsc ~6 s), a cold one ~5 s (tsc ~28 s).
  `bun run typecheck` still runs tsc. If the two ever disagree on a real
  error, note it here.
- **Suites run `bun test --parallel`.** Each test file runs in a fresh global
  in one of N worker processes. Files start slowest first, ordered by
  `test/timings/<suite>.json` (tracked) and by this checkout's last run
  (`node_modules/.cache/exocortex-check/`). `FIRST_IN_FRESH_WORKER` in check.ts starts
  `tui/src/updatecheck.test.ts` first in a fresh worker: after other files,
  bun 1.4.2 can wedge its worker for good
  (`scripts/dev/repro/bun-isolate-hang.sh`; it hit other files too, and
  bun 1.4.4 doesn't hang).
- **Every file has its own config dir.** `test/setup-config.ts` (the preload
  in each `bunfig.toml`) makes a fresh `EXOCORTEX_CONFIG_DIR` per file, and
  refuses the live config. Nothing a test does reaches the main daemon. It
  also points `CLAUDE_CODE_BIN` at a missing file, so no test runs the real
  Claude Code CLI or uses the user's Claude login.
- **One temp root per run.** The check points `TMPDIR` at `/tmp/exck-…` and
  removes it at the end, also after a failure, a timeout or Ctrl-C. Plain
  `bun test` sweeps its own leftover config dirs.
- **A larger CPU share.** On Linux the check reruns itself in a transient
  systemd scope with `CPUWeight=1000`. Every other user unit has 100 whatever
  its nice level, so a niced replay unit would otherwise take as much CPU as
  the check. It only matters while the CPU is contended. Without
  `systemd-run` or a user manager the check runs in place, as with
  `EXOCORTEX_CHECK_SCOPE=off`. When the check ends, anything left in its scope
  is killed, and it stops if the process that started it dies.
- **`--changed` picks by what the change reaches.** `scripts/dev/test-select.ts`
  follows each test file's imports and the files its code names in strings
  (an entry point it spawns, a prompt it reads) to the files changed since
  the branch left `origin/main`, uncommitted and untracked ones included
  (`--base REF` for another base). Typechecks run for the packages whose code
  changed and the packages that import from them. It runs everything, and
  says why, for package, lock, bunfig or tsconfig files, `test/`, the check
  scripts, a file deleted or renamed in a package, or a package file no code
  names. Files outside the packages that no code names (docs) pick nothing.
- **Nothing hangs.** Each test has bun's 5 s timeout. Each step runs in its own
  session; one still running after `--timeout` (default 90 s) is listed with
  what it was running and killed with all of its processes.

## Writing tests that stay fast

- **Don't sleep on a real timer.** Make the wait injectable and shrink it in
  the test, e.g. `setOpenAIWaitsForTest`, `setRelayHelloTimeoutsForTest`,
  `setClientExecLivenessForTest`, `setQueuePumpDelayForTest` (the daemon
  queue's readiness poll), `setUsageLimitRetryFloorForTest`,
  `setExternalToolsDebounceForTest`, or freeze the clock with `setSystemTime`.
  Restore the default after the test, and keep a test on the real value where
  the timing itself is what's tested.
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
