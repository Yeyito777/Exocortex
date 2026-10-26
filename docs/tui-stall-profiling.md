# TUI stall profiling

How to measure whether the TUI's main thread freezes, and on what, instead of
guessing from symptoms.

## The stall profiler

`EXOCORTEX_PROFILE_STALLS=FILE` makes a TUI write, on exit, every stretch its
event loop was blocked for 16 ms or more (a 2 ms interval that fired late),
every labelled span of 8 ms or more (`wire`: a socket read and the events it
carried, `event:<type>`, `render`, `input`), and a mark per presented frame
(`frame <conv> msgs=N off=M`, or `held` when render presented nothing) and per
input. Off, it costs one function call per event, frame and input
([stallprofile.ts](../tui/src/stallprofile.ts)).

## The harness

[`scripts/dev/tui-stall-profile.ts`](../scripts/dev/tui-stall-profile.ts) runs
a real TUI in a pseudo-terminal, scripts mouse/keyboard bytes at given times,
and prints the longest stalls, the busiest spans and (with `--marks`) the
frame timeline:

```bash
scripts/dev/testd start <worktree>           # or a read-only tap, below
bun scripts/dev/tui-stall-profile.ts --ssh --st --focus CONV \
  --keys "$(printf '\e[<0;10;4M' | od -An -tx1 | tr -d ' \n')@3000" --seconds 8 --marks
```

- `--ssh` goes through `ssh-wan-sim.ts` (100 ms RTT by default); `--real-ssh
  ALIAS` uses real OpenSSH, and `--remote-command CMD` replaces the remote
  `exocortexd proxy`. It runs on macOS too (a small python3 pty relay replaces
  BSD `script`, which refuses a non-terminal stdin).
- `--st` answers the terminal queries the way the owner's st does (Kitty
  graphics, cell size, smooth scroll and image clip regions), so image and
  smooth-scroll paths run as on the Mac; `--save-output FILE` keeps what the
  TUI wrote to the terminal.
- `--scroll CONV=0.5` gives conversations a saved reading position.
- `--tui-prefix 'systemd-run --user --scope -q --unit=NAME'` puts the TUI alone
  in a cgroup; writing its `memory.high` pushes its heap to swap, to see what a
  swapped-out TUI costs (the Mac's situation below).
- `--cpu-prof DIR`, `--heap-prof DIR`: Bun's markdown profiles of the TUI.

`vmmap` on macOS suspends the process it inspects for 0.5-1 s: snapshotting a
measured TUI's memory shows up as an unlabelled stall of that size.

## Watching a real daemon read-only

[`scripts/dev/readonly-daemon-tap.ts`](../scripts/dev/readonly-daemon-tap.ts)
stands in for `exocortexd proxy` and forwards only read-only commands (loads,
history, tool outputs, images, accounts, subscribe), strips `clientHost`
(so client_bash is never routed to the measured TUI) and drops client_exec
events. With it, a measured TUI sees the main daemon's live streams, tasks and
full sidebar without being able to send, queue, abort or edit anything:

```bash
WAN_PROXY_ENTRY=$PWD/scripts/dev/readonly-daemon-tap.ts TAP_SOCKET=/path/to/main/exocortexd.sock \
  bun scripts/dev/tui-stall-profile.ts --ssh --st --focus CONV ...
```

## What it found (Oct 26 2026)

The owner reported a small freeze opening the busy paramount conversation over
`/ssh` from the Mac. Measured:

- The TUI's own work on that open is small: the longest block is 20-40 ms on
  whale and on the Mac (bun 1.3.14 and 1.4.2), at startup, on a sidebar
  switch, after scrolling back, opening it unread or while it streams. A
  25-minute live run watching it stream blocked 124 ms in total, 45 ms at most.
  The click paints "Loading conversation…" at once; the page lands one round
  trip later (~200 ms on the real link) and its backfill one more.
- What does freeze: the Mac was at 18 GB of 19.5 GB swap with ~62 GB of pages
  in the compressor, and had swapped out about two thirds of the owner's
  long-running TUI (85 MB of ~125 MB) and 89 MB of st. Pushing a TUI's heap to
  swap on whale (`--tui-prefix` + `memory.high`) makes the next click block
  150-230 ms while it pages back in; a fresh probe never sees it.
