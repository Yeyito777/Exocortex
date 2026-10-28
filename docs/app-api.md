# App API: the daemon as a dependency

A program in any language can start a conversation on the user's own
Exocortex daemon with its own system prompt, model, tools (a chosen subset of
the built-ins plus tools the app runs itself), working directory and lifetime,
send prompts, stream or await the replies, and answer its own tool calls. It
uses the one daemon already running on the machine, with the user's logins and
Claude accounts. Ordinary (TUI) conversations are unaffected.

The wire protocol below is the contract; `shared/src/protocol.ts` (`Command`,
`Event`) and `shared/src/app-api.ts` hold its exact types.

## Connecting

**Socket.** The daemon listens on a Unix domain socket (a named pipe on
Windows, which the app API does not support yet). Find it, in order:

1. `$EXOCORTEX_SOCKET`, when set.
2. `exocortexd socket`, which prints the current instance's socket path.
3. Otherwise the daemon is not installed or not running: tell the user how to
   install it. Never install it yourself.

**Framing.** UTF-8, one JSON object per line (`\n`), both ways. Every command
has a string `type`; give the ones you want answered a `reqId` of your own
(unique per connection). Answers carry that `reqId`; other events arrive in
between and have none. Ignore event types you do not know: the daemon adds
new ones. An invalid line is answered `{"type":"error","message":"Invalid JSON"}`.

**Bootstrap.** Declare the connection an app client before anything else:

```json
{"type":"client_capabilities","reqId":"1","capabilities":[],"app":{"name":"myapp","version":"0.3.0"}}
```

```json
{"type":"app_welcome","reqId":"1","appApiVersion":1,"app":"myapp","instance":"main","pid":4242}
```

Refuse to go on if `appApiVersion` is one your client does not support (this
document is version 1), with a message telling the user to update. Older
daemons do not answer at all: treat no `app_welcome` within a few seconds as
"the daemon is too old for the app API".

An app name matches `^[a-z0-9][a-z0-9-]{0,39}$`. An app connection gets only
the answers to its own requests and the events of conversations it owns or
subscribes to; it never gets the TUI's sidebar lists, usage bars or other
conversations' events. Do not send `ping` (it answers only `pong` here).

## Lifetimes

`lifetime` on create:

| lifetime | stored | in the sidebar | survives a daemon restart | ends |
|---|---|---|---|---|
| `saved` (default for `new_conversation`) | conversation store | yes, folder `apps/<app>/` | yes (a running turn is replayed) | when deleted |
| `temporary` | conversation store | no | yes (a running turn is replayed) | `idleTtlMs` after its last activity (default 1 h, at most 30 days), deleted for good |
| `ephemeral` (default for `app_run`) | memory only | no | no | its owner's connection closes, it is deleted, or the daemon exits |

- Activity is any command naming the conversation and the end of each turn.
  A turn that is running never expires.
- Ephemeral conversations are never written to the conversation store, the
  live-turns journal or the queue file. Their default working directory is a
  temporary directory removed when they end, with Claude Code's session files
  for it. A daemon that crashed leaves these behind; the next start sweeps them.
- Temporary and ephemeral conversations are hidden: never in the conversation
  list, sidebar updates, search, folder counts, unread state or any TUI event.
  They can still be opened by id (`load_conversation`, `exo info`/`history`),
  and `list_app_conversations` lists them.
- Saved app conversations are filed under `apps/<app>/` (created when needed;
  `apps` starts muted). No app conversation is ever marked unread, notifies,
  or gets a generated title: the title is `title` from the create request,
  else the first line of the first prompt, truncated to 80 characters.
- Deleting an app conversation (`delete_conversation`) deletes it for good: no
  trash, no undo. Only a working directory the daemon created is removed;
  an app-supplied `cwd` is never moved, trashed or deleted.

## System prompt

`system: { text?: string, base?: "none" | "agent" | "full" }`, default base
`none` (at most 1 MB of text).

| base | Anthropic (Claude Code) | Other providers |
|---|---|---|
| `none` | Custom system prompt: only `text`. No `claude_code` preset, `settingSources: []` (no CLAUDE.md, user settings, hooks or auto-memory), no skills, no user MCP servers. The daemon's own safety hooks stay. | Only `text`. |
| `agent` | Claude Code's `claude_code` preset with `text` appended; otherwise as `none`. | Exocortex's environment header (identity, working directory, date, platform), the selected tools' hints, then `text`. |
| `full` | Exactly an ordinary conversation's prompt, with `text` as the conversation's instructions. | Same. |

`none` and `agent` never carry the global instructions (`config/system*.md`),
external tool hints or memories.

## Working directory

`cwd`: an existing absolute directory. Tools run there instead of a
conversation workspace. The daemon never creates, moves or deletes it.
Without it, a saved or temporary conversation gets the usual per-conversation
workspace, and an ephemeral one a temporary directory.

## Tools

`tools: { builtin?: string[] | "all", app?: AppToolDef[] }`, default none of
either. A conversation with no tools still runs as a conversation (multi-turn
history), it just cannot call anything.

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
naming it. `"all"` is what an ordinary conversation on that provider gets.
Claude Code tools that are not selected are really unavailable to the model
(`TodoWrite`, `Task`/`Agent`, `Skill` and the rest included). `chrono` is not
offered to ephemeral conversations (its schedules would outlive them).

**App tools** are defined by the app and run by it:

```json
{"name":"get_buffer","description":"The text of the user's current buffer.","inputSchema":{"type":"object","properties":{"start":{"type":"integer"}},"required":[]},"timeoutMs":30000}
```

- `name` matches `^[a-zA-Z0-9_-]{1,64}$`, unique, and is not a built-in tool's
  name on any provider (`bash`, `read`, `exec_command`, `Bash`, `Read`, …).
- `inputSchema` is a JSON Schema object schema (`"type":"object"`).
- `timeoutMs` (default 10 minutes, at most 24 h): how long the model waits.
- At most 128 app tools. They are stored with saved and temporary
  conversations, so the tool surface stays the same across turns and restarts;
  `attach_app_conversation` can replace them.

Under Claude Code they are an in-process MCP server named `app` (the model
sees `mcp__app__<name>`); elsewhere they are ordinary tool definitions. Either
way history records them under their bare name, and the TUI shows them like
any tool call.

**A call.** The daemon sends the conversation's owner:

```json
{"type":"app_tool_call","convId":"1793160000000-ab12cd","callId":"toolu_01X…","name":"get_buffer","input":{"start":0}}
```

and the owner answers (no reply to this command):

```json
{"type":"app_tool_result","convId":"1793160000000-ab12cd","callId":"toolu_01X…","output":"line one\nline two","isError":false}
```

- `output` is text (image blocks may come later). `isError: true` gives the
  model an error result.
- When the turn is aborted, or the call times out, the daemon sends
  `{"type":"app_tool_cancel","convId":…,"callId":…,"reason":"aborted"|"timeout"|"ended"}`
  and the model gets the usual interrupted or error result. A result that
  arrives later, or a second result for the same call, is ignored.
- With no owner connected, a call waits up to 60 s for one to attach (a
  client reconnecting, a daemon restart), then the model gets the error result
  `<app> is not connected`.

## Ownership

The connection that creates an app conversation (or attaches to it) is its
**owner**: it receives the conversation's `app_tool_call`s and its events
(it is subscribed). An ephemeral conversation ends when its owner's
connection closes. Saved and temporary ones outlive the connection; reconnect
and send `attach_app_conversation` to own one again.

## Commands

### `new_conversation`

The ordinary command, plus app fields. `app` defaults to the connection's
declared name; the other app fields need it, and are refused on ordinary
conversations.

```json
{"type":"new_conversation","reqId":"2","app":"myapp","lifetime":"temporary","idleTtlMs":600000,
 "provider":"anthropic","model":"claude-haiku-4-5","effort":"low","title":"Buffer helper",
 "system":{"base":"none","text":"You help edit the user's buffer."},
 "cwd":"/home/me/project",
 "tools":{"builtin":["read","grep"],"app":[{"name":"get_buffer","description":"…","inputSchema":{"type":"object"}}]}}
```

Answered with `conversation_created` (`convId`, `provider`, `model`, `effort`,
`fastMode`, and `app`: the conversation as recorded, an `AppConversationInfo`).
`provider`, `model` and `effort` default as for an ordinary conversation (the
user's default model). `folderId`, `subagent`, `delegation`, `goalObjective`
and `initialMessage` are refused for app conversations. A validation failure
answers `error` naming the field.

### `send_message` with `awaitResult`

```json
{"type":"send_message","reqId":"3","convId":"1793160000000-ab12cd","text":"Summarize the buffer.","startedAt":1793160000123,"awaitResult":true}
```

`startedAt` is the client's time in ms (the daemon's own clock when absent).
Streaming events for the conversation arrive meanwhile (see below); when the
turn ends the request is answered:

```json
{"type":"turn_result","reqId":"3","convId":"1793160000000-ab12cd","text":"The buffer …","stopReason":"end_turn","usage":{"outputTokens":212,"durationMs":3410}}
```

`stopReason` is `end_turn`, `aborted` (an `abort`, or the conversation ended)
or `error` (with `error`). `text` is the final assistant message's text.
Without `awaitResult` the send behaves as for any client: events only.
Sending to a conversation that is already running answers `error`
(`Already streaming`).

### `app_run`

Create, send and await in one request. Takes the create fields (`app`,
`convId`, `lifetime` default `ephemeral`, `idleTtlMs`, `title`, `system`,
`tools`, `provider`, `model`, `effort`, `cwd`) plus `prompt`, `images` and
`keep`.

```json
{"type":"app_run","reqId":"4","prompt":"Name three primes.","system":{"text":"Answer tersely."},"model":"claude-haiku-4-5"}
```

It is answered first with `conversation_created` (same `reqId`), then the
conversation's events, then `turn_result` (same `reqId`). App tools work
during the call. An ephemeral conversation is deleted right after the turn
(`conversation_deleted`, `reason: "run_finished"`) unless `keep: true`, which
leaves it to end with the connection.

### `attach_app_conversation`

```json
{"type":"attach_app_conversation","reqId":"5","convId":"1793160000000-ab12cd","tools":{"app":[…]}}
```

Become the owner (the previous owner, if any, stops receiving tool calls);
`tools.app`, when given, replaces the app tool definitions from the next turn
on. Unanswered calls are sent again to the new owner. Counts as activity.
Answered with `app_conversation_attached` (`conversation`: AppConversationInfo).
Attaching to an ephemeral conversation from another connection is refused.

### `delete_conversation`

On an app conversation: deletes it for good and answers
`{"type":"conversation_deleted","reqId":"6","convId":"…","reason":"deleted"}`.
A running turn is aborted first.

### `list_app_conversations`

```json
{"type":"list_app_conversations","reqId":"7","app":"myapp","includeSaved":true}
```

Answered with `app_conversations_list` (`conversations`: AppConversationInfo[]),
the live hidden ones (and saved ones with `includeSaved`), any app's unless
`app` is given.

### Other commands

App conversations are conversations: `abort {convId}`,
`load_conversation`, `load_conversation_history`, `set_model`, `set_effort`,
`subscribe`/`unsubscribe` and the rest work by id as documented in
[daemon IPC](daemon-ipc.md) and `shared/src/protocol.ts`.

## Events of a conversation

An owner (or subscriber) receives, among others:

- `user_message`: the prompt as stored.
- `streaming_started`: a turn began (`startedAt`).
- `block_start`, `text_chunk`, `thinking_chunk`: the reply as it streams.
- `tool_call`, `tool_result`: every tool call, built-in or the app's.
- `tokens_update`, `context_update`: progress.
- `message_complete`: the reply's final `blocks`.
- `conversation_updated`: summary changes (title, streaming state).
- `conversation_deleted`: it ended (`reason`: `deleted`, `expired`,
  `owner_disconnected`, `run_finished`).

A client that only wants the final text can ignore all of them and wait for
`turn_result`.

## A full session

`→` is the client, `←` the daemon (one JSON object per line; `…` marks text
shortened here).

```
→ {"type":"client_capabilities","reqId":"1","capabilities":[],"app":{"name":"demo","version":"1.0"}}
← {"type":"app_welcome","reqId":"1","appApiVersion":1,"app":"demo","instance":"main","pid":4242}
→ {"type":"new_conversation","reqId":"2","lifetime":"ephemeral","provider":"anthropic","model":"claude-haiku-4-5","system":{"text":"Use the lookup tool to answer."},"tools":{"app":[{"name":"lookup","description":"Look a word up.","inputSchema":{"type":"object","properties":{"word":{"type":"string"}},"required":["word"]}}]}}
← {"type":"conversation_created","reqId":"2","convId":"1793160000000-ab12cd","provider":"anthropic","model":"claude-haiku-4-5","effort":"high","fastMode":false,"goal":null,"app":{"convId":"1793160000000-ab12cd","app":"demo","lifetime":"ephemeral",…}}
→ {"type":"send_message","reqId":"3","convId":"1793160000000-ab12cd","text":"What does 'zorp' mean?","startedAt":1793160000500,"awaitResult":true}
← {"type":"user_message","convId":"1793160000000-ab12cd",…}
← {"type":"streaming_started","convId":"1793160000000-ab12cd",…}
← {"type":"tool_call","convId":"1793160000000-ab12cd","toolCallId":"toolu_01…","toolName":"lookup","input":{"word":"zorp"},…}
← {"type":"app_tool_call","convId":"1793160000000-ab12cd","callId":"toolu_01…","name":"lookup","input":{"word":"zorp"}}
→ {"type":"app_tool_result","convId":"1793160000000-ab12cd","callId":"toolu_01…","output":"zorp: a made-up word for a small blue frog."}
← {"type":"tool_result","convId":"1793160000000-ab12cd","toolCallId":"toolu_01…",…}
← {"type":"text_chunk","convId":"1793160000000-ab12cd","text":"'Zorp' is …"}
← {"type":"message_complete","convId":"1793160000000-ab12cd",…}
← {"type":"turn_result","reqId":"3","convId":"1793160000000-ab12cd","text":"'Zorp' is a made-up word for a small blue frog.","stopReason":"end_turn","usage":{"outputTokens":61,"durationMs":4120}}
(the client closes the connection: the ephemeral conversation ends, nothing of it stays on disk)
```

## Writing a client

A client needs: discovery (above), the bootstrap and version check, a reader
that splits lines and routes answers by `reqId` and events by `convId`, a
handler table for its app tools (answer every `app_tool_call` exactly once,
stop on `app_tool_cancel`), and, for saved or temporary conversations, a
reconnect that sends `attach_app_conversation` for each conversation it
owned. Reference clients live under `clients/`.
