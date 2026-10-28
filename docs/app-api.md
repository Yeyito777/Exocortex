# App API: the daemon as a dependency

A program in any language can start a conversation on the user's own
Exocortex daemon with its own system prompt, model, tools (a chosen subset of
the built-ins plus tools the app runs itself), working directory and lifetime,
send prompts, stream or await the replies, and answer its own tool calls. It
uses the one daemon already running on the machine, with the user's logins and
Claude accounts. Ordinary (TUI) conversations are unaffected.

The wire protocol below is the contract; `shared/src/protocol.ts` (`Command`,
`Event`) and `shared/src/app-api.ts` hold its exact types and limits. The
daemon side lives in `daemon/src/app-api.ts` (lifetimes, owners, turn
results), `app-registry.ts` (records), `app-tools.ts` (tool vocabulary and app
tool calls) and `app-workspaces.ts` (directories and session files).

## Connecting

**Is the daemon there?** Run `exocortexd doctor --json`. When `exocortexd` is
not on PATH, or the report's `ok` is false, show the user what is missing (the
report's `problems` carry the fixing command; for no install at all, the
one-line installer from the README). Never install anything yourself.

**Socket.** Connect to `$EXOCORTEX_SOCKET` when it is set (every shell
Exocortex starts has it), else to the path `exocortexd socket` prints. It is a
Unix domain socket; Windows is not supported by the app API yet.

**Framing.** UTF-8, one JSON object per line (`\n`), both ways. Every command
has a string `type`; give the ones you want answered a `reqId` of your own
(unique per connection). Answers carry that `reqId`; other events arrive in
between and have none. Ignore event types and fields you do not know: the
daemon adds new ones. A line that is not JSON is answered
`{"type":"error","message":"Invalid JSON"}`; a failed request is answered
`{"type":"error","reqId":…,"message":…}` (with `convId` when it names one).

**Bootstrap.** Declare the connection an app client before anything else:

```json
{"type":"client_capabilities","reqId":"1","capabilities":[],"app":{"name":"myapp","version":"0.3.0"}}
```

```json
{"type":"app_welcome","reqId":"1","appApiVersion":1,"app":"myapp","instance":"main","pid":4242}
```

Refuse to go on if `appApiVersion` is one your client does not support (this
document is version 1), telling the user to update. A daemon from before the
app API does not answer at all: treat no `app_welcome` within a few seconds as
"Exocortex is too old for this app; update it".

An app name matches `^[a-z0-9][a-z0-9-]{0,39}$`. An app connection gets only
the answers to its own requests and the events of conversations it owns or
subscribes to, plus `daemon_shutdown`; never the TUI's sidebar lists, usage
bars or other conversations' events. `ping` answers only `pong`.

## Lifetimes

`lifetime` on create:

| lifetime | stored | in the sidebar | survives a daemon restart | ends |
|---|---|---|---|---|
| `saved` (default for `new_conversation`) | conversation store | yes, folder `apps/<app>/` | yes (a running turn is replayed) | when deleted |
| `temporary` | conversation store | no | yes (a running turn is replayed) | `idleTtlMs` after its last activity (default 1 h, at most 30 days), deleted for good |
| `ephemeral` (default for `app_run`) | memory only | no | no | its owner's connection closes, it is deleted, or the daemon exits |

- Activity is any command naming the conversation and the end of each turn.
  A running turn, or one waiting on an app tool call, never expires. Expiry is
  checked every minute and at startup.
- Ephemeral conversations are never written: not to the conversation store,
  the queue file, pending instructions, the live-turns journal or the Claude
  account file. Their default working directory is a temporary directory
  (`<tmp>/exocortex-apps-<uid>-<instance>/<convId>`) removed when they end;
  their Claude Code process keeps no session files (`persistSession: false`)
  and stays running between turns instead. What a crashed daemon left behind
  (directories, Claude Code projects for them) is swept at the next start.
  The daemon log names the conversation id and app, never its content.
- Temporary and ephemeral conversations are hidden: never in the conversation
  list, sidebar updates, search, folder counts, unread state, the queue panel,
  the Accounts screen or any TUI event. They can still be opened by id
  (`load_conversation`, `exo info`/`history`), and `list_app_conversations`
  lists them.
- Saved app conversations are filed under `apps/<app>/` (created when needed;
  `apps` starts muted). No app conversation is ever marked unread, notifies,
  or costs a title model call: its title is `title` from the create request,
  else the first line of its first prompt, truncated to 80 characters.
- Deleting an app conversation deletes it for good: no trash, no undo. Only a
  working directory the daemon created is removed (and Claude Code's session
  files for its turns); an app-supplied `cwd` is never moved, trashed or
  deleted.
- What makes a conversation an app's (app, lifetime, system prompt, tools,
  cwd, last turn result) is kept for saved and temporary ones in
  `app-conversations.json` beside the conversation store, so ordinary
  conversations are stored exactly as before.

## System prompt

`system: { text?: string, base?: "none" | "agent" | "full" }`, default base
`none` (at most 1 MB of text).

| base | Anthropic (Claude Code) | Other providers |
|---|---|---|
| `none` | Custom system prompt: `text`. No `claude_code` preset, `settingSources: []` (no CLAUDE.md, user settings, hooks), auto-memory off, no skills, no MCP servers but the app's and Exocortex's. The daemon's own safety hooks stay. | Exactly `text`. |
| `agent` | Claude Code's `claude_code` preset with `text` appended; otherwise as `none`. | Exocortex's environment header (identity, working directory, date, platform, conversation id), the selected built-in tools' hints, then `text`. |
| `full` | Exactly an ordinary conversation's prompt, with `text` as the conversation's instructions. | Same. |

`none` and `agent` never carry the global instructions (`config/system*.md`),
external tool hints, CLAUDE.md or memories; this was checked on the real
requests to both providers. Claude Code itself always puts one line before
any system prompt ("You are a Claude agent, built on Anthropic's Claude Agent
SDK.") and adds a reminder naming the signed-in account's email to the first
message; neither can be turned off from outside Claude Code.

## Working directory

`cwd`: an existing absolute directory. Tools run there instead of a
conversation workspace. The daemon never creates, moves or deletes it; a turn
whose `cwd` has gone answers an error. Without it, a saved or temporary
conversation gets the usual per-conversation workspace, and an ephemeral one a
temporary directory. `conversation_created.app` reports `cwd` or the
daemon's `workspace`.

## Tools

`tools: { builtin?: string[] | "all", app?: AppToolDef[] }`, default none of
either. A conversation with no tools still runs as a conversation (multi-turn
history); the model just cannot call anything.

**Built-in tools** use one provider-neutral vocabulary, mapped per provider:

| name | Anthropic (Claude Code) | OpenAI | Other providers |
|---|---|---|---|
| `bash` | `Bash` | `exec_command`, `write_stdin` | `bash` |
| `read` | `Read` | `read`, `view_image` | `read` |
| `write` | `Write` | `apply_patch` | `write` |
| `edit` | `Edit` | `apply_patch` | `edit` |
| `glob` | `Glob` | `glob` | `glob` |
| `grep` | `Grep` | `grep` | `grep` |
| `web_search` | `WebSearch` | not offered | not offered |
| `web_fetch` | `WebFetch` | `browse` | `browse` |
| `exo`, `chrono`, `goal`, `attach` | host tools over MCP (`mcp__exocortex__*`) | the Exocortex tool | the Exocortex tool |

An unknown name, or one the chosen provider cannot offer, is a create error
naming it; so is any tool on a chat-only model. `"all"` is what an ordinary
conversation on that provider gets. Claude Code tools that are not selected
are really unavailable to the model (`TodoWrite`, `Task`/`Agent`, `Skill` and
the rest included). `chrono` is not offered to ephemeral conversations (its
schedules would outlive them).

**App tools** are defined by the app and run by it:

```json
{"name":"get_buffer","description":"The text of the user's current buffer.","inputSchema":{"type":"object","properties":{"start":{"type":"integer"}}},"timeoutMs":30000}
```

- `name` matches `^[a-zA-Z0-9_-]{1,64}$`, unique, and is not a built-in
  tool's name on any provider (`bash`, `read`, `exec_command`, `Bash`, `Read`,
  `TodoWrite`, …).
- `inputSchema` is a JSON Schema object schema (`"type":"object"` is added
  when missing).
- `timeoutMs` (default 10 minutes, at most 24 h): how long the model waits.
- At most 128 app tools. They are stored with saved and temporary
  conversations, so the tool surface stays the same across turns and restarts;
  `attach_app_conversation` can replace them.

Under Claude Code they are an in-process MCP server named `app` (the model
sees `mcp__app__<name>`); elsewhere they are ordinary tool definitions. Either
way history records them under their bare name, and the TUI shows them like
any tool call, labelled with the app's name.

**A call.** The daemon sends the conversation's owner:

```json
{"type":"app_tool_call","convId":"1793160000000-ab12cd","callId":"toolu_01X…","name":"get_buffer","input":{"start":0}}
```

and the owner answers (this command gets no answer):

```json
{"type":"app_tool_result","convId":"1793160000000-ab12cd","callId":"toolu_01X…","output":"line one\nline two","isError":false}
```

- `output` is text (image blocks may come later; a non-string is sent as
  JSON). `isError: true` gives the model an error result.
- When the turn is aborted, the call times out, or the conversation ends, the
  daemon sends `{"type":"app_tool_cancel","convId":…,"callId":…,"reason":"aborted"|"timeout"|"ended"}`
  and the model gets the usual interrupted or error result. A result that
  arrives later, or a second result for the same call, is ignored.
- Calls of one round may arrive together; answer each one once.
- With no owner connected, a call waits up to 60 s for one to attach (a
  client reconnecting, a daemon restart), then the model gets the error
  result `<app> is not connected`. A new owner is sent every unanswered call.

## Ownership and reconnecting

The connection that creates an app conversation (or attaches to it) is its
**owner**: it receives the conversation's `app_tool_call`s and its events (it
is subscribed). An ephemeral conversation ends when its owner's connection
closes. Saved and temporary ones outlive the connection; reconnect and send
`attach_app_conversation` to own one again.

**Turn results.** At the end of every turn of an app conversation (prompts the
app sent, and turns the daemon starts itself, such as a background task's
report), the current owner receives a `turn_result` without `reqId`; a
connection that awaited that turn (`awaitResult`, `app_run`) receives it with
its `reqId` instead. `turnId` identifies the turn: the `startedAt` of the
prompt that started it, as a decimal string, unchanged when a daemon restart
replays the turn. To resolve a send across a reconnect, send a unique
`startedAt`, and after re-attaching match `convId` + `turnId` against the
live `turn_result`s and the attach answer's `lastTurnResult` (the most recent
turn result, kept with saved and temporary conversations), which covers a turn
that ended while no owner was connected.

## Commands

### `new_conversation`

The ordinary command, plus app fields. `app` defaults to the connection's
declared name (a different one is refused); the other app fields need it, and
are refused on ordinary conversations.

```json
{"type":"new_conversation","reqId":"2","lifetime":"temporary","idleTtlMs":600000,
 "provider":"anthropic","model":"claude-haiku-5-5","effort":"low","title":"Buffer helper",
 "system":{"base":"none","text":"You help edit the user's buffer."},
 "cwd":"/home/me/project",
 "tools":{"builtin":["read","grep"],"app":[{"name":"get_buffer","description":"…","inputSchema":{"type":"object"}}]}}
```

Answered with `conversation_created` (`convId`, `provider`, `model`, `effort`,
`fastMode`, and `app`: the conversation as recorded, an `AppConversationInfo`).
`provider`, `model` and `effort` default as for an ordinary conversation (the
user's default model). `convId` may be given (`^\d+-[a-z0-9]{6}$`, unused).
`folderId`, `subagent`, `delegation`, `goalObjective`, `titleContext` and
`initialMessage` are refused for app conversations. A validation failure
answers `error` naming the field, and creates nothing.

### `send_message` with `awaitResult`

```json
{"type":"send_message","reqId":"3","convId":"1793160000000-ab12cd","text":"Summarize the buffer.","startedAt":1793160000123,"awaitResult":true}
```

`startedAt` is the prompt's time in ms; when absent the daemon uses its own
clock (and you cannot match the turn after a reconnect). Events for the
conversation stream meanwhile; when the turn ends the request is answered:

```json
{"type":"turn_result","reqId":"3","convId":"1793160000000-ab12cd","turnId":"1793160000123","text":"The buffer …","stopReason":"end_turn","usage":{"outputTokens":212,"durationMs":3410}}
```

`stopReason` is `end_turn`, `aborted` (an `abort`, or the conversation ended)
or `error` (with `error`). `text` is the final assistant message's text (after
its last tool round). Without `awaitResult` the send behaves as for any
client: events only, and the owner still gets the `turn_result`. A send that
is refused before its turn starts (for example `Already streaming`) is
answered `error` instead. `awaitResult` works on ordinary conversations too.

### `app_run`

Create, send and await in one request. Takes the create fields (`app`,
`convId`, `lifetime` default `ephemeral`, `idleTtlMs`, `title`, `system`,
`tools`, `provider`, `model`, `effort`, `cwd`) plus `prompt`, `images`,
`startedAt` and `keep`.

```json
{"type":"app_run","reqId":"4","prompt":"Name three primes.","system":{"text":"Answer tersely."},"model":"claude-haiku-5-5"}
```

It is answered first with `conversation_created` (same `reqId`), then the
conversation's events, then `turn_result` (same `reqId`). App tools work
during the call. An ephemeral conversation is deleted right after the turn
(`conversation_deleted` with `reason: "run_finished"`) unless `keep: true`,
which leaves it to end with the connection. A request that fails validation
is answered `error` (same `reqId`) before any `conversation_created`, and
creates nothing.

### `attach_app_conversation`

```json
{"type":"attach_app_conversation","reqId":"5","convId":"1793160000000-ab12cd","tools":{"app":[…]}}
```

Become the owner (the previous owner, if any, stops receiving tool calls);
`tools.app`, when given, replaces the app tool definitions from the next turn
on. Unanswered calls are sent again to the new owner. Counts as activity.
Answered with `app_conversation_attached`: `conversation` (AppConversationInfo,
whose `streaming` says whether a turn is running) and `lastTurnResult`.
Refused for an ephemeral conversation another connection owns, and for
another app's conversation.

### `delete_conversation`

On an app conversation: deletes it for good (aborting a running turn) and
answers `{"type":"conversation_deleted","reqId":"6","convId":"…","reason":"deleted"}`.
Other subscribers get the same event without `reqId`; reasons elsewhere are
`expired`, `owner_disconnected` and `run_finished`. An awaited turn it cut
short is answered `turn_result` with `stopReason: "aborted"`.

### `list_app_conversations`

```json
{"type":"list_app_conversations","reqId":"7","app":"myapp","includeSaved":true}
```

Answered with `app_conversations_list` (`conversations`: AppConversationInfo[],
most recently active first): the live hidden ones, and saved ones with
`includeSaved`; any app's unless `app` is given.

### Other commands

App conversations are conversations: `abort {convId}`, `load_conversation`,
`load_conversation_history`, `set_model`, `set_effort`, `queue_message`,
`subscribe`/`unsubscribe` and the rest work by id as documented in
[daemon IPC](daemon-ipc.md) and `shared/src/protocol.ts`. BTW threads are
not available in app conversations.

## Events of a conversation

An owner (or subscriber) receives, among others:

- `user_message`: the prompt as stored.
- `streaming_started` / `streaming_stopped`: a turn began / ended.
- `block_start`, `text_chunk`, `thinking_chunk`: the reply as it streams.
- `tool_call`, `tool_result`: every tool call, built-in or the app's.
- `tokens_update`, `context_update`: progress.
- `message_complete`: the reply's final `blocks`.
- `conversation_updated`: summary changes (title, streaming state).
- `turn_result`: the turn ended (above).
- `conversation_deleted`: it ended.

A client that only wants the final text can ignore all of them and wait for
`turn_result`.

## A full session

From the end-to-end run on a test daemon (`→` client, `←` daemon; one JSON
object per line; long values cut with `…`, some progress events left out).

```
→ {"type":"client_capabilities","capabilities":[],"app":{"name":"e2e","version":"1.0"},"reqId":"r1"}
← {"type":"app_welcome","reqId":"r1","appApiVersion":1,"app":"e2e","instance":"app-api","pid":2888183}
→ {"type":"new_conversation","lifetime":"ephemeral","provider":"anthropic","model":"claude-haiku-5-5","effort":"low","system":{"base":"none","text":"You are a terse test bot. Answer word questions only by calling the lookup tool, then reply in one sentence."},"tools":{"app":[{"name":"lookup","description":"Look up the meaning of an invented word.","inputSchema":{"type":"object","properties":{"word":{"type":"string"}},"required":["word"]}}]},"reqId":"r3"}
← {"type":"conversation_created","reqId":"r3","convId":"1793159778876-1t8352","provider":"anthropic","model":"claude-haiku-5-5","effort":"low","fastMode":false,"goal":null,"app":{"convId":"1793159778876-1t8352","app":"e2e","lifetime":"ephemeral","title":"","provider":"anthropic","model":"claude-haiku-5-5","effort":"low","createdAt":1793159778877,"lastActivityAt":1793159778877,"ownerConnected":true,"streaming":false,"workspace":"/tmp/exocortex-apps-1000-…/1793159778876-1t8352","systemBase":"none","builtinTools":[],"appTools":["lookup"]}}
→ {"type":"send_message","convId":"1793159778876-1t8352","text":"What does the word zorp mean?","startedAt":1793159778878,"awaitResult":true,"reqId":"r4"}
← {"type":"user_message","convId":"1793159778876-1t8352","text":"What does the word zorp mean?","startedAt":1793159778878}
← {"type":"streaming_started","convId":"1793159778876-1t8352","provider":"anthropic","model":"claude-haiku-5-5","streamSeq":1,"snapshotKind":"start","startedAt":1793159778878,…}
← {"type":"tool_call","convId":"1793159778876-1t8352","streamSeq":2,"toolCallId":"toolu_01KDyrqmpWH2UTuYsRx2RTGg","toolName":"lookup","input":{"word":"zorp"},"summary":"lookup --word zorp","presentation":{"toolStyle":{"name":"lookup","label":"e2e","color":"#c8a0ff"}}}
← {"type":"app_tool_call","convId":"1793159778876-1t8352","callId":"toolu_01KDyrqmpWH2UTuYsRx2RTGg","name":"lookup","input":{"word":"zorp"}}
→ {"type":"app_tool_result","convId":"1793159778876-1t8352","callId":"toolu_01KDyrqmpWH2UTuYsRx2RTGg","output":"zorp: a small blue frog that hums."}
← {"type":"tool_result","convId":"1793159778876-1t8352","streamSeq":3,"toolCallId":"toolu_01KDyrqmpWH2UTuYsRx2RTGg","toolName":"lookup","output":"zorp: a small blue frog that hums.","isError":false}
← {"type":"block_start","convId":"1793159778876-1t8352","streamSeq":6,"blockType":"text"}
← {"type":"text_chunk","convId":"1793159778876-1t8352","streamSeq":7,"text":"Per"}
← {"type":"text_chunk","convId":"1793159778876-1t8352","streamSeq":8,"text":" the lookup tool, \""}
← …
← {"type":"message_complete","convId":"1793159778876-1t8352","streamSeq":14,"blocks":[…],…}
← {"type":"turn_result","convId":"1793159778876-1t8352","turnId":"1793159778878","text":"Per the lookup tool, \"zorp\" means a small blue frog that hums.","stopReason":"end_turn","usage":{"outputTokens":82,"durationMs":4012},"reqId":"r4"}
(the client closes the connection: the ephemeral conversation ends, and nothing of it is left on disk)
```

## Writing a client

A client needs: discovery (above), the bootstrap and version check, a reader
that splits lines and routes answers by `reqId` and events by `convId`, a
handler table for its app tools (answer every `app_tool_call` exactly once,
stop work on `app_tool_cancel`), and, for saved or temporary conversations, a
reconnect that sends `attach_app_conversation` for each conversation it owned
and settles pending sends from live `turn_result`s and `lastTurnResult` by
`convId` + `turnId`. Reference clients live under `clients/`.
