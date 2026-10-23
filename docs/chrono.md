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

## Unit waits

`task_id: "unit:NAME"` waits on a systemd user unit, e.g. a `systemd-run --user`
job or a `pmtool ... --background` batch (`pm5-batch-LABEL`). The daemon polls
`systemctl --user show` every 2 s (argv only; the name is validated) until the
unit leaves its running states, then reports `unit`, `active_state`, `result`
and `exit_code`/`signal`. A `--collect` unit is unloaded when it stops, so its
result comes from the user journal (`active_state: "unloaded"`; no logged
failure means success). Suspended unit waits share the wait record and
re-attach on boot like task waits; a unit collected while the daemon was down
resolves from the journal. A unit with neither a loaded state nor a journal
record is `Unit not found`. Off Linux the target fails with a clear error.
Implementation: `daemon/src/systemd-unit-wait.ts`, `daemon/src/chrono-wait-targets.ts`.

## Background tasks end sleeps

A plain `sleep`, connected or suspended, ends early when one of its own
conversation's background tasks (daemon Bash/exec sessions or Claude Code
tasks) leaves the task catalog: `Sleep ended after X because background task
ID finished ...`. Other conversations' tasks never wake it; a `wait` stays
bound to its exact target. A suspended sleep persists the wake before replay.

## Batch wakes

`wake` takes either one wake as top-level fields or a `wakes` array of up to
50 items, each with exactly the fields a single wake accepts. The two forms do
not mix: top-level wake fields alongside `wakes` are rejected, so no field is
silently shared or overridden. Every item is validated against one shared
"now" before any is created; any invalid item schedules nothing and the error
names each bad `wakes[i]`. Output is `Scheduled N of M Chrono wakes:` with one
line per item, and the call errors only when nothing was scheduled. A one-item
array reads exactly like the single form.

## `/chrono`

Users schedule wakes without asking the model: `/chrono 30m <message>`,
`/chrono tomorrow 9am <message>`, `/chrono every weekday at 8:30 <message>`,
`/chrono [list]`, `/chrono cancel <id|all>`. A leading `!` makes the payload a
shell soft wake. The TUI parses times in its own timezone and sends the
daemon's `chrono` command an exact instant plus that timezone for calendar
repeats. Schedules are ordinary ones owned by the open conversation, so the
model can list and cancel them too.

Implementation: `tui/src/chronoschedule.ts`, `tui/src/commands/chrono.ts`, and
`daemon/src/chrono-commands.ts`.

## Tasks row

Each schedule is one row in its owner's Tasks panel. While an occurrence is
pending the row stands for it: `due`, then `Running: <title>` with elapsed time
for a command soft-wake. Afterwards it counts down to the next occurrence; a
finished one-shot leaves. Firing never adds a sibling row or removes and
re-adds the schedule's row, so a run does not resize the panel or reflow the
history beside it.

The panel shows one row per entry with its title truncated, and caps its
height (`▸ N more · click to expand`). Clicking it expands it to list every
entry in the same rows. A tall expanded panel scrolls with the wheel inside
it. Clicking it again collapses it, and so does opening another
conversation. The expansion lasts only for the TUI session.

Implementation: `publishSchedule` in `daemon/src/chrono-service.ts` and
`tui/src/activitypanel.ts`.
