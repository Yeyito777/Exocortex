# /proxy: use another machine's provider login

`/proxy <provider> <ssh-alias>` sends one provider's model requests through the
Exocortex daemon on another machine, which adds its own login. Everything else
stays local: conversations are stored here, tools run here, files are read and
written here. Typical use: a laptop borrows a desktop's Claude or ChatGPT
subscription without logging in on the laptop. Supported providers: `openai`
and `anthropic`.

Compare `/ssh`, which moves the whole TUI to the other daemon.

```
 laptop daemon                                            remote daemon (whale)
 ─────────────                                            ─────────────────────
 Claude Code CLI ─┐  ANTHROPIC_BASE_URL                  ┌─ ProviderProxyEndpoint
 OpenAI client ───┤  http://127.0.0.1:<port>/<provider>  │   allowlist check
                  ▼  bearer = forwarder secret           │   drop client auth/cookies
           loopback forwarder ── ProviderProxyLink ──────┤   add whale's credentials
                                 one per alias:          │   (Claude Code OAuth /
                                 ssh -T whale             │    OpenAI session)
                                   exocortexd proxy ─────┘        │
                                 (JSON lines, streams              ▼
                                  multiplexed, base64)   api.anthropic.com / chatgpt.com
```

## Using it

| Command | Effect |
|---|---|
| `/proxy anthropic whale` | Check that `whale` is reachable, runs a daemon with `/proxy`, and is logged in to Anthropic; then route Anthropic there. |
| `/proxy openai off` | Use this machine's own OpenAI login again. |
| `/proxy` | List proxied providers and their link state. |

The setting is saved in `config/config.json` as
`providers.<provider>.proxy.ssh` and restored when the daemon starts, so a
proxied provider never silently falls back to a local login. While the
current provider is proxied, its 5-hour/weekly bars are the remote's, and a
link that is down or connecting, or a remote that is not logged in, shows
beside them (`/proxy whale down` and the reason); `/proxy` lists the full
reasons. The provider's account info is the remote account, and `/login`,
`/logout` and `/account` for that provider explain that the login lives on
the remote.

For Anthropic, a remote with several [Claude accounts](claude-accounts.md)
routes proxied turns across all of them with the same rules as its own
conversations (cache-warm stickiness, soonest reset first above the floors,
limited and blocked accounts skipped; see "Which account runs a turn" there),
and shares its pool: the bars are its combined bars (`137/200%`, the two
soonest resets) and `/accounts` (`g a`) shows its accounts, their usage, where
new work goes and the account this conversation is on, live, with the note
"accounts on <alias> (/proxy)", or "/proxy <alias> down: <reason>" while the
link is down. A move to another account is announced in the conversation.

The alias is an OpenSSH host alias, resolved by the daemon's own `ssh` (same
flags as `/ssh`: `BatchMode=yes`, keepalives, `ControlPath=none`). The daemon
runs `ssh` non-interactively, so the key must not need a prompt (on macOS:
`ssh-add --apple-use-keychain`). Anthropic still runs the Claude Code CLI
locally (it is the agent loop), so it must be installed here, but it does not
need to be signed in.

Not carried: external tools that borrow the OpenAI login (`image`,
`transcribe`); they say so. Hold-to-talk transcription is carried.

### API keys

`/proxy openai` lends a ChatGPT login only; a remote logged in with just an
OpenAI API key refuses it and says to log in with the key here instead
(`/login openai key <api-key>`). This is by design, not a gap:

- /proxy exists because a ChatGPT session cannot be shared: it is a
  per-device OAuth login whose refresh token rotates, so two machines holding
  it would invalidate each other. An API key is a static secret any machine
  can use directly, with the same billing and models.
- The link is built for the ChatGPT backend: one upstream origin
  (chatgpt.com), an allowlist of its Codex paths, and the Codex wire format
  (websocket, Codex headers). An API key needs a different origin, paths and
  request shape, so forwarding it would mean a second dialect through the
  link and both daemons agreeing which one is in use, to save one login.

## remote_bash and client_bash over the link

The link carries shell commands both ways, always on while it is up; no TUI
is involved.

While a conversation's provider is proxied, its model also gets `remote_bash`
(Claude Code: `mcp__exocortex__remote_bash`), which runs on the machine whose
login the conversation borrows, over the same SSH link, as the remote daemon's
user (the SSH user), with the same timeout, working-directory and 1 MB output
rules as `client_bash`.

- Offered only while the conversation's provider is proxied; switching the
  conversation to another provider or turning the proxy off removes it.
- Refused at once while the link is down, with the reason.
- The tool description and a model-only turn notice name the alias; a notice
  withdraws it when the proxy goes away.
- A call may name the machine by its alias (`host`). While providers go
  through two different machines, every call must; a call without `host` runs
  only on the machine the conversation's notice named.
- Subagents get it like their parents.

The other way round, the linking daemon's hello names its own machine
(`clientHost`), and the remote's conversations run `client_bash` there over the
link (`provider_proxy_client_exec`), as the linking daemon's user with its
environment. So with the laptop proxied to whale, whale's conversations reach
the laptop whenever its daemon is linked, with or without a TUI. A TUI from the
same machine connected over `/ssh` is the fallback while the link is down.
A lost link stops the commands it started. With several machines linked, each
`client_bash` call names its machine by client ID (README, "client_bash").

Both directions acknowledge each command at once and report it alive every
10 s while it runs (`provider_proxy_exec_alive`, `provider_proxy_client_exec_alive`;
TUIs `client_exec_alive`). A call that is not acknowledged within 15 s, or goes
45 s without word, fails with "did not respond" / "stopped responding" instead
of waiting out its timeout: a frozen daemon or TUI, a sleeping machine, or a
half-dead connection. Older peers without these messages are waited on as
before. End-to-end test: `bun scripts/dev/client-exec-e2e.ts`.

## Behavior when things go wrong

- **Link drops mid-turn:** every request in flight fails at once, like a
  dropped network connection. Claude Code and the OpenAI client then retry as
  they would for a network error, and the link reconnects with backoff (1s up
  to 60s). Nothing hangs: SSH keepalives detect a dead peer in ~45s.
- **Link stuck without dropping:** a TCP connection can collapse (heavy
  retransmits on a lossy network) and carry a few KB/s while a fresh one runs
  at full speed. SSH keepalives still pass, because whatever the remote sends
  resets them, so requests just queue behind it (Oct 27 2026: the Mac's link
  to whale crawled at ~4 KB/s with 7 MB retransmitted, and every proxied turn
  sat pending). The link pings a `link-ping` remote every 15s and writes to
  ssh in 256 KB slices to see how fast ssh takes them; a ping unanswered (or a
  backlog not taken) for 45s while under 1 MB moved either way drops the
  connection (`The SSH connection to whale stalled (…); reconnecting.`) and
  handles it like a dropped one. A busy link (a large request going out, a long
  answer coming in) keeps moving and is not a stuck one. A remote without
  `link-ping` is not pinged; only its backlog is watched.
- **Link down for a while (Wi-Fi drop, DNS failure, ssh exit 255, the remote
  daemon restarting):** the forwarder holds a request and retries the link
  (2s, 5s, then every 10s) for up to 45s, so a short blip is only latency; a
  link lost before the answer started is sent again. Past the hold it answers
  `503 Exocortex /proxy (link down): <reason>` with `x-should-retry: false`,
  so Claude Code does not retry by itself, and the turn waits instead
  (`daemon/src/proxy-link-wait.ts`): the conversation shows "Waiting for
  network / <alias>…" (yellow, like a usage-limit wait), tries the link after
  2s, 5s, 10s, 30s and then every 60s, and resends the same request once it
  is up. Rounds already committed are not run again and the message is not
  duplicated. Stop cancels the wait. It gives up after
  `agent.proxyOutageWaitMinutes` in `config/config.json` (default 30).
  Failures that will not clear up by themselves fail at once with their
  reason: SSH authentication or host-key errors, no `exocortexd` on the
  remote, an outdated or refusing remote.
- **Proxy toggled mid-turn:** the turn finishes on the link it started on (the
  old link closes once idle); the next turn uses the new route. Claude Code
  processes carry the route in their key, so toggling starts a new process.
- **Remote not logged in:** `/proxy` refuses to enable; later turns fail with
  the remote's reason (e.g. "Claude Code is not signed in").
- **Version skew:** a remote that predates Claude pool routing (no
  `claude-pool` in its hello) serves every request from its `main`, shows
  only that account's bars, and `/accounts` explains that its accounts are not
  available; the local daemon then does not name its conversations. An older
  local daemon does not name them either, so a newer remote routes its
  requests as new work and reports the pool's combined usage. A remote
  without `/proxy` answers
  `Unknown command: provider_proxy_hello`, reported as "The Exocortex daemon
  on whale does not support /proxy; update Exocortex there". A protocol
  version mismatch names which side to update. A TUI newer than its daemon
  shows "The connected Exocortex daemon does not support /proxy; update it".
  Nothing changes for daemons and clients that never use `/proxy`.
- **Chained proxies:** a daemon that proxies a provider itself does not relay
  it further.

## Security

- The remote end is reached only through the authenticated SSH session (or
  the remote user's own daemon socket, which is already that user's).
- The remote makes only allowlisted requests: exact paths on the provider's
  own origin (`POST /v1/messages`, `/v1/messages/count_tokens` on
  api.anthropic.com; the Codex Responses HTTP/websocket endpoint, model list and
  transcription on chatgpt.com), never following redirects. The allowlist is in
  `shared/src/provider-proxy.ts`; the upstream origin can be pointed at a mock
  only in test processes (`EXOCORTEX_TEST=1`).
- Client-sent `Authorization`, `x-api-key`, cookies and account headers are
  dropped; the remote attaches its own. Responses never carry `Set-Cookie` or
  auth headers back, and tokens are never logged or sent over the link.
- Anthropic tokens come from Claude Code's own login on the remote, for the
  account the request was routed to (that account's `.credentials.json` or
  Keychain item); an expiring token is refreshed by Claude Code itself (a bare
  usage probe on that account), so its refresh-token rotation stays in one
  place. The conversation name a request carries is used for routing and
  removed before the upstream request. OpenAI uses the remote daemon's
  normal session refresh. A 401 is retried once after refreshing.
- The local forwarder listens on 127.0.0.1 only, checks the `Host` header, and
  requires a 32-byte per-daemon secret as the bearer token. The secret is what
  the local Claude Code process holds instead of a credential. Port and secret
  persist in `config/runtime/provider-proxy.json` (mode 0600) so Claude Code
  processes that outlive a daemon restart keep working.
- Request bodies and websocket messages are capped at 32 MiB.

## A key that can only borrow the login

`exocortexd proxy` bridges the whole daemon protocol, so an SSH key that may
run it can drive every conversation on the remote (and with it a shell),
run `remote_bash`, or register its machine as the one the remote's
`client_bash` goes to. For a machine that should only borrow the login (a
phone, a shared box), force the restricted bridge in the remote's
`~/.ssh/authorized_keys`:

```
restrict,command="/home/me/.local/bin/exocortexd proxy --link-only=anthropic" ssh-ed25519 AAAA… phone
```

`restrict` turns off the pty, port/agent/X11 forwarding and `~/.ssh/rc`;
`command=` runs only the bridge whatever the client asks for. `--link-only`
(`daemon/src/ipc-link-filter.ts`) parses every line and re-serializes what it
passes, so the daemon reads exactly what was checked:

- From the client only the model link passes: `provider_proxy_hello` (without
  its `clientHost`, so the remote's `client_bash` never goes to that machine),
  `_open`, `_ws_send`, `_cancel`, `_status`, `_consume_reset`, `_accounts` and
  `_ping`, for the listed providers (`=anthropic`, `=openai`, or both by
  default). `provider_proxy_exec` is answered with an error result, anything
  else with `error`; neither reaches the daemon.
- From the daemon only link events and the `error` answers to passed requests
  go back; broadcasts (sent before the hello) are dropped.
- The hello result gains the `link-only` feature (and loses `exec-alive`):
  the linking daemon then does not offer `remote_bash`, and its turn notice
  says every tool runs locally.

## Wire protocol

Messages and the allowlist: `shared/src/provider-proxy.ts`. A link starts with
`provider_proxy_hello`, which also stops the remote from sending that
connection its broadcasts; then `provider_proxy_open` / `_ws_send` / `_cancel`
streams (`provider_proxy_response`, `_data`, `_end`), `provider_proxy_status`
(login + usage), `provider_proxy_consume_reset`, `provider_proxy_exec`
(remote_bash; `exec-alive` remotes answer `provider_proxy_exec_alive` too),
`provider_proxy_ping` (`link-ping` remotes answer `provider_proxy_pong` at
once), `provider_proxy_client_exec` from the remote (client_bash, answered with
`provider_proxy_client_exec_result` and `_alive`) and `provider_proxy_accounts`: the remote's Claude pool
(`provider_proxy_accounts_result`, then `provider_proxy_accounts_update` on
every change while watched). The local daemon watches it while Anthropic goes
through the link and keeps the last pool while the link is down. A remote
without it answers `Unknown command`, and the bars fall back to its `main`
account's usage. A `claude-pool` remote (hello `features`) routes each Claude
request by its `x-exocortex-proxy-conversation` header (set through Claude
Code's `ANTHROPIC_CUSTOM_HEADERS`) and marks a response that moved the
conversation with `x-exocortex-claude-account-move`, which the forwarder takes
off and turns into the transcript notice. Clients use `provider_proxy` (`status`/`set`/`off`) and receive
`provider_proxies`, which `tools_available` also carries.

Code: `daemon/src/provider-proxy/` (`manager.ts` local state and config,
`link.ts` SSH link, `forwarder.ts` loopback endpoint, `endpoint.ts`,
`upstream-auth.ts` and `claude-routing.ts` remote side, `remote-accounts.ts`
the shared pool, `route.ts` what providers consult).

## Testing

- Unit tests: `daemon/src/provider-proxy/*.test.ts`,
  `shared/src/provider-proxy.test.ts`, `tui/src/commands/proxy.test.ts`.
- End to end, no real accounts: `bun scripts/dev/provider-proxy-e2e.ts` starts
  a client and a remote daemon joined by a fake `ssh`, with a mock upstream and
  the real Claude Code CLI on the client. Set `OLD_EXOCORTEX_ROOT` to a checkout
  without `/proxy` (one without external-tool daemons, e.g. a detached
  worktree) to also check an outdated remote.
