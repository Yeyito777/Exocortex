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
`detach: true` suppresses completion notifications (see Notifications below). The tool result reports
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

At most 32 subagents run at once directly under any one conversation (its own
children; each child counts its own separately), and at most 64 across the
whole daemon at any depth. Finished subagents stop counting.

- **Prompt.** Every subagent's system prompt (both providers) gets a
  Delegation section: it is already a subagent, at depth N of M, under parent
  conversation X; either it may delegate (and how many more levels) or it
  cannot. One that may delegate is told to do so only for clearly separable
  multi-hour work, never its whole task, never back to its parent or above,
  and to wait for its children (`chrono wait` on their conversation ids)
  before reporting. The shared `exo` hint says only that nesting is bounded.
- **Caps.** The per-parent cap (8) counts a conversation's own running
  children; the daemon cap (32) counts every running subagent at any depth.
- **Ownership.** A subagent may abort only its direct children, and message
  only its direct children and its own parent, at every depth (never a
  sibling or anyone further up). `chrono wait` from any subagent is limited to
  its own tasks. No subagent can restart the daemon.
- **Messaging the parent.** `exo message` with the caller's parent id (which
  its prompt states) queues an automated `exo_send` prompt tagged with the
  child as sender, the same as a child's `exo queue` report: a busy parent
  takes it at its next tool boundary (or after its turn, with `after_turn`),
  an idle one starts a turn from the queue. It requests no reply: no record
  reports the parent's turn back down, so parent and child cannot ping-pong.
  The child's prompt says its final reply already reaches the parent, so the
  message is for mid-task questions and handoffs.
- **Notifications.** A grandchild reports to its own parent, never past it.
  Every turn a non-detached subagent ends is reported to its parent, whatever
  woke it: its task, a parent message to an idle child, and any automated
  input reaching a child whose task already reported (a parent's or
  sibling's message, its own subagent's result, a finished background task, a
  wake, an external notification, a goal continuation), whether that input
  starts the turn or joins a running one at a tool boundary. One record
  reports each turn: input joining a turn that already has one adds none, and
  a turn whose sender awaits the reply itself (a foreground `exo send`) is not
  reported. Restart notices carry on a turn already accounted for. Turns the
  owner starts by typing into the child are theirs: no notice, but the child
  shows as running in its parent's Tasks while they run. A notice's `Result`
  (or a stopped turn's `Partial output`) is the turn's final message, its text
  after the last tool call, falling back to its last non-empty text block; the
  progress lines before it stay in the child's conversation. A notice whose
  child still has running background tasks or subagents, one-shot wakes
  (repeating wakes never end, so they don't count) or queued input reads
  `Subagent replied (still working)` and lists them; another notice follows
  when it next stops. A follow-up notice names what woke the child. A child
  started with `detach: true` never reports.
- **Abort.** `exo abort` cascades: the target's running subagents at every
  depth are aborted first and listed as `aborted_subagents`. Automated input
  already queued for an aborted conversation (its parent's messages, its own
  subagents' results, wakes) is dropped, so it does not start again; the
  user's own queued messages stay. The caller gets the result and no notice.
  Any other stop of a reported turn (Stop in the TUI, a cancelled sleep, an
  edit) sends the parent `Subagent stopped` with any partial output instead
  of dropping the child from its Tasks panel silently. A child that finishes
  normally, or a stop from the TUI, leaves its running children alone; they
  report to it as above.
- **Display.** In a top-level conversation the TUI and phone fold everything
  its own subagents send it (their notices and `exo message`/`exo queue`
  reports) out of the default view, as they fold other notifications; the
  parent's reply stays. `Ctrl+O`/`Ctrl+I` show them as automated bubbles
  labelled `⚙ <reason> · from <child title>`. A subagent's conversation keeps
  its parent's prompts in view. Clients tell a child by the
  `parentConversationId` of its conversation summary.

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
