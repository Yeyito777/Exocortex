# Provider-specific coding primitives

The tool surface was reviewed against `openai/codex` commit
`4d8eca1ff34ff9da717323a7b0a5d0b5ebcf3bb6` (2026-09-14). This is an adapter to
Exocortex's runtime, not an embedded Codex daemon or a claim of sandbox parity.

OpenAI conversations expose `exec_command`, `write_stdin`, raw `apply_patch`, and
`view_image`. Other providers retain `bash`, `read`, `write`, `edit`, `patch`,
`glob`, and `grep`. Exocortex orchestration, Chrono, browsing, and external CLIs
remain available according to the conversation's tool policy. The `goal`
internal tool reports goal status (`show`, `complete`, `blocked`); creation,
editing, pausing, resuming, and clearing are user-controlled. See [Goals](goals.md).

## Provider boundary

`apply_patch` is an OpenAI custom tool with the Codex Lark grammar, in both
Responses and Responses Lite. Streaming raw text is converted to the internal
`{input: text}` representation. Replay emits `custom_tool_call` and the matching
`custom_tool_call_output`, including incremental WebSocket continuation. Other
providers can still replay the JSON-shaped internal transcript.

The patch engine is shared. The native adapter accepts absolute paths as well
as workspace-relative paths; the legacy `patch` tool retains its relative-path
contract. `view_image` shares the validated image pipeline, not the text reader.
Image detail and sandbox/environment arguments are not advertised because the
local runtime does not implement those optional upstream capabilities.

## Shell lifecycle

Both interfaces use `shell-runner.ts` and the isolated `bash-runner.ts`. The
command environment is explicitly forwarded over the private runner protocol,
including when systemd launches the runner. Like the legacy Bash tool, the
default is non-login Bash on POSIX (PowerShell on Windows), preserving the
daemon's configured PATH and auth environment. `shell` and `login` remain
explicit overrides; login startup files may change that environment.
The Codex surface keeps stdin open and optionally allocates a POSIX PTY. Sessions
are owned by a conversation and may be written/polled using `write_stdin`.
Yield time is not a process timeout. The current hard process limit is one hour;
output capture is capped at 16 MiB per Codex session with explicit truncation.

Yielded commands register ordinary Exocortex background tasks: Chrono can wait
on the returned `task_id` and `exo stop_task` can stop them. Unobserved completion
uses existing notifications; completion collected by an active tool call does
not inject a duplicate notification. Logs and detached task records participate
in recovery. Live stdin handles do **not** survive daemon restarts: recovered
tasks must be inspected/stopped through task management instead. Completed
stdin sessions expire after 30 minutes. PTYs currently require POSIX.

External CLI preparation, environment identity, and TUI manifest styling are
retained. Per-tool safety denylists are checked for both the new tool name and
its legacy counterpart. This is still local execution with daemon permissions,
not a Codex OS sandbox or a new approval system.

## Policy compatibility

Legacy stored policies translate when switching providers: `bash` grants the
two exec primitives, `patch` grants `apply_patch`, and `read` grants `view_image`.
The reverse mapping supports switching back. Goal is filtered from all policies.

**Restricted policies are conservative.** Read/glob/grep authority alone never
silently grants an arbitrary shell; edit/write authority alone never grants all
patch operations. Consequently an OpenAI research-only subagent without shell
permission cannot read/search text files through these primitives. Explicitly
delegate `exec_command` when that authority is intended, and `apply_patch` for
general mutation. New native primitive names are reserved against custom tools.

The legacy exact-edit implementation no longer uses whole-file Unicode/fuzzy
normalization. It rejects non-exact text (aside from matching line endings),
checks exact duplicates/overlaps, and preserves original text outside edited
spans, including mixed line endings.

## Validation

Regression suites cover both provider wire formats, raw Unicode patch replay,
ordinary JSON calls, provider/policy switching, goal status tool permissions,
absolute/relative patch adapters, exact-edit preservation, pipe and PTY stdin,
conversation ownership, output budgeting, cancellation, background records,
and external CLI display. Worktree testing additionally uses `xenv` + `exotest`
with a real OpenAI model to create/edit/read a file, interact with stdin, and
view an image.

The live worktree test also switched the same persisted conversation from
OpenAI to DeepSeek and back: DeepSeek used `read`/`edit`, then GPT-5.6 Terra used
raw `apply_patch`/`exec_command` successfully against the same scratch file.
