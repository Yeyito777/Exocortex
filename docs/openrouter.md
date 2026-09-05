# OpenRouter

OpenRouter is an API-key provider with a deliberately small curated catalog:

| Model ID | Role |
| --- | --- |
| `nousresearch/hermes-4-405b` | Default; strongest general-reasoning pick in this set |
| `nousresearch/hermes-4-70b` | Lower-cost reasoning; utility/title model |
| `cognitivecomputations/dolphin-mistral-24b-venice-edition` | Uncensored-oriented assistant |
| `thedrummer/cydonia-24b-v4.1` | Creative writing |

These are uncensored-oriented fine-tunes, not verified abliterated checkpoints.

Create an API key at <https://openrouter.ai/settings/keys>, then use:

```
/login openrouter <api-key>
/model openrouter nousresearch/hermes-4-405b
```

Alternatively configure `OPENROUTER_API_KEY` in the daemon environment. Login
verifies the authenticated `/key` endpoint (the public model catalog cannot
validate a key). Keys use the existing provider-auth store. `/logout openrouter`
clears stored credentials and the running process's environment key; an externally
configured environment key will return when that process is relaunched.

The public catalog refresh filters out unavailable models and updates context and
capability metadata. If discovery fails, conservative fallback metadata is used.
Unlisted custom model IDs are intentionally not accepted.

## Chat-only endpoints

At implementation time all four endpoints are text-only and advertise no native
tool support. The model picker and selection message say **chat-only**. Such turns
receive no tool schemas or external-tool instructions. Historical tool calls and
results are preserved as inert text when switching from an agent model, and
unexpected native tool calls are rejected rather than executed. XML/text emitted
by a model is never interpreted as a tool call.

If the catalog later advertises native tools, requests require parameter-supporting
routes rather than allowing OpenRouter to silently discard tool parameters.
Hermes offers reasoning **on/off**, not a promise of distinct effort budgets.

The adapter supports SSE text/reasoning and token usage. Account balance/rate-limit
widgets and routed dollar-cost accounting are not implemented; consult OpenRouter
for billed costs. API calls require your own key and may incur charges.

For an isolated compatible server, set `providers.openrouter.baseUrl` in config
or `OPENROUTER_BASE_URL` in the daemon environment (config takes precedence).
