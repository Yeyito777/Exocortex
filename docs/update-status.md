# Update status footer

The sidebar uses the active theme's accent for actionable update statuses. Its
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
- **Unknown**: status could not be determined (including an older daemon that
  lacks this protocol field). Unknown never implies the daemon is current.
- **Disabled**: the checkout is not the primary upstream checkout on `main`.
  Linked worktrees, detached HEADs, forks and development branches don't
  participate. When both endpoints are disabled, the footer stays hidden.

The daemon captures its eligible revision once during startup, not when a TUI
first asks. Restarting it captures the new revision. A daemon predating this
feature must itself be upgraded and restarted before it can report status.

The TUI checks asynchronously at startup, every 120 seconds, and after route
changes/reconnects. Requests don't overlap on a route; late replies from an old
route are discarded. SSH's local status uses a separate, short-lived local
socket connection, without changing the active route.

The wire request is `ping` with `updateStatusOnly: true`. Updated daemons respond
with a correlated `pong` carrying `updateStatus`, without conversation or usage
bootstrap. Normal `ping`/SSH readiness behavior is unchanged. The UI never pulls
code or restarts a daemon automatically.
