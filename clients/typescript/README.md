# @exocortex/client (TypeScript)

Use the user's Exocortex daemon from a Bun or Node (22.18+) program: one-shot
runs, conversations, streaming, and tools your program answers. No runtime
dependencies; the protocol is [docs/app-api.md](../../docs/app-api.md).

```ts
import { connect, run } from "@exocortex/client";

console.log((await run("Name three primes.", { app: "myapp", system: "Answer tersely." })).text);

const exo = await connect({ app: "myapp" });
const lookup = { name: "lookup", description: "Look a word up.", inputSchema: { type: "object", properties: { word: { type: "string" } } },
  handler: ({ word }: { word: string }) => `${word}: a small blue frog` };
const conv = await exo.conversation({ lifetime: "temporary", system: "Use lookup to answer.", tools: { app: [lookup] } });
for await (const piece of conv.stream("What does 'zorp' mean?").text()) process.stdout.write(piece);
await exo.close();
```

- `connect({ app, version?, socket?, reconnect?, reconnectTimeoutMs?, reconnectGraceMs?, session?, rerunLost? })` finds the socket
  (`$EXOCORTEX_SOCKET`, then `exocortexd socket`), checks `app_welcome`'s
  version, and fails with an `ExocortexError` whose `code` says what is wrong
  (`not_installed` carries the install one-liner, `not_running`, `too_old`,
  `incompatible`, …).
- `client.run(prompt, opts)` / `client.runStream(…)`: `app_run`, ephemeral by
  default (`lifetime`, `keep`). `run(prompt, { app, … })` connects and closes
  around it.
- `client.conversation(opts)` → `Conversation`: `send(prompt)` resolves the
  `TurnResult` (`text`, `stopReason`, `error`, `usage`); `stream(prompt)` is
  an async iterator of `text` / `thinking` / `tool_call` / `tool_result`
  events with `.text()` and `.result`; `abort()`, `setTools()`, `delete()`.
  Options: `lifetime`, `idleTtlMs`, `title`, `system` (text, or
  `{ text, base }`), `tools: { builtin, app }`, `provider`, `model`, `effort`,
  `cwd`, `route: { credits: "allow" | "never", whenLimited: "wait" | "error" }`.
  A `TurnResult` also has `billing` (`"api-credits"`) and `limited`
  (`{ resetAt }`) when they apply.
- App tools: `{ name, description, inputSchema, timeoutMs?, handler }`. The
  handler (sync or async) gets `(input, { convId, callId, signal })` and
  returns text, `{ output, isError }` or any JSON value; a throw is an error
  result; `signal` aborts on `app_tool_cancel`.
- `client.attach(convId, { tools })` owns a saved/temporary conversation again
  (e.g. after your program restarts); `client.list({ includeSaved, allApps })`;
  `client.delete(convId)`; `client.onEvent(fn)` sees every raw event;
  `await client.close()` ends the session's ephemeral conversations.
- A dropped connection or daemon restart is a delay, not an error: the client
  reconnects (for up to `reconnectTimeoutMs`, default 300 s) under its
  session (`client.session`), takes every conversation back, ephemeral ones
  too, and sends again what was in flight (the daemon never runs a prompt
  twice); requests made meanwhile wait. Running tool handlers keep going. A
  conversation the daemon lost (a crash, or away longer than the session's
  grace) ends with `code: "lost"`; a pending `run()` on one runs again on a
  new conversation (`rerunLost: false` to fail it instead).

Tests: `bun install && bun test` (Bun) and `node --test test/node-smoke.test.mjs`
(Node), against [the fake daemon](../testing/fake-daemon.ts).
