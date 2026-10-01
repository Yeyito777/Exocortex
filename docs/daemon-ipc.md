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
Managed task inspection/stopping uses `list_tasks` / `stop_task`; task IDs are
not raw PIDs. Use `abort` for subagent conversations and Chrono cancellation
for schedules.
Never restart the main daemon.

The native `exo` tool only starts a subagent or aborts a conversation. Tool
selection and conversation-scoped custom modules are retired; old persisted
policies are retained as inert historical data.
