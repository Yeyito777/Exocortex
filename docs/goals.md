# Goals

A goal is a persistent objective plus permission to continue ordinary assistant
turns. There is no hidden controller model, projected review transcript, or
controller-generated instruction.

## Commands

- `/goal <objective>` sets/replaces an objective, including while streaming.
  The current turn finishes first; the next goal turn receives the new objective.
  Reports from the old turn cannot complete or block the replacement.
- `/goal max-time 9h2m1s <objective>` limits the goal's **active time**. Durations
  combine `d`, `h`, `m` and `s` in that order: `8h3m`, `1h`, `5m`, `2d`. Only
  time spent active counts; paused, blocked and complete periods do not, and
  usage is retained across resumes. When it runs out the goal is blocked and
  its work stops like `/goal pause`, even mid-turn. The old `--max-turns` flag
  is rejected and saved turn budgets are dropped on load.
- `/goal` shows the objective, status, time used/left, continuation count, and reason.
- `/goal pause` (or Stop) interrupts goal work and requires explicit resume.
- `/goal resume` resumes a paused/blocked goal. A used-up time limit requires
  setting the goal again with a larger max-time; complete goals require a new
  objective.
- `/goal complete` retains the completed goal and its result.
- `/goal clear` removes it.
  Completing or clearing stops future goal continuations, without interrupting
  the current turn (including its pending Chrono sleep).

The native `goal` tool can inspect the goal or report `complete`/`blocked` with
a nonempty reason. Completion should cite current verification of the full
objective. Blocked means no useful safe action remains without user input or an
external change; there is no mandatory three-turn rediscovery of known blockers.
Only active goals accept model lifecycle reports. The tool cannot change the
objective, create new goals, or resume stopped ones. Claude Code (anthropic)
conversations get the same tool as `mcp__exocortex__goal`, and the goal state
is appended to Claude Code's system prompt.

## Runtime

Successful active turns schedule a normal continuation with a stable prompt and
the same context/tools. Queued user input wins. Two consecutive empty responses,
terminal turn errors, a chat-only model, or the time limit
stop automatic work with an explanatory blocked state. The daemon enforces the
time limit with a timer (rescheduled on set/resume and at startup), so a goal
whose time ran out while the daemon was down is blocked before it can resume. Archived tool policies
no longer affect capabilities.

Chrono suspension is not a finished turn: it waits for its existing wake rather
than starting a fresh continuation. Stop closes a pending sleep without
scheduling model replay. It does not kill detached processes or cancel unrelated
recurring schedules; use the corresponding task/schedule controls for those.
Daemon restart preserves active work and replays interrupted turns before any
new continuation.

`active`, `paused`, `blocked`, and `complete` are durable states. New messages
alone do not resume paused/blocked goals. Completion remains queryable after
reload; only clear/replacement removes it.

Old controller-paused goals load as blocked with their existing reason. Old
`pausable`/`completable` permissions are ignored and stripped on load. Their slash
flags are rejected; recurring monitoring belongs in Chrono, not unfinishable
goals. Historical controller token statistics remain readable.
