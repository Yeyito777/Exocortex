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
  HEAD *and* the files changed in between can alter the daemon (see
  [Which changes need a daemon restart](#which-changes-need-a-daemon-restart)).
  This takes precedence and requires no network access.
- **None**: no update or restart is needed.
- **Checking…**: the TUI is still waiting for the endpoint's first status reply.
  This is a display-only pending state, not a daemon status or a failure.
- **Unknown**: status could not be determined (including an older daemon that
  lacks this protocol field, or git timing out on a loaded machine). Unknown
  never implies the daemon is current. A periodic check that comes back
  Unknown keeps the last answer on screen until three in a row (~30 s) do, so
  a busy machine doesn't make the footer flicker; a disconnect shows at once.
- **Disabled**: the checkout is not the primary upstream checkout on `main`.
  Linked worktrees, detached HEADs, forks and development branches don't
  participate. When both endpoints are disabled, the footer stays hidden.

## Which changes need a daemon restart

The daemon only restarts for commits that can change *it*. A TUI-only merge
leaves the daemon on **None** (or **Update available**); the TUI process itself
just needs restarting by the user, and the footer says nothing about it. The
decision lives in `shared/src/restart-impact.ts` and runs over
`git diff --name-only <running> <disk>`:

- Test files (`*.test.ts`, `test/`) never matter.
- Source files (`.ts/.tsx/.js`) matter only if the daemon's import closure
  contains them: every non-test file under `daemon/`, plus whatever they import,
  following `@exocortex/shared/*` through `shared/package.json` exports and
  relative imports. TUI-only files and shared modules the daemon doesn't import
  never flag. For files in the closure, both revisions are run through
  `Bun.Transpiler`; if the output is identical (type-only or comment-only edits,
  such as adding a field to a `TuiConfig` interface) the change is inert.
- Always flagged: `daemon/`, `shared/` and `config/` non-source files,
  `bin/`, `external-tools/`, `helper-tools/`, `scripts/setup/`, and the root
  `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`. Any path not
  recognized also flags. Ignored: `docs/`, `tui/` non-source files,
  `scripts/dev|windows|migrate/`, root markdown/`LICENSE`/`Makefile`.
- Any failure (unknown or garbage-collected revision, git or transpile error,
  unreadable tree) means **Restart needed**, as before, except git timing out
  or failing to start: that check is **Unknown** and the next one tries again.
  Likewise **Disabled** is only an answer about the checkout, never a git
  timeout; if git can't read the running revision at startup, it is retried
  for two minutes.

The baseline stays the daemon's startup revision, so inert commits accumulate
without hiding a later real change. Each revision pair is classified once.
A `bun.lock` change always flags, even if only TUI dependencies moved.

The daemon captures its eligible revision once during startup, not when a TUI
first asks. Restarting it captures the new revision. A daemon predating this
feature must itself be upgraded and restarted before it can report status.

Each daemon keeps its own status ready instead of working it out per request.
From startup it stats `.git/HEAD`, `.git/refs/heads/main`, `.git/packed-refs`
and `.git/config` every 2 seconds (no git process) and classifies the checkout
again only when one of them changed; GitHub is asked again every 120 seconds.
A change is pushed at once as an `update_status` event to every connection that
declared the `update-status-push` capability, and a capable client's `ping`
bootstrap carries the current status ahead of the conversation list. A pull
therefore shows **Restart needed** within about 2 seconds, and a TUI that
connects shows the footer with its first bootstrap instead of after a git run
and a GitHub request. Unknown replaces a known status only after three Unknown
checks in a row, which the daemon retries every 10 seconds, so a pushed status
is shown as is.

The TUI takes the active daemon's pushes and stops polling that route; it
still asks once per route (re)connect, and polls every 10 seconds a daemon that
never pushed (older daemons). Requests don't overlap on a route; late replies
from an old route are discarded. SSH's local status uses a separate, short-lived
local socket connection every 10 seconds, without changing the active route; the
local daemon answers it from its warm status. On `--ssh` startup, a single
local probe starts immediately after connecting, before conversation/bootstrap
work or the SSH handoff; there is no redundant active-local status request.
First paint and SSH readiness never wait for it. A fast SSH host can therefore
show **Remote: None / Local: Checking…** until the local result arrives, but not
a spurious **Local: Unknown**. Local probes survive
SSH route changes/reconnects and are shared rather than duplicated; only active
endpoint replies are scoped to the route generation.

Upstream `main` is read from Git's smart-HTTP ref advertisement, not GitHub's
REST API: the API allows only 60 unauthenticated requests/hour per IP, which a
shared campus/office NAT can exhaust on its own, turning **None** into
**Unknown**. When upstream equals HEAD, or its commit already exists locally
(HEAD contains it, or it was fetched), ancestry decides the status offline. Only
an upstream commit this checkout has never seen falls back to the REST compare
API.

GitHub comparison results, including failed requests, are reused for 120
seconds. A changed checkout is classified again without another GitHub request,
so downloaded updates show **Restart needed** offline too.

The polling request is `ping` with `updateStatusOnly: true`. Updated daemons
respond with a correlated `pong` carrying `updateStatus`, without conversation
or usage bootstrap, from the warm status (a checkout that changed since is
classified first). Normal `ping`/SSH readiness behavior is unchanged. The UI
never pulls code or restarts a daemon automatically.
