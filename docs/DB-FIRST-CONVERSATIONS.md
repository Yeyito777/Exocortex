# DB-first conversations

## Goal

Make the normalized store authoritative for every structurally complete conversation message, including while a provider stream is active. Opening and paging a conversation must be proportional to the requested display page plus the one incomplete provider response, never to retained transcript bytes.

## Invariants

1. **Exactly one canonical copy.** A structurally complete user, assistant, tool-result, retry, compaction, or system message is appended to canonical conversation history exactly once before subsequent provider work depends on it.
2. **Pending means incomplete.** Active stream state contains only the current structurally incomplete provider response and its counters. It never mirrors completed canonical messages.
3. **Atomic promotion.** Completing or salvaging a provider response appends its canonical message/display delta and clears the corresponding pending state at one explicit commit boundary.
4. **Bounded reads while streaming.** Conversation open and older-history requests read the durable display index for the requested user-turn page regardless of streaming status, then attach only the pending provider response.
5. **Monotonic identity.** Canonical appends use the expected durable message count/generation. Stale or non-tail writes fail instead of duplicating history.
6. **Append hot path.** Ordinary appends do not scan or snapshot pre-existing messages and do not rebuild display history before the currently affected display entry.
7. **Rewrites are explicit.** Unwind, edit/replay, trim, repair, import, and in-place context-attribution updates use a separate rewrite/update path and may be proportional to the affected history.
8. **Race-safe late join.** A client receives a durable page, subscribes, and then receives an authoritative pending-stream snapshot/sequence without rebuilding canonical history. It cannot miss or duplicate chunks across that boundary.

## Storage/read model

- `messages` and `message_blobs` remain the canonical provider/audit transcript.
- `display_entries` remains the compact indexed display projection. Appends update only its tail; tool-result bodies never enter this projection.
- Runtime stream state retains abort/transport coordination and the current partial block accumulator only. A later schema may persist this accumulator for crash recovery, but persistence does not make it canonical history.
- `loadDisplayPage` is valid during streaming whenever the store's durable message count matches the in-memory canonical count and no unrelated rewrite is dirty.

## Sequential migration

1. Add repository/domain append APIs and parity tests for JSON and SQLite.
2. Move user-message and completed-round commits to the append API.
3. Delete completed-message streaming mirrors and make retries/markers canonical immediately.
4. Use durable pages for streaming open/history and derive catch-up directly from partial state.
5. Delete full-history streaming reconciliation and retain whole-save only for explicit rewrites.

## Required coverage

- Tail append is durable after reopen and rejects an incorrect expected boundary.
- Appending tool rounds updates compact display history without storing tool output there.
- Streaming open/history uses the stored page and includes the current partial blocks exactly once.
- A completed round is visible from the DB page before the next provider round starts.
- Retry, compaction, queued next-turn, external interjection, abort, and success ordering remain canonical.
- Targeted unwind accepts paged fingerprints and rejects stale targets.
- Late join at the load/subscribe boundary misses no stream sequence.
- A large historical tool output does not change streaming-open work or payload size.

## Validation profile (2026-08-07)

The production conversation `1785164114068-pcefmx` was copied transactionally from the live SQLite database into the isolated worktree. The snapshot contained 7,074 stored messages, 422 display entries, and 98,415,097 bytes of canonical message content. No live/main data was modified.

### Simulated active-stream open

The canonical conversation was loaded before timing (matching an actual active provider turn), then marked active with a 50 KB pending response. Over 39 warm iterations:

- Durable five-turn page read: **1.52 ms median**, **2.25 ms p95**; `displayPageHit=true`, `buildMs=0`.
- Complete handler open plus pending catch-up: **2.42 ms median**, **3.14 ms p95**.
- Combined `conversation_loaded` and `streaming_started` payload: **156,503 bytes**.
- Full-history fallback, retained only for compatibility/maintenance: **338.9 ms build + 16.0 ms serialization**, with a **5,732,513-byte** payload.

Loading and rehydrating all 98 MB of canonical history took 613.8 ms, but that is provider-context/active-conversation startup work. The paginated open path neither performs nor repeats it.

### xenv + exotest TUI result

An isolated `xenv`/`exotest` instance opened the copied conversation through the real daemon and TUI:

- Daemon open: **5.05 ms** total; stored page read **3.21 ms**, projection build **0 ms**.
- TUI request-to-response: **5.80 ms**.
- TUI apply: **0.72 ms**; terminal render: **14.24 ms**.
- Request to completed first render: approximately **21 ms**.
- Initial response: **56,988 bytes**, 12 entries. The automatic ten-turn backfill ran after first render and therefore did not delay it.

### Automated validation

- Shared, daemon, and TUI typechecks passed.
- The DB-first repository/orchestrator/open/race/unwind/compaction suites passed (187 tests in the focused final run).
- The complete repository run had 1,727 passing tests and one unrelated environment-sensitive failure: the DeepSeek auth test observed the developer machine's configured credential in the shared-process run. That test passed 2/2 in an isolated config directory.
- Worktree daemon and TUI startup, conversation open/render, and shutdown were validated with `xenv` + `exotest`; all temporary profile data was removed afterward.
