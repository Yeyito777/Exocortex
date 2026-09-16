# Goals

A goal is a persistent objective plus permission to continue ordinary assistant
turns. There is no hidden controller model, projected review transcript, or
controller-generated instruction.

## Commands

- `/goal <objective>` sets/replaces an objective, including while streaming.
  The current turn finishes first; the next goal turn receives the new objective.
  Reports from the old turn cannot complete or block the replacement.
- `/goal --max-turns 20 <objective>` limits **automatic continuation turns**.
  This is not a token/spend limit and does not bound tool rounds inside a turn.
  The initial goal-only turn counts; explicit user turns and suspended-turn
  replays do not. Usage is retained across resumes.
- `/goal` shows the objective, status, continuation count/budget, and reason.
- `/goal pause` (or Stop) interrupts goal work and requires explicit resume.
- `/goal resume` resumes a paused/blocked goal. An exhausted budget requires
  resetting the goal with a new budget; complete goals require a new objective.
- `/goal complete` retains the completed goal and its result.
- `/goal clear` removes it.
  Completing or clearing stops future goal continuations, without interrupting
  the current turn (including its pending Chrono sleep).

The native `goal` tool can inspect the goal or report `complete`/`blocked` with
a nonempty reason. Completion should cite current verification of the full
objective. Blocked means no useful safe action remains without user input or an
external change; there is no mandatory three-turn rediscovery of known blockers.
Only active goals accept model lifecycle reports. The tool cannot change the
objective, create new goals, or resume stopped ones.

## Runtime

Successful active turns schedule a normal continuation with a stable prompt and
the same context/tools. Queued user input wins. Two consecutive empty responses,
terminal turn errors, missing goal-tool permission, or the continuation budget
stop automatic work with an explanatory blocked state. Explicit tool policies
are respected, not silently expanded.

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
