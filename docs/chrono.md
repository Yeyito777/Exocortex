# Chrono suspension

`sleep.duration` and `wait.max_wait` use the same five-minute cutoff.
Above it, a sole Chrono call suspends the provider turn, destroys its transport,
and leaves a daemon-owned durable record. The sidebar shows the same yellow
in-progress indicator for both. Exactly five minutes and shorter stay connected.

A suspended wait replays immediately on target completion, preserving the normal
wait result (including exit status and output path), or returns
`wait_limit_reached` at its deadline. A user message interrupts the wait; Stop
closes it without replay. Neither stops the target task. Already-completed and
invalid targets return inline without suspension.

The scheduler retains the legacy `sleeps` state-file key for upgrade compatibility.
Wait records add target details and persist completion evidence before replay.
On boot, subscriptions start after background/subagent task recovery; a target
that cannot be recovered closes the wait with a tool error.

Implementation: `daemon/src/tools/chrono.ts`, `daemon/src/chrono-service.ts`,
and `tui/src/taskvisibility.ts`.
