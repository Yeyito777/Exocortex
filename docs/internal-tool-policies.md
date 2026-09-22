# Internal tool policies and task lifecycle

## Compact native Exocortex interface

The default `exo` schema exposes six actions:

- `send`: delegate with `title` + `text`, or message an existing `conversation_id`.
- `list`: find conversations.
- `tasks`: inspect active work.
- `read`: conversation history (current by default), or an exact active `task_id`.
- `stop`: stop one explicit `task_id` or abort one explicit `conversation_id`.
- `commands`: discover administration and detailed option schemas.

Sending defaults to detached execution with a completion notification and
`max_depth=0`. Use `mode:"wait"` to receive the result inline. Models default to
the configured choice; `commands/models` lists exact IDs. The native runtime
resolves `sol` and `luna` to `gpt-6-sol` and `gpt-6-luna` when available.
Otherwise (including `terra`), it requires exactly one OpenAI model with that
tier suffix; ambiguous/unavailable nicknames fail before creating a child.
Explicit older model IDs remain selectable.

Advanced options go in `args`. For example:

```json
{"action":"send","title":"Review parser safety","text":"Review /absolute/project/path","allow_edits":true}
{"action":"commands","command":"help","args":{"command":"send"}}
{"action":"read","conversation_id":"child-id","args":{"full":true,"limit":20}}
```

`read` with `args.view:"info"` returns conversation metadata. `jobs` and explicit
`queue` timing remain discoverable commands. Old action names/top-level options
remain accepted by the runtime for in-flight conversations. Advanced options
are validated before dispatch and cannot override action routing or duplicate
top-level fields. Status lines show a short title, not the entire delegated prompt;
the actual tool input and child task retain the full payload.

## Provider-specific capabilities

OpenAI coding sessions use `exec_command`, `write_stdin`, `apply_patch`, and
`view_image`. Restricted research selections retain `read`, `glob`, and `grep`
when no shell executor is enabled. Selecting a reader never grants shell or
file-mutation authority. Other providers retain the legacy coding tools.

Default subagents receive local readers/search, `browse`, and `exo`, but no
external CLIs. `allow_edits` remains a compatibility shorthand for adding shell,
mutation tools, and `chrono`; explicit tool selections are preferable.

Generated runtime guidance follows the effective selection. It does not
recommend unavailable editing, image, stdin, or shell tools. Depth-zero agents
receive task-only Exocortex guidance rather than delegation/admin instructions.
User-authored instructions and external CLI documentation are not rewritten.

## Depth-zero task management

`max_depth=0` limits delegation rather than removing `exo` altogether. The
runtime permits only:

- `tasks`, restricted to the calling conversation;
- `read` with `task_id`, restricted to an owned active task;
- `stop` with `task_id`, restricted to an owned active background task;
- command discovery/help for `task`, and `task info|stop` for owned active tasks.

Other actions, administrative commands, legacy aliases, foreign task IDs, and
daemon-wide listing are rejected. The persisted scoped depth ceiling is checked
as well as the active turn's depth. A parent can explicitly delegate a new turn
with a different budget through the existing send lifecycle.

These checks constrain the native orchestration capability, not arbitrary
processes: a shell remains broad host authority.

## Exact external selections

Default ordinary conversations discover newly installed external tools.
Explicit policies, including legacy policies without `knownExternal`, never
expand automatically. Scoped defaults remain external-tool-free. Enable a
new tool explicitly or reset an ordinary conversation to default discovery.

External CLIs remain ordinary shell calls with manifest-based TUI presentation.
Enabling any external CLI also enables the provider's shell transport. External
tool selection is a discovery/delegation policy, **not a process sandbox**.

## Completion-aware waits

`chrono wait` recognizes active tasks and up to 1,000 recent completions, kept
for one hour in the current daemon. Reusing an ID for new active work invalidates
its old completion. Unknown or expired IDs still fail.

Completion results are JSON with `task_id`, `status: "completed"`, `title`, and
`ended_at`. Shell jobs include `exit_code`, `signal`, `output_path`, and failure
details when available, even when the normal parent notification is suppressed.
Completion does not imply process success: inspect `exit_code` and `failure`.
Reaching the wait limit returns `status: "wait_limit_reached"` without stopping
the task. Depth-zero callers can wait only on owned tasks.

The bounded completion cache is not durable history. Restart recovery can
repopulate it from completed detached-process records it observes.

## Native Exocortex results and scheduling

Native Exocortex success/error outputs are JSON. Existing structured operations
retain their fields. Former text-only results now use:

- `conversation_id` and `status` for send/queue/delete/abort/rename;
- `message` for one-shot LLM output and assembled system prompts;
- `error` for failures, with a structured `command_help` object for command
  argument/handler errors.

Waiting sends return `conversation_id`, `status`, and `message` or `error`,
instead of requiring callers to extract an `exo:<id>` suffix.
The external debug CLI's own output contract is unchanged.

Discovered command arguments are validated against their declared schema
before the handler executes; no coercion or opaque-payload rewriting occurs.
Handlers still enforce operation-specific semantic rules.

The registry supports input-aware parallel safety. Exocortex inspection calls
can share a batch; mutations, sends/waits, and unknown operations stay exclusive.
