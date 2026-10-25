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
scripts/dev/testd stop <worktree>     # SIGTERM to the PID it recorded
scripts/dev/exotest <worktree>        # daemon + TUI; stops its daemon on exit
```

`testd stop` signals the PID in the worktree's
`config/runtime/<worktree>/exocortexd.pid`, and refuses when that PID is the
main daemon's or isn't this worktree's daemon (by label, or by its working
directory for an unlabelled one). In your own harnesses, keep the PID you
spawned (`$!`, `child.pid`) and kill that.

## If the main daemon is stopped by mistake

On Linux the unit is `Restart=always`: any exit other than `exocortexd stop`
(which is `systemctl stop`) or exit 78 brings it back within 2 s. A stray
SIGTERM is still a clean stop, so its running conversations are not replayed.
After pulling this change, rewrite the unit with `make service`; it reloads
systemd without restarting a running daemon. The new label shows from the
daemon's next restart.
