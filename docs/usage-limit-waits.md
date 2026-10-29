# Usage-limit waits (Claude)

Claude usage refusals are handled inside the active orchestrator turn, outside
the outage/watchdog retry loops (`daemon/src/usage-limit-wait.ts`). The provider
records the rejected account before the retry; a result without a preceding
rate-limit event also records a refusal. Machine reset metadata wins; daily
text hints with an explicit timezone are understood, and otherwise an unknown
refusal gets a conservative one-minute retry deadline.

Each provider attempt still calls the ordinary account router. A replacement
account therefore uses its existing routing, cross-account session continuation
and account-switch notice. When no account is usable, capacity is checked before
making a request. Local and proxy-pool snapshots use the same routing policy and
limited/blocked filtering. The wake is the earlier of the pool's next usable
reset and a 30-second capacity check; idle local usage/auth refreshes are shared
and capped to once a minute. Abort and steering reach a preemptible wait slot.

The turn remains active: no terminal error or completion notification is emitted
while waiting. Completed provider rounds stay in the live message array. On a
Claude limit result, uncommitted text/thinking and interrupted tools are committed
without a session resume marker, so the normal continuation prompt replays that
tail after the last safe session boundary.

An app conversation may choose not to wait (`route.whenLimited: "error"`: the
turn ends at once with `UsageLimitedError`, reported as `turn_result.limited`)
or not to use API credits (`route.credits: "never"`), see
[app API](app-api.md#accounts-and-api-credits).

Waiting uses the existing connection-wait status/snapshot with a usage label
(`reason: "usage_limit"`, `resetAt`),
and `ConversationSummary.providerWaiting` makes the shared sidebar/Tasks activity
indicator yellow. The wait pauses the stale-stream watchdog.

## Restart

There is no separate timer job to persist. Account limits are in the existing
usage cache; the existing interrupted-turn/replay machinery owns the durable
turn and subagent notification. On recovery, the pre-request capacity check
reconstructs the wait. The wait's original start timestamp is not retained.
Proxy recovery depends on the remote pool snapshot being available; an unknown
remote pool can be probed by a provider request.

## Scope and verification

OpenAI is unchanged: its existing `retryOnUsageLimitReset` opt-in remains.
Weekly/model-specific resets rely on machine rate-limit metadata; arbitrary
human-readable dated reset formats are not parsed.

Unit tests cover refusal recognition, timezone parsing, retry/abort and
reconstructing a wait. Isolated real-orchestrator cases cover partial output,
capacity reset, abort and subagent notification remaining `running` until the
real completion. The Claude stream test covers preserving unconfirmed deltas.
Existing account routing tests cover account ranking and switching.

A credential-isolated worktree daemon with a fake provider was driven through
the real TUI in nested Xephyr (`usage-limit-wait`). Screenshots and logs are in
`/tmp/usage-limit-wait/`: `waiting.png`, `continued.png`,
`restarted-waiting.png`, and `restarted-continued.png`. No real model requests
or account credentials were used.
