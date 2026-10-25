# Delegation defaults

Exocortex subagents are the default delegation path for real work. The native
tool prompt routes to them building, fixing, or research that takes more than a
few minutes, and anything that should survive daemon restarts, model changes or
network outages, that the user may open or continue in the TUI, that reports
back via parent notification, or that commits to a repo. Trivial or quick work
stays with the caller; a user's prohibition always wins. There is no
user-permission gate in code.

Claude Code's own Agent tool is disabled for these conversations (`disallowedTools`
in `agentTurnOptions`) and their MCP server instructions forbid it: all subagent
work, including search and exploration fan-out, goes through `exo`.

The native `exo` accepts only `{subagent: prompt, args?: {detach?: boolean,
model?: string, effort?: EffortLevel}}`, `{abort: conversation_id}` or
`{restart: reason}`. `model` is one of:

- `sol fast`: the latest Sol in fast mode;
- `astra`: the latest Astra, without fast mode;
- a Claude family (`opus`, `sonnet`, …): its latest catalog model;
- an exact Claude catalog id such as `claude-opus-5-5`.

Other OpenAI sizes and ids, and Claude ids outside the provider catalog, are
rejected. The default depends on the parent's provider, not `/default-model`:
a Claude (`anthropic`) parent gets the latest Opus at `high` effort; every
other parent gets Sol fast. `effort` must be one the selected model supports;
omitted, it is `high` for Claude and the model's default for OpenAI. The
selected provider must be signed in (or proxied) and startable, so either
family works from any parent. Parents cannot choose tools or delegation
depth. Children get the standard provider tools and all external hints.
`detach: true` suppresses completion notifications. The tool result reports
the child's `provider`, `model` and `effort`, plus `fast_mode: true` for Sol
fast.

A child's conversation is titled with its prompt's first six words. Its entry
in the parent's Tasks panel (and the phone's Activity list) instead shows the
prompt itself: whitespace collapsed and clipped to 200 characters, stored as
the subagent policy's `taskLabel` so follow-up turns and restart recovery keep
it (older children fall back to their title). The TUI truncates the entry to
one row; expanded, it wraps up to three rows (~160 characters) and ellipsizes
the rest.

## Nested subagents

Subagents may start their own, down to `agent.maxSubagentDepth` in
`config/config.json` (default 2: top-level → child → grandchild; 1 restores
"children cannot delegate"; at most 8). Each child stores its depth in its
subagent policy (1 under a top-level conversation), so the limit holds
however a turn is started, including a user typing into the subagent; a
record from before nesting counts as depth 1. At the limit `exo subagent` is
refused with the caller's depth.

- **Prompt.** Every subagent's system prompt (both providers) gets a
  Delegation section: it is already a subagent, at depth N of M, under parent
  conversation X; either it may delegate (and how many more levels) or it
  cannot. One that may delegate is told to do so only for clearly separable
  multi-hour work, never its whole task, never back to its parent or above,
  and to wait for its children (`chrono wait` on their conversation ids)
  before reporting. The shared `exo` hint says only that nesting is bounded.
- **Caps.** The per-parent cap (8) counts a conversation's own running
  children; the daemon cap (32) counts every running subagent at any depth.
- **Ownership.** A subagent may message or abort only its direct children, at
  every depth. `chrono wait` from any subagent is limited to its own tasks.
  No subagent can restart the daemon.
- **Notifications.** A grandchild reports to its own parent, never past it.
  If that parent already reported its task, the notification starts a new
  turn in it (at once, or after its current turn when it is busy), and that
  turn's reply is relayed to its parent as a subagent completion (unless the
  child was started with `detach: true`). The same holds for a message the
  parent queued with `delivery: after_turn`: its reply is reported too.
- **Abort.** `exo abort` cascades: the target's running subagents at every
  depth are aborted first and listed as `aborted_subagents`. Automated input
  already queued for an aborted conversation (its parent's messages, its own
  subagents' results, wakes) is dropped, so it does not start again; the
  user's own queued messages stay. A child that finishes normally, or a stop
  from the TUI, leaves its running children alone; they report to it as
  above.

Administration goes directly through [daemon IPC](daemon-ipc.md).

`daemon/src/delegation-models.ts` still owns the external/debug CLI's delegation
IPC model selection. The compatibility rules below apply to that interface,
not the native tool:

- Omitted model and effort use the user's `/default-model`, not the parent.
- `astra`, `sol`, `terra`, and `luna` select the latest available numeric
  generation **of that size** from the provider catalog. There is no fixed
  generation mapping; model discovery retains future size generations.
- Implicit outdated size defaults upgrade for delegation only. The saved
  configuration is unchanged; its effort is normalized for the selected model.
- Explicit older OpenAI models require `legacy: true` (CLI `--legacy`).
  Aliases still mean latest even with the flag.
- A latest Terra may be from an older generation than latest Astra. Sizes are
  not silently substituted. An old unsized default requires legacy or an
  explicit current model, because it has no unambiguous same-size successor.
- Existing-target sends/queues validate before dispatch. Choose a current model
  on an idle target or explicitly opt into legacy; busy sends keep the current
  model, as before.
- Normal interactive conversation creation is unchanged. Legacy is a model
  compatibility opt-in, not a security boundary or a permission system.

Tests: `daemon/src/delegation-models.test.ts`, native runtime/tool tests,
`daemon/src/handler.test.ts`, and the separate `exo-cli` repository's
`src/delegation.test.ts` / `src/payload-cli.test.ts`.
