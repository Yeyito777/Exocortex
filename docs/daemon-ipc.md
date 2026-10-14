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

`provider_proxy` lists, enables or disables [/proxy](provider-proxy.md);
daemons also speak the `provider_proxy_*` link messages to each other over
`exocortexd proxy`.

## Connectivity

One connectivity monitor per daemon decides whether the network is reachable
(see [network outages](network-outages.md)). `connectivity_status` carries
`online`, `offlineSince` and `nextProbeAt`; it is broadcast on every change and
sent after `ping`. A turn waiting for the network sends its subscribers
`connection_wait_status` (`active`, `startedAt`), and `streaming_started`
snapshots carry `connectionWaitStartedAt` for late joiners. Stop it with
`abort` like any turn.

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

The native `exo` tool only starts a subagent or aborts a conversation. Tool
selection and conversation-scoped custom modules are retired; old persisted
policies are retained as opaque historical data for lossless import/export.
Old selection requests receive an explicit error; they have no mutation API,
availability projection, or UI snapshot in the current implementation.
