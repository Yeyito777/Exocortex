# Codex model catalog

Verified 2026-09-29 against Codex `ceea67163f` (`codex-rs/models-manager/models.json`)
and the account's `/backend-api/codex/models` response.

- New model: `gpt-6.1-sol`, 272K Codex context, low default effort,
  low/medium/high/xhigh/max/ultra, Responses Lite, low verbosity.
  Ultra reasoning maps to `xhigh` with delegation instructions, as in Codex.
- Latest size aliases: Astra = GPT-6, Sol = GPT-6.1, Luna = GPT-6;
  Terra remains GPT-5.6. Existing conversation/default model IDs are not rewritten.
- `/fast on` still means `service_tier: "priority"`; `/fast off` means standard.
  `/ultrafast [on|off]` independently selects the distinct `service_tier: "ultrafast"`
  only when advertised for the model/account. Both commands toggle their own tier
  when called without arguments and work inline, e.g. `explain this /ultrafast`
  or `/ultrafast on explain this`. `/default-model ... ultrafast` still saves it
  as the default tier.
  Missing metadata does not grant Ultrafast access. At verification time this
  Codex account advertised Priority only, despite public API Ultrafast availability.
  A fresh check with Codex client versions 0.160.0 and 0.161.0 also advertised
  only Priority. The default client version is now 0.161.0: 0.153.4 omitted the
  GPT-6.1 catalog metadata. Syntax highlighting/completion does not depend on
  entitlement; an unavailable inline Ultrafast selection blocks submission and
  leaves the prompt/settings intact rather than silently sending at another tier.
- Reasoning `ultra` and the Ultrafast service tier are independent settings.
- `/model <provider> <model>` also works inside a prompt, e.g.
  `/model openai gpt-6.1-sol /effort max explain this` or
  `explain this /model openai gpt-6.1-sol`. Model changes persist in the
  conversation, just like standalone `/model`; streaming conversations cannot
  switch models. Modifiers are applied in textual order and invalid selections
  block submission without partially changing settings.

## Daybreak (October 6, 2026)

Checked against Codex `0b863c69f5`, notably `tui/src/daybreak.rs`,
`protocol/src/openai_models/access_programs.rs`, and `codex-api/src/common.rs`.
Daybreak is a per-conversation preference selecting a per-request cyber access
program, not a model slug or a Responses Lite switch.

- Exocortex exposes standalone `/daybreak [on|off]` for **Sol / Daybreak Blue**.
  No argument toggles. New chats start off; drafts capture the setting on creation.
- Discovery must advertise `available_access_programs.cyber: ["daybreak_blue", ...]`
  on that exact Sol model. No fallback entitlement, and no automatic model substitution.
  The current account advertises Blue on **GPT-6 Sol**, but not GPT-6.1 Sol.
- Requests keep the selected model, effort, tools, and speed; they add
  `access_programs: { cyber: "daybreak_blue" }`. Off sends `"standard"` when
  advertised, otherwise omits the field. HTTP, WebSocket, retries, tool rounds,
  replay, and native/plaintext compaction share the same treatment.
- Conversation storage, summaries, queues, cloning, and resumed clients retain
  the preference. Account/catalog changes cannot silently downgrade enabled turns.
  Changing the toggle while streaming is rejected; switching to an unsupported
  model turns it off. Inference still enforces server-side authorization.
- The retired hidden model is no longer listed or accepted for new selections.
  Old `gpt-daybreak-blue-latest` conversations migrate to GPT-6 Sol with Daybreak
  on, preserving historical messages and compaction provenance.

Validation:

- Typecheck passes; shared/TUI suite: 1,249 passed.
- Daybreak boundary/turn/queue/compaction cases and HTTP/WebSocket wire tests pass.
  Storage/migration/loader regression group: 47 passed.
- Nested `dwm`/`exotest`: live Sol request returned `DAYBREAK_OK`; toggle on/off,
  unsupported GPT-6.1 rejection, and persisted reload after test-daemon restart checked.
- Full daemon suite is not green: two clone-integrity failures and a shell
  startup timing failure were reproduced on untouched `34031f8`. Cooperative
  loader/background timing assertions also varied under load. These unrelated
  tests were not weakened or changed.

## ChatGPT subscription eligibility (September 29, 2026)

OpenAI introduced **Pro 500 ($500/month)** on September 29. Among Pro plans,
Astra Ultrafast is available only on Pro 500 at launch. Pro 100 and Pro 200
do not gain access by purchasing credits; grandfathered Pro 200 usage does not
grant Ultrafast either. Eligible Enterprise/Edu workspaces have separate
billing, admin, and inference-residency requirements. No date for Pro 200
Ultrafast access is announced in these sources.

- https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers
- https://learn.chatgpt.com/docs/agent-configuration/speed

This is separate from API Ultrafast availability. Subscription included-usage
and credit multipliers are not API token prices.

Pricing sources (API-cost estimates, not ChatGPT subscription charges):

- https://developers.openai.com/api/docs/models/gpt-6.1-sol
- https://developers.openai.com/api/docs/pricing?latest-pricing=ultrafast
- https://developers.openai.com/api/docs/guides/ultrafast-mode

GPT-6.1 Sol cached reads are 5%, not GPT-6 Sol's 10%. Published Astra Ultrafast
rates are recorded separately; unpublished model/tier combinations stay unpriced.

## Initial implementation validation (before the separate `/ultrafast` command)

- `bun test tui/src shared/src`: 1,127 passed.
- `bun test daemon/src`: 1,133 passed; two existing failing test groups
  (oversized-image compaction and orchestrator persistence). Both reproduced
  on the unchanged base commit `7691938` in a separate, temporary worktree.
- Shared/daemon typechecks pass. The TUI typecheck still reports the same
  pre-existing narrowing error at `historynavigation.test.ts:79`, also reproduced
  on that base commit.
- Nested `dwm` + `exotest`: live GPT-6.1 Sol replies succeeded in standard and
  Fast modes; unadvertised Ultrafast was rejected without changing the tier.
  Migration, reopen/clone, capability gating, wire/billing tier, and exact pricing
  are covered by regression tests.
