# Clients

Reference clients for the [app API](../docs/app-api.md): programs that use the
user's Exocortex daemon as a dependency. Each offers the same surface: socket
discovery (`$EXOCORTEX_SOCKET`, then `exocortexd socket`; the install
one-liner when `exocortexd` is missing, `exocortexd doctor --json`'s problems
when the daemon does not answer), the `app_welcome` version check, a one-shot `run`, conversation
objects that send and await or stream, app tools as handler callbacks, attach,
list, delete, and reconnect with re-attach after a dropped connection or a
daemon restart.

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

Writing a client in another language: read [docs/app-api.md](../docs/app-api.md)
("Writing a client"); the Python module is the shortest one to port.
