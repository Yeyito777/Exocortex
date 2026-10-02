# Update status footer

The sidebar uses the active theme's accent for actionable update statuses. Its
Remote/Local labels use the same muted color as statusline labels. The
horizontal footer separator remains muted regardless of sidebar focus; the
right border continues the sidebar's focus accent through the footer.
Search and editing bars temporarily take precedence on the same rows.

On the local route, the footer is hidden unless an update or restart is needed.
On `/ssh <alias>`, the entire footer is hidden when both statuses are **None**.
Otherwise, it shows two independent lines, in this order:

```
Remote: Restart needed
Local: None
```

- **Update available**: GitHub's upstream `main` is ahead of disk HEAD.
- **Restart needed**: the running daemon's startup revision differs from disk
  HEAD. This takes precedence and requires no network access.
- **None**: no update or restart is needed.
- **Checking…**: the TUI is still waiting for the endpoint's first status reply.
  This is a display-only pending state, not a daemon status or a failure.
- **Unknown**: status could not be determined (including an older daemon that
  lacks this protocol field). Unknown never implies the daemon is current.
- **Disabled**: the checkout is not the primary upstream checkout on `main`.
  Linked worktrees, detached HEADs, forks and development branches don't
  participate. When both endpoints are disabled, the footer stays hidden.

The daemon captures its eligible revision once during startup, not when a TUI
first asks. Restarting it captures the new revision. A daemon predating this
feature must itself be upgraded and restarted before it can report status.

The TUI checks daemon/restart status asynchronously at startup, every 10 seconds, and after route
changes/reconnects. Requests don't overlap on a route; late replies from an old
route are discarded. SSH's local status uses a separate, short-lived local
socket connection, without changing the active route. On `--ssh` startup, a single
local probe starts immediately after connecting, before conversation/bootstrap
work or the SSH handoff; there is no redundant active-local status request.
First paint and SSH readiness never wait for it. A fast SSH host can therefore
show **Remote: None / Local: Checking…** until the local result arrives, but not
a spurious **Local: Unknown**. Local probes survive
SSH route changes/reconnects and are shared rather than duplicated; only active
endpoint replies are scoped to the route generation.

Each daemon caches GitHub comparison results for 120 seconds across all clients,
including failed requests. Disk revision checks bypass that cache, so downloaded
updates show **Restart needed** on the next fast status check without another
GitHub request.

The wire request is `ping` with `updateStatusOnly: true`. Updated daemons respond
with a correlated `pong` carrying `updateStatus`, without conversation or usage
bootstrap. Normal `ping`/SSH readiness behavior is unchanged. The UI never pulls
code or restarts a daemon automatically.
