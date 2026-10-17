# Correctness & robustness audit (Oct 2026)

Audit #4 of 4. This audit covers the daemon (orchestrator, streaming, queue, chrono,
subagent notifications, restart/adopt, account routing, usage-limit waits,
provider errors, persistence) and the TUI state machine. Performance, images
and the conversation-open flicker belonged to other agents.

## Method

- **Log history.** I mined `config/runtime/exocortex.log*` (Oct 10–17, about 21 MB) for
  recurring WARN/ERROR lines and traced each one to a cause. The live daemon's fd
  count (47 after 29 h) and its process tree showed no leak.
- **Reviews.** Six parallel read-only reviews covered the orchestrator,
  restart/adopt, chrono/notifications, persistence, the TUI and security.
  I only acted on candidates that held up once I read the code.
- **Tests.** Every fix has a regression test that fails without the fix. All
  of them use fake providers; no real model turns were made.
- **Real data.** I ran read-only checks against the live SQLite DB.

Severity × likelihood ranking: **S** = high (data loss, wrong outcome, crash),
**M** = user-visible misbehaviour, **L** = latent or rare.

## Fixed

| # | Sev | Finding | Evidence / repro | Fix |
|---|-----|---------|------------------|-----|
| 1 | S | **Sleeping non-Claude subagent reported "completed" on every restart.** A suspended deferred-sleep turn stamps turn-end metadata, so boot recovery read the pre-sleep narration (or nothing) as the final answer. The real result was later dropped. | `restart-recovery.test.ts` "suspended in a deferred chrono sleep…" | Children with a deferred sleep keep their notification and are left to the sleep's own replay (`1223361f`). |
| 2 | S | **Boot started queued turns before Claude Code adoption.** The queue pump fired about 120 ms after the queue loaded, while boot was still awaiting chrono and adoption. That replaced (killed) the adopted process, or, for other providers, answered the queued message instead of replaying the interrupted turn. | Log: `interrupted conversation … is already streaming; skipping` (2×, ~230 ms margin). Test: "holds boot-time queue delivery…" | Queue delivery is held until recovery has run (`a581cfe2`). |
| 3 | S | **Network/usage-limit re-sends kept the failed attempt's partial text.** Stop or a steer then persisted `STALE half-sentence fresh answer`, and the live view showed it duplicated. | `network-outage.cases.ts` "text streamed before the outage…" | `onAttemptDiscarded` resets partial state; clients get an empty `streaming_sync` (`e4b1abba`, `24b636ba`). |
| 4 | S | **OpenAI access token spliced into heredoc bodies.** Any heredoc line starting with an auth-requesting tool name (`image = …` in Python, markdown) got `'--exocortex-auth-openai' '<token>'` inserted. That corrupts files, puts the token in tracebacks and sends it to the model. No leaked token was found in the live DB (read-only scan), so this one was latent. | `external-tools.test.ts` heredoc cases | The splitter keeps heredoc bodies inside their segment (`b158621a`). |
| 5 | S | **A throwing queued-successor preflight leaked the stream handoff.** The successful predecessor turn rejected, and `isStreaming` stayed true with no job: spinner forever, "Already streaming", queue stalled. `orchestrateGoalCycle` leaked the same way on a failed async load. | `orchestrator-persistence.cases.ts` "successor whose preflight throws…" (queue write fails with `disk full`) | Catch and settle (`111b7adf`). |
| 6 | S | **A chrono state-write failure crashed the daemon on every boot.** Detached `void` work rejected, and unhandled rejections are fatal; startup re-runs due work. | `chrono-service.test.ts` "a failing state write…" (EISDIR) | Detached work is logged and retried after a 5 s backoff. A failed write is no longer recorded as the waited task's failure (`4f9d88da`). |
| 7 | M | **Failed IPC handlers never answered.** A rejected async handler was only logged, so the client's reqId hung; synchronous throws were reported as "Invalid JSON". | Log: `handler error for queue_message: NOT NULL constraint failed: queued_messages.timing` (2×). Tests in `server.test.ts` and `handler.test.ts` | Error with reqId/convId; `queue_message` validates `timing` (`f84d5d33`). |
| 8 | M | **exo message/abort couldn't reach a child sleeping in a deferred chrono wait.** Message threw "already has an interrupted parent notification"; abort returned "idle" and the sleep woke hours later. Stop, `/goal pause` and time limits left the parent's task "running" forever, so the next boot replayed the stopped child. | `handler.test.ts` "native exo message and abort reach a child suspended…" | `cancelSuspendedTurn` settles the notification; a message continues the task under its existing notification (`8d39e731`). |
| 9 | M | **Queued-turn admission used a stale snapshot of the queue entry.** An edit during admission was lost (the old text was sent); an unqueue was acknowledged but the message was sent anyway. | 2 cases in `orchestrator-persistence.cases.ts` | The entry is re-read right before commit (`80091966`). |
| 10 | M | **An attribution mark downgraded a pending full save.** On SQLite, `saveContextAttribution` recorded every message as saved without writing it, losing the aborted turn's `endedAt`/tokens. | SQLite case in `async-conversation-loading.cases.ts` (`endedAt` 99 → null) | Never narrow a pending full save (`bcd73b10`). |
| 11 | M | **Credentials written in place.** A crash mid-write meant "no credentials"; the next refresh rewrote the file with one provider and silently logged out the rest. | `store.test.ts` | tmp + rename; an unreadable file is kept as `.corrupt-<ts>` (`1c6126f2`). |
| 12 | M | **The prepared-restart state never ended if its caller died after `prepare_shutdown`.** For example, `exocortexd restart` run from a turn: preparing aborts that turn and its cgroup kills the script. The daemon stayed with the queue off, continuations off and restarts refused. | `handler.test.ts` "completes a prepared restart itself…" | It restarts itself after the settle budget plus 90 s (`4401f15a`). |
| 13 | M | **TUI:** a late (or reconnect-replayed) `conversation_loaded` yanked the user out of a new draft or the folder-instructions editor. | `events.test.ts` (5 cases) | Loads are correlated with the latest open request (`9daed0d9`, `01ae29d7`). |
| 14 | M | **TUI:** any unrelated error on the open conversation (for example a rejected `/instructions` while streaming) hid the whole live turn. | `replay.test.ts`, `client.test.ts` | Only an error with the send's reqId clears `pendingAI` (`6508cb52`). |
| 15 | M | **TUI:** rejected queue/BTW requests left optimistic rows that never settled, replayed on every reconnect (BTW cost an LLM call each time). | `client.test.ts`, `events.test.ts` | Settled by reqId (`b2add045`). |
| 16 | M | **TUI:** offline-queued commands were replayed to the new daemon after `/ssh`, for example starting a turn on the wrong host. | `client-ssh.test.ts` | Discarded on route switch (`e0dc7972`). |
| 17 | L | **TUI:** re-opening a conversation during a pending edit-unwind showed an endless spinner. | `editmessage.test.ts` | Its open request passes through (`c24b77ab`). |
| 18 | L | `flushAll` stopped at the first failed save, losing later dirty conversations at shutdown. | `conversations.test.ts` | Per-conversation catch (`97de5ad7`). |
| 19 | L | A completion notification retried while an unwind suspended delivery was queued twice. | `handler.test.ts` | Dedupe against the internal queue (`4fcf0b1b`). |
| 20 | L | A huge `after_seconds` installed an unformattable schedule; a migrated `# timeout:` over 24.9 days overflowed `setTimeout`. | `chrono-service.test.ts` | Bounds (`8930990b`). |
| 21 | L | An unreadable chrono/subagent-notification state file was silently overwritten (every schedule lost). | `chrono-service.test.ts` | Kept as `.corrupt-<ts>` (`0196772a`). |
| 22 | L | `restart-impact` counted `*.cases.ts` as daemon runtime. One imports the TUI client, so every TUI-only merge said "restart the daemon" (2 tests failed on main). | `restart-impact.test.ts` | `9ed1c59d`. |

## Log lines that are not bugs

- `You've hit your session limit` stream errors (22×, Oct 15–16) all predate
  the usage-limit wait (`757cb398`, deployed Oct 16 01:29Z). After that the log
  shows only routing to the other account.
- `chrono: occurrence … Scheduled command interrupted before completion`
  (10×) is the expected at-least-once behaviour. Shutdown aborts the running
  soft-wake, it is kept with `retryAt`, and it re-runs after boot. It is only
  logged at the wrong level (ERROR).
- `restart-recovery: subagent replay did not complete … ✗ Daemon restarted`
  is a boot replay that was itself interrupted by the next restart; it is
  replayed again.
- EPIPE/ECONNRESET are ordinary client disconnects.

## Not fixed (and why)

1. **`send_message` written into a half-dead SSH link is silently lost**
   (M–S for the owner's lossy `/ssh`). Only queue, unwind, ASR and BTW
   commands are replayed. The optimistic message disappears on reconnect and
   the prompt is already cleared. A correct fix needs an idempotency key:
   - The TUI keeps unacknowledged turn commands and resends them on reconnect.
   - The daemon dedupes on `(convId, startedAt)` against durable history and
     the active stream (it already echoes `user_message` with `startedAt`).
   - This is a protocol change across both packages; I suggest it as the next
     follow-up.
2. **Stop while Claude Code is taking queued input can send that input
   twice** (M, medium confidence; `orchestrator.ts` `drainNextTurnMessages`
   with `taken`).
   - Claude Code has accepted the input and the abort commits it as the
     session's `promptUuid`, but the drain bails on abort and leaves the queue
     entry, so the successor sends it again.
   - Fixing it means ordering the in-flight drain against the abort finalizer
     and the successor admission. I judged that too risky to change without a
     dedicated session-level test.
3. **Unwind/edit during a turn handoff doesn't cancel the pending successor**
   (L). `unwindTo` only aborts an active job.
4. **Adoption failing partway leaves reconnected relays attached but unowned**
   (L). The relay's orphan timer never arms; a replay can start a second
   Claude Code process on the same session.
5. **Boot replays are lost if a second restart lands during their preflight**
   (L). Shutdown records only conversations with an active job, not a handoff
   reservation.
6. **A requested restart's own turn is replayed anyway when its Claude Code
   process is adopted** (L).
7. **One corrupt JSON value in a startup SQLite table stops boot**
   (`listSummaries`/`loadQueuedMessages`/btw/tombstones; very low likelihood).
   Suggest per-row quarantine.
8. **Unbounded growth.** Trash is never purged and the undo stack is
   uncapped. Live DB: 8.0 GB, 1,602 trashed conversations (~313 MB of content
   kept forever), 3,139 undo rows.
9. **Security, multi-user hosts only.** The `/tmp` socket fallbacks for long
   paths (main socket and Claude relay) have predictable names and no owner
   check, so another local user could squat them. Single-user on whale.
   Also: the OpenAI OAuth callback can be cancelled by any web page while a
   login is pending (nuisance only), and the runtime directory and logs are
   0644 (home is 0700).
10. **The auth token reaches tools via `bash -c` argv**, visible in
    `/proc/*/cmdline` to the same host. Moving it to an env var or fd needs a
    CLI contract change in the external tools.
11. **Minor:**
    - The connectivity monitor can flip to offline right after a success.
    - The accounts watch keeps a closed client and its 60 s timer until
      another account change (OpenAI-only pools).
    - A command cancelled just after its chrono timeout still sends a hard wake.

## Suggested follow-ups

- Make `EXOCORTEX_CONVERSATION_STORE=sqlite` the default for the daemon test
  run, or run the suite under both backends. Most daemon tests exercise the
  JSON backend, which production no longer uses; finding 10 was invisible
  there.
- Turn idempotency for `send_message` / `new_conversation` (not-fixed #1).
- Demote the chrono "interrupted before completion" log line to INFO.

## Tests

- `bun run typecheck` is clean.
- Final full suites:
  - `bun test daemon`: 1594 pass, 5 fail. The 5 are the two known clone-cursor
    tests, plus `bash manual backgrounding` ×2 and `buildDaemonSpawnSpec`
    timing tests that fail the same way on main at load average ~24.
  - `bun test tui shared`: 1810 pass, 0 fail.
- The async-loading wrapper used to time out under full-suite load. Its child
  inherited the parent's test config dir, so it shared the parent's SQLite
  DB. It now gets a fresh dir (and a 15 s budget).
- Worktree note: a fresh `bun install` resolves newer bun-types (1.4.3) and
  produces a spurious typecheck error in `tools/bash-runner.ts`. Install from
  main's `bun.lock` with `--frozen-lockfile`.
