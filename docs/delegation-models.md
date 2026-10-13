# Delegation defaults

Exocortex subagents are the default delegation path for real work. The native
tool prompt routes to them building, fixing, or research that takes more than a
few minutes, and anything that should survive daemon restarts, model changes or
network outages, that the user may open or continue in the TUI, that reports
back via parent notification, or that commits to a repo. Trivial or quick work
stays with the caller; a user's prohibition always wins. There is no
user-permission gate in code.

Claude Code conversations also have Claude Code's own Agent tool. Their MCP
server instructions limit it to quick read-only fan-out within one turn
(search or exploration where only the conclusion matters); any other
delegation goes through `exo`.

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
family works from any parent. Parents cannot choose tools or additional
delegation depth. Children get the standard provider tools and all external
hints, and cannot delegate further. `detach: true` suppresses completion
notifications. The tool result reports the child's `provider`, `model` and
`effort`, plus `fast_mode: true` for Sol fast.

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
