# Internal tool policies and task lifecycle

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
- `stop_task`, restricted to an owned active background task;
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
