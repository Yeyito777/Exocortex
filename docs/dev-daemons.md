# Test daemons and the main daemon

Every daemon is a `bun … daemon/src/main.ts` process, so a pattern kill aimed
at a test daemon can hit the main one. On Oct 25 2026 an agent cleaning up its
worktree daemon with `pkill -f "bun run src/main.ts$"` stopped the main daemon
and every running conversation with it.

**Never stop a daemon with `pkill`, `killall` or any command-line pattern.**
Stop only a PID you recorded, or use `scripts/dev/testd stop <worktree>`.

## Labels

`scripts/setup/run-daemon.sh` (the systemd unit and the macOS launcher run it)
and the dev scripts label each daemon in its command line:

| Daemon | Command line |
|---|---|
| Main (primary checkout) | `exocortexd-main run /…/daemon/src/main.ts --instance main` |
| Worktree (`exotest`, `testd`, `run-daemon.sh` in a worktree) | `exocortexd-test:<worktree> run /…/.worktrees/<worktree>/daemon/src/main.ts --instance <worktree>` |

`bun run src/main.ts` typed by hand is unlabelled; it is still yours to stop by
its PID.

## Starting and stopping a worktree daemon

```bash
scripts/dev/testd start <worktree>    # background daemon, prints pid + socket
scripts/dev/testd status <worktree>
scripts/dev/testd stop <worktree>     # a real stop of the PID it recorded
scripts/dev/exotest <worktree>        # daemon + TUI; stops its daemon on exit
```

`testd stop` signals the PID in the worktree's
`config/runtime/<worktree>/exocortexd.pid`, and refuses when that PID is the
main daemon's or isn't this worktree's daemon (by label, or by its working
directory for an unlabelled one). In your own harnesses, keep the PID you
spawned (`$!`, `child.pid`) and kill that.

## Credentials in worktree daemons

A worktree daemon uses the main checkout's logins but never changes them.
`create-worktree`, `testd` and `exotest` give the worktree a
`config/secrets/` directory of symlinks to the main checkout's files, marked
by `.borrowed-from-main` (older worktrees linked the whole directory; the
next of those commands converts them). Such a daemon (`daemon/src/store.ts`):

- reads the main credentials live, so the owner's logins work in tests;
- keeps every credential change it makes (a `/login`, a key check that
  saves, a logout) in its own memory, gone when it stops; a change gives
  way as soon as the main daemon changes that login;
- never refreshes the shared ChatGPT login: OpenAI replaces the refresh
  token on every refresh, and replaying an old one can revoke the login, so
  a refresh from a test would sign the main daemon out. When the shared
  access token has expired, OpenAI turns on a test daemon fail until the
  main daemon next uses OpenAI and refreshes it.

Even code that predates this cannot reach the main files: an atomic save
replaces the symlink inside the worktree, which the next `testd`/`exotest`
start restores. Old daemon code can still refresh the shared ChatGPT login,
though, so merge main into an old worktree before running its daemon against
real logins.

A test that must not touch real accounts at all (a fake provider, fake keys)
replaces `config/secrets/` with its own directory without the marker; the
scripts leave such a directory alone. Claude Code's own logins (`~/.claude*`)
are Claude Code's and are not part of this store.

## If the main daemon is stopped by mistake

On Linux the unit is `Restart=always`: any exit other than `exocortexd stop`
(which is `systemctl stop`) or exit 78 brings it back within 2 s; on macOS a
stray kill exits 75, which launchd relaunches. Only `exocortexd stop` (and
`testd stop`) stops without replay: it leaves a stop request in the runtime
directory for the signal that follows. Every other exit replays the turns it
interrupted on the next start, including SIGKILL, through the live-turns
journal (`config/runtime/live-turns.json`).
After pulling this change, rewrite the unit with `make service`; it reloads
systemd without restarting a running daemon. The new label shows from the
daemon's next restart.
