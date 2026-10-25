# Direct daemon commands

For conversation/history/task inspection, new conversations, folders, and other
administration, read `shared/src/protocol.ts`: `Command` and `Event` are the wire
specification. Implementation/validation is in `daemon/src/handler.ts`.

Send one JSON object per line over the daemon socket (`daemon/src/server.ts`).
Resolve the current instance's endpoint with `socketPath()` from
`shared/src/paths.ts`; do not guess a main-instance or worktree socket path.
Use a unique `reqId`, consume the corresponding response/error, and close the
connection. Broadcasts can arrive between responses. A timeout is not rollback:
inspect state before retrying a mutation.

Common commands include `list_conversations`, `load_conversation`,
`load_conversation_history`, `new_conversation`, `send_message`, `create_folder`, and
`move_sidebar_items`. Read their exact fields in the spec before sending.
`get_image` fetches a bounded preview of a history image (see
[inline images](inline-images.md)).
Managed task inspection/stopping uses `list_tasks` / `stop_task`; task IDs are
not raw PIDs. Use `abort` for subagent conversations and Chrono cancellation
for schedules: `chrono` lists, creates, or cancels a conversation's schedules.
Never restart the main daemon over IPC or by running `exocortexd restart` from a
turn (the turn would be replayed and restart again); use the native `exo` tool's
`restart` action, which runs after the turn ends.

Daybreak uses ordinary model selection: `provider: "openai"` and
`model: "gpt-6-sol-daybreak"`. The account catalog must advertise Blue on
`gpt-6-sol`; custom-model support cannot bypass this check. There is no separate
toggle or IPC flag. Select `gpt-6-sol` for standard access. Internally the alias
sends the base model plus `access_programs.cyber: "daybreak_blue"`, independently
of effort and speed.

`account` with `provider: "anthropic"` lists Claude accounts, or with
`action: "add" | "remove"` and `target` registers or unregisters one (see
[Several Claude accounts](claude-accounts.md)); the reply is an `auth_status`
message. Claude accounts are chosen per conversation, never switched globally.

`accounts` answers with an `accounts` event carrying an `AccountsSnapshot`, the
structured data behind the TUI's Accounts screen (`/accounts`, `g a`): each
Claude account's sign-in state, plan, its own windows, running turns and the
conversations on it (running or with a warm cache), the combined usage, the
routing policy and where new work would go, plus the OpenAI account pool.
`enabled` says whether several accounts are set up. `convId` asks for that
conversation's account (`claude.currentConversation`). With `watch: true` the
daemon also pushes `accounts` events without a `reqId` whenever a sign-in,
usage, limit or running turn changes (at most every 250 ms), and refreshes
stale sign-ins and idle usage every minute, until `watch: false` or the
connection closes; it registers no watcher while `enabled` is false. The
answer itself only reports what is already known, so it is immediate.
While Claude goes through [/proxy](provider-proxy.md), `claude` holds the
remote daemon's accounts with `claude.remote` (alias, host, link state);
conversation rows marked `remote` are the remote's own
and cannot be opened here. `claude.proxied` is true only while the remote's
accounts are unknown.

`transcribe_audio` and `generate_image` run a provider call with the
daemon's own OpenAI login and answer `transcription_result` /
`image_generation_result`. The `transcribe` and `image` tools use them, so no
provider credential is ever handed to a tool process, its argv, environment or
command text.

`provider_proxy` lists, enables or disables [/proxy](provider-proxy.md);
daemons also speak the `provider_proxy_*` link messages to each other over
`exocortexd proxy`.

## Connecting and the bootstrap

A client declares what it understands with `client_capabilities`, then sends
`ping`. The daemon answers with `pong` and the first screen's state, all of it
kept ready in memory: `tools_available` (providers, auth, tool styles,
conversation defaults), `user_macros`, the last `usage_update` per provider,
`update_status` (capable clients, once known), then the large
`conversations_list`, `queue_updated` and `connectivity_status`. Small events go
first so they never wait behind the list over a slow link.

The conversation list is incremental for clients that declare
`sidebar-incremental` and send a `sidebarView` with their capabilities (what
their sidebar draws first: folder view, expanded folders, scroll offset,
terminal rows, the open and cursor conversations). Right after the `pong`
comes a first page: every folder; the conversations on the first
`scrollOffset + rows + max(rows, 40)` rows of that view (the walk mirrors the
TUI's layout, `shared/src/sidebar-first-page.ts`); every conversation showing
activity (streaming, unread, tasks, subagents, background work, queued
messages) and the view's named conversations; plus `folderConversationCounts`.
So the rows on screen, folder counts and badges are exactly what the full list
gives. The bootstrap ends with the rest (`sidebarRest`, folders omitted), from
the same snapshot with nothing that changes the sidebar in between; the
client rebuilds the whole list before anything else uses it. A client
reconnecting with a sidebar digest gets the digest's delta instead. Search and
scrolling far down use the whole list, which lands ~0.1 s after the first frame
over a 20 Mbit link.

Requests a client needs on the first screen ride the same write instead of
waiting for the pong: the TUI sends its saved conversation's
`load_conversation` (and `accounts`, which the Accounts screen opens with)
together with the `ping`. Over `/ssh` the reachability probe is that first
write: `client_capabilities` (with a sidebar digest when the TUI already holds
this host's list, else its `sidebarView`), the conversation to reopen, then
the `ping`. Answers that arrive before the probe's `pong` are kept and
delivered once the connection is adopted. With `--ssh` the TUI asks the local
daemon for no bootstrap of its own unless the switch fails. The TUI draws a
remote route once its conversation (or list) and tool styles are in, without
waiting for the whole list. The `exocortexd proxy` at the far end loads only
the stdio bridge (`daemon/src/proxy-main.ts`), and the TUI reuses one SSH
connection per alias ([SSH connection reuse](ssh-connection-reuse.md)).

## Connectivity

One connectivity monitor per daemon decides whether the network is reachable
(see [network outages](network-outages.md)). `connectivity_status` carries
`online`, `offlineSince` and `nextProbeAt`; it is broadcast on every change and
sent after `ping`. A turn waiting for the network sends its subscribers
`connection_wait_status` (`active`, `startedAt`), and `streaming_started`
snapshots carry `connectionWaitStartedAt` for late joiners. Stop it with
`abort` like any turn.

## Instructions

Three scopes add to the system prompt: a conversation's own instructions, its
folder's (and every parent folder's) AGENTS.md text, and the global
instructions every conversation gets. Global is two files layered in order: the
tracked upstream base `config/system.base.md` (read-only over IPC; agents edit
it only when the user explicitly asks) and this install's own gitignored
`config/system.md`. `load_instructions` (`convId`, `folderId`, both optional)
answers `instructions_loaded` with each scope's own text, `null` for a scope
that does not apply; `global` is `config/system.md` alone and `globalBase` the
base (absent from older daemons). `set_system_instructions`, `set_folder_instructions` and
`set_global_instructions` write one scope; empty text clears it. The last takes
an optional `expectedText` and is refused if `config/system.md` changed since it
was read; it never touches the base, and broadcasts `global_instructions_updated`.
`set_system_instructions` on a streaming conversation is accepted too: the text
is persisted as pending, every read (`load_instructions`, the pinned history
entry, the next turn's system prompt) sees it at once, and it is written into
history when the conversation goes idle; the last save wins. The TUI's `/instructions`
picker and editor use these commands. Conversation and folder instructions are
still sent to clients as pinned `system_instructions` history entries; the TUI
does not draw them.

`load_tool_instructions` (`convId`, or a draft's `provider` and `model`) is
read-only and answers `tool_instructions_loaded` with what that route tells the
model about each tool: `internal` entries carry the schema `description` and
the `hint` from the system prompt's `# Internal tools` section (under Claude
Code, the exocortex MCP server's instructions, with `hintSource`); `external`
entries carry each manifest's `systemHint` as injected. Every entry names its
`source` file, and `route` says in a sentence how the text reaches the model.
It is built from the same pieces as the request surface, so it never drifts
from a real turn. `/instructions tools` shows it; `/instructions
conversation|folder|global` (or `c`/`f`/`g`) open a scope's editor directly.

## User macros

The connected daemon owns `config/macros.json` on its host. After `ping` it
sends `user_macros` with the whole list. `save_user_macro` (`macro`, optional
`create` to refuse replacing one) and `delete_user_macro` (`name`) validate,
write the file atomically, broadcast the new `user_macros` to every client and
send the requester a copy carrying `reqId` and `change`. Clients check names
against their built-in commands and macros before saving; see
[Macros](macros.md).

## New-conversation defaults

The connected daemon owns `defaults.conversation` in its host's config.
Normal `ping` bootstrap includes a small `conversationDefaults` snapshot in
`tools_available`; the TUI caches it for display and `/new`. `/ssh` discards
the old endpoint's cache and adopts the new host's bootstrap.

`set_conversation_defaults` validates and persists a complete selection;
`reset_conversation_defaults` removes the override. Both broadcast
`conversation_defaults` and send a request-correlated confirmation. The TUI's
`/default-model` uses these commands, never local config reads/writes.
Changes do not alter existing conversations or other clients' edited drafts.

The native `exo` tool starts a subagent, messages or reports the status of an
existing conversation, aborts one, or restarts the daemon. A message to a
streaming conversation is an automated entry on the durable queue (as
`queue_message` makes); one to an idle conversation starts its turn at once and
notifies the caller when it ends, like a subagent turn.

Every prompt that is not the owner's keyboard is stored with
`metadata.automation` (kind and `sourceId`), which clients render as automated
with a reason line; untagged user messages are the owner's. The external `exo`
CLI marks its `send_message`/`queue_message` with `delegation: true` and
`sender` (its shell's `EXOCORTEX_PARENT_CONV_ID`): the daemon stores them as
`exo_send` from that conversation (from the notified parent, or no source, when
there is none). A foreground CLI send's reply goes to the CLI only, never also
reported to a parent. Tool
selection and conversation-scoped custom modules are retired; old persisted
policies are retained as opaque historical data for lossless import/export.
Old selection requests receive an explicit error; they have no mutation API,
availability projection, or UI snapshot in the current implementation.
