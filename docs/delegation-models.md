# Delegation defaults

Delegation is strongly discouraged by the native tool prompt and CLI help:
almost never use subagents; normally do implementation, research, review, and
testing directly. There is no user-permission gate in code.

`daemon/src/delegation-models.ts` owns model selection for native `exo send`,
native one-shot completions, and the external CLI's delegation IPC requests.

- Omitted model and effort use the user's `/default-model`, not the parent.
- `astra`, `sol`, `terra`, and `luna` select the latest available numeric
  generation **of that size** from the provider catalog. There is no fixed
  generation mapping; model discovery retains future size generations.
- Implicit outdated size defaults upgrade for delegation only. The saved
  configuration is unchanged; its effort is normalized for the selected model.
- Explicit older OpenAI models require `legacy: true` (CLI `--legacy`).
  The native model listing hides them unless explicitly requested with legacy.
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
