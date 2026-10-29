# exocortex (Neovim, Lua)

Use the user's Exocortex daemon from a Neovim plugin: `require("exocortex")`.
Non-blocking (`vim.uv`); every callback and tool handler runs on the main loop,
so it can use the Neovim API. Add this directory (`clients/lua`) to
`runtimepath` or vendor `lua/exocortex/init.lua`. The protocol is
[docs/app-api.md](../../docs/app-api.md).

```lua
local exo = require("exocortex")
exo.run("Name three primes.", { app = "nvim", system = "Answer tersely." }, function(err, r) print(err and tostring(err) or r.text) end)

local get_buffer = { name = "get_buffer", description = "The current buffer's text.", input_schema = { type = "object", properties = vim.empty_dict() },
  handler = function() return table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\n") end }
exo.async(function()
  local client = exo.await(exo.connect, { app = "nvim" })
  local conv = exo.await(client.conversation, client, { lifetime = "temporary", system = "Use get_buffer to answer.", tools = { get_buffer } })
  local r = exo.await(conv.send, conv, "Summarize my buffer.", { on_text = function(d) io.write(d) end })
end)
```

- Async functions take `function(err, result)` last; inside `exo.async(fn)`,
  `exo.await(fn, ...)` returns the result or raises the error. Errors are
  tables with `code` (`not_installed` carries the install one-liner,
  `not_running`, `too_old`, `incompatible`, `ended`, …) and `message`.
- `exo.connect({ app, version?, socket?, reconnect?, reconnect_timeout_ms?,
  reconnect_grace_ms?, session?, rerun_lost? }, cb)` finds the socket
  (`$EXOCORTEX_SOCKET`, then `exocortexd socket`) and checks the version.
- `client:run(prompt, opts, cb)` / `client:run_stream(prompt, opts)`: one-shot,
  ephemeral by default (`lifetime`, `keep`); `exo.run(prompt, { app, … }, cb)`
  connects and closes around it.
- `client:conversation(opts, cb)`: `lifetime`, `system` (text, or
  `{ text, base }`), `base`, `builtin`, `tools`, `provider`, `model`,
  `effort`, `cwd`, `title`, `idle_ttl_ms`, `route` (`{ credits = "allow" |
  "never", whenLimited = "wait" | "error" }`). Results also carry `billing`
  and `limited` when they apply. A conversation has
  `send(prompt, { on_text, on_event, on_raw }, cb)`, `stream(prompt)` (iterate
  `stream:iter()` inside `exo.async`, or `stream:wait(cb)`), `abort`,
  `set_tools`, `delete`.
- App tools: `{ name, description, input_schema, timeout_ms?, handler, async? }`.
  `handler(input, call)` returns text, `{ output, isError }` or any value
  (sent as JSON); `error()` is an error result. With `async = true`, answer
  later with `call:respond(value)`; `call:on_cancel(fn)` hears
  `app_tool_cancel`. Use `vim.empty_dict()` for empty JSON objects.
- `client:attach(conv_id, { tools }, cb)`, `client:list({ include_saved,
  all_apps }, cb)`, `client:delete(conv_id, cb)`, `client:on_event(fn)`,
  `client:close(cb?)` (ends the session's ephemeral conversations).
- A dropped connection or daemon restart is a delay, not an error: the client
  reconnects (for up to `reconnect_timeout_ms`, default 300 s) under its
  session (`client.session`), takes every conversation back, ephemeral ones
  too, and sends again what was in flight (the daemon never runs a prompt
  twice); requests made meanwhile wait. Running tool handlers keep going. A
  conversation the daemon lost (a crash, or away longer than the session's
  grace) ends with code `lost`; a pending `run` on one runs again on a new
  conversation (`rerun_lost = false` to fail it instead).

Tests (need `bun` for [the fake daemon](../testing/fake-daemon.ts)):
`nvim --headless -u NONE -l test/run.lua`.
