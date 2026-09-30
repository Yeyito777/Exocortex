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
