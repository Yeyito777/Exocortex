# Network outages

A turn that cannot reach its provider because the network is down does not
fail. It shows `⠋ Waiting for connection… 3m 12s` (yellow, with the time since
it lost the network) and resumes by itself once the network is back. The top
bar shows `⚠ offline` while the daemon finds the network unreachable.

- **Which failures.** DNS failures (`EAI_AGAIN`, `ENOTFOUND`), refused or
  unroutable connections, `fetch failed`, and Claude Code's "Can't reach the
  API server" / "No internet route" errors, from every provider. A dropped or
  timed-out connection (`ECONNRESET`, `ETIMEDOUT`, socket hang up) counts only
  when the connectivity probe fails too. API errors (HTTP statuses, overload,
  rate and usage limits, auth, bad requests, TLS) fail the turn as before.
  Classification: `classifyNetworkFailure` in `daemon/src/providers/errors.ts`.
- **One monitor.** `daemon/src/connectivity.ts` decides whether the network is
  reachable for the whole daemon: it resolves a well-known host (provider API
  hosts first) and opens a TCP connection to port 443; no model is called.
  While offline it probes after 3s, doubling to every 30s, and any provider
  response also counts as being back. Override the probed hosts with
  `EXOCORTEX_CONNECTIVITY_PROBE_HOSTS` (comma-separated).
- **The wait.** `daemon/src/network-wait.ts` wraps each provider request of a
  turn. After a network failure it asks the monitor; if the network is
  unreachable the turn waits for it, then sends the same request again. While
  the monitor already knows the network is down, a new turn (a message, a wake)
  waits before sending anything. If the probe reaches the network but the
  provider still fails at the network level, the turn retries three times and
  then fails as before, so a provider-side problem still surfaces.
- **No repeated work.** The retry is the request that failed, over the same
  messages: rounds the provider completed before the failure are committed and
  are not run again. Claude Code forks its session at the latest committed
  round and is told to continue ([anthropic.md](anthropic.md)); a network
  failure never falls back to replaying the whole history into a new session.
- **Claude Code retrying by itself.** Claude Code retries failed API calls in
  its own loop (for many minutes). Its `api_retry` reports without an HTTP
  status make the daemon probe; if the network is down the turn shows the same
  waiting status until Claude Code's next attempt gets through.
- **Nothing is dropped.** While a turn waits it is still the conversation's
  turn, so Chrono wakes, soft-wake escalations, background-task, subagent and
  external notifications, and messages sent meanwhile queue behind it as
  usual (deduplicated by their queue ids) and run in order once it finishes.
  A queued message from the user still steers: it joins the request that is
  sent when the network returns.
- **Cancel.** Stop (`Ctrl+Q`) ends the wait like any turn (`✗ Interrupted`).
  The message stays in history; `/replay` or editing it sends it again.
- **Restarts.** A waiting turn is an ordinary active turn: a daemon restart
  replays it, and it waits again if the network is still down.

IPC: `connection_wait_status` (per conversation, with `startedAt`; also
`connectionWaitStartedAt` on `streaming_started` snapshots for late joiners)
and `connectivity_status` (daemon-wide; broadcast on change and sent after
`ping`). See `shared/src/protocol.ts`.
