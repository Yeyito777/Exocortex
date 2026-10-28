# exocortex.py (Python)

Use the user's Exocortex daemon from Python 3.9+: one module, standard
library only. Copy `exocortex.py` into your project. The protocol is
[docs/app-api.md](../../docs/app-api.md).

```python
import exocortex

print(exocortex.run("Name three primes.", app="myapp", system="Answer tersely.").text)

@exocortex.tool("Look a word up.", {"type": "object", "properties": {"word": {"type": "string"}}})
def lookup(args):
    return args["word"] + ": a small blue frog"

with exocortex.connect("myapp") as exo:
    conv = exo.conversation("temporary", system="Use lookup to answer.", tools=[lookup])
    for piece in conv.stream("What does 'zorp' mean?").text():
        print(piece, end="", flush=True)
```

- `connect(app, version=, socket=, reconnect=True)` finds the socket
  (`$EXOCORTEX_SOCKET`, then `exocortexd socket`) and checks the version;
  failures raise `ExocortexError` with a `code` (`not_installed` carries the
  install one-liner, `not_running`, `too_old`, `incompatible`, …).
- `client.run(prompt, lifetime=None, keep=False, **options)` /
  `client.run_stream(…)`: one-shot, ephemeral by default. `exocortex.run(prompt,
  app=…)` connects and closes around it.
- `client.conversation(lifetime, system=, base=, builtin=, tools=, provider=,
  model=, effort=, cwd=, title=, idle_ttl_ms=)` → `Conversation`:
  `send(prompt)` returns a `TurnResult` (`text`, `stop_reason`, `error`,
  `usage`); `stream(prompt)` iterates `StreamEvent`s (`text`, `thinking`,
  `tool_call`, `tool_result`) with `.text()` and `.result()`; `abort()`,
  `set_tools()`, `delete()`; `asend` / `astream` and `exocortex.arun` for
  asyncio.
- App tools: `Tool(name, description, input_schema, handler, timeout_ms)` or
  `@exocortex.tool(description, schema)`. Handlers run on a thread pool and
  take `(args)` or `(args, call)`; they return text, `{"output", "isError"}`
  or any JSON value, and an exception is an error result. `call.cancelled`
  (a `threading.Event`) is set on `app_tool_cancel`.
- `client.attach(conv_id, tools=)`, `client.list(include_saved=, all_apps=)`,
  `client.delete(conv_id)`, `client.on_event(fn)`.
- A dropped connection or daemon restart reconnects and re-attaches saved and
  temporary conversations; their pending sends still return. Ephemeral ones
  end with the connection (`code == "ended"`).

Tests (need `bun` for [the fake daemon](../testing/fake-daemon.ts)):
`python3 -m unittest -v test_exocortex`.
