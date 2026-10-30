# Clients

Reference clients for the [app API](../docs/app-api.md): programs that use the
user's Exocortex daemon as a dependency. Each offers the same surface: socket
discovery (`$EXOCORTEX_SOCKET`, then `exocortexd socket`; the install
one-liner when `exocortexd` is missing, `exocortexd doctor --json`'s problems
when the daemon does not answer), the `app_welcome` version check, a one-shot `run`, conversation
objects that send and await or stream, app tools as handler callbacks, attach,
list, delete, `route` preferences (keep a batch job off Claude API credits, or
stop instead of waiting at a usage limit), and reconnecting: after a dropped
connection or a daemon restart a client reconnects with backoff under its
session token, takes its conversations back (ephemeral ones too) and sends
what was in flight again, so a send or a run only takes longer; a streamed
reply goes on where it was (turn catch-ups), with no text repeated or missing,
and `follow()` streams a turn already running after an attach. A daemon
crash loses ephemeral conversations: a one-shot run starts over, anything else
fails with code `lost`.

| Client | For | Depends on |
|---|---|---|
| [`typescript/`](typescript/README.md) (`@exocortex/client`) | Bun, Node 22.18+ | nothing |
| [`python/`](python/README.md) (`exocortex.py`) | Python 3.9+, sync and asyncio | the standard library |
| [`lua/`](lua/README.md) (`require("exocortex")`) | Neovim plugins (`vim.uv`) | Neovim 0.10+ |

From the shell, `exo run` (external exo CLI) is the same one-shot:
`printf 'Name three primes.' | exo run --app myapp --model claude-haiku-5-5`.

[`testing/fake-daemon.ts`](testing/fake-daemon.ts) speaks the documented JSON
lines with a scripted model; every client's tests run against it
(`bun clients/testing/fake-daemon.ts --socket PATH`).

Full clients of the ordinary daemon protocol ([daemon IPC](../docs/daemon-ipc.md)),
besides the TUI: the OSS Phone's native Exocortex app, in Rust
([a26-system `src/exocortex/`](https://github.com/Yeyito777/a26-system),
`a26-system --app exocortex`), and its notification bridge
`exocortex-notify`.

Writing a client in another language: read [docs/app-api.md](../docs/app-api.md)
("Writing a client"); the Python module is the shortest one to port.
