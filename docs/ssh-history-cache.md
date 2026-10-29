# SSH conversation history cache

Over `/ssh` the TUI keeps two caches of conversation history: the opened
conversations on disk, which make an open paint at once, and an in-memory
transport cache, which makes the open's request cheap. Both are content-checked:
neither can leave a stale transcript on screen.

## Opened conversations on disk

`tui/src/viewcache.ts` keeps, per SSH alias, the opening page and initial
backfill of the 64 most recently opened conversations (64 MiB at most, 8 MiB per
conversation, least recently opened out first) in
`config/runtime/ssh-view-cache/<alias>/`, as the daemon last sent them, with
the history revision they were built at. The directory is the index: a file's
name carries its conversation, revision and fold, its mtime the last open.

**Opening one** (`tui/src/cachedopen.ts`) paints the copy on the first frame,
as if the daemon had answered, placed like any open (saved position, unread
response), with the sidebar's newer model, effort and goal. The open's request
still goes out as before (it subscribes, clears unread and carries the copy's
entry hashes, so its answer is a delta). When the answer comes:

- **It matches** (same entries and cursors, no running turn): only metadata
  is applied (context size, BTW, goal). Nothing is redrawn.
- **It differs**: it is applied as the open landing, placed by that open's
  intent if the reader has not moved yet, else where they are. The bottom
  anchor holds and the change snaps (no smooth-scroll glide).

A copy is **current** when its revision is the latest this connection has
heard of and the conversation is not streaming. A copy not known current is
still painted at once, but the top bar says `↻ updating` if the answer has
not landed after `STALE_COPY_MARK_DELAY_MS` (250 ms; 0 marks it at once).
Until the answer, a stale copy fetches no older pages or elided work, whose
cursors may have moved.

**Revisions** (`daemon/src/conversations.ts`, protocol `HistoryRevisionsEvent`)
change with everything a history page shows: messages appended, edited in
place, unwound (edits, rewinds), trimmed or compacted, instructions set, a
move to another folder, a turn or handoff starting or ending (it changes what
folded pages elide). Pinned folder instructions (not drawn) and a running
turn's live tail are not covered; the open's content check catches them. They
are in memory: a restarted daemon starts a new epoch, so no revision from
before it matches one after it.

**Keeping copies current.** Clients with the `history-revisions` capability
get `history_revisions` pushes (coalesced, at most every 250 ms) for every
change. On each connection the TUI asks `get_history_revisions` for its cached
conversations. Stale copies among the 12 most recently opened, not streaming
and not open, are refreshed in the background 1.5 s after the last change, two
at a time, with `load_conversation { peek: true }`: the same pages, as a delta
against the copy, with no subscription, unread change, prewarm or catch-up.
So a conversation that changed while you were elsewhere is usually current
again before you return, and most opens need no round trip at all.

**Older daemons** answer `get_history_revisions` with an error: no copy is
ever current and nothing is peeked, but opens still paint the copy at once and
the answer confirms or replaces it. Older TUIs never send the new fields; the
daemon's additions are optional.

### Numbers

Real TUI (`scripts/dev/tui-stall-profile.ts --ssh --st`, 200x60) over the 100
ms fake SSH link, against a worktree daemon with four synthetic 40-turn tool
chats; time from the click to the first frame showing the conversation's
content (`~/Workspace/research/ssh-open-cache-20261029/measure.ts`):

| Open | Before | After |
| --- | ---: | ---: |
| Cached, unchanged | 106–110 ms (placeholder) | 2–4 ms, answer confirms it at ~107 ms, no redraw |
| Cached, last turn removed 0.5 s earlier | 110 ms (placeholder) | 2–3 ms, delta snaps in at ~107 ms |
| Cached, changed and refreshed in the background | 108 ms (placeholder) | 2 ms, already current |
| Never opened | 107–111 ms (placeholder) | 108–116 ms (unchanged path) |
| After a TUI restart (cache on disk) | 106–111 ms | 2–6 ms, every one opened before |
| After a daemon restart, before the refresh | 106–111 ms | 5 ms, confirmed by the answer |
| Streaming (live turn, read-only tap of a real daemon) | 114–124 ms | 4–7 ms; the live turn joins at ~115 ms |
| New TUI, older daemon | 107–111 ms | 3–12 ms (never current; answer confirms) |

No frame showed the placeholder or a smooth-scroll move on a cached open; at
600 ms RTT the stale copy painted in 10 ms and showed `↻ updating` from 250 ms
until its answer at ~617 ms.

## Transport cache

`/ssh` already adopts a persistent, compression-enabled SSH proxy. Conversation
opens already load five recent turns, then backfill ten more; expanded tool
outputs are fetched separately. However, both history pages were retransmitted
in full on every revisit.

The TUI now keeps a transport-only, in-memory LRU cache for remote history loads:

- Up to 64 pages / 8 MiB of estimated serialized-entry and hash storage, plus
  at most 8 MiB of request-pinned bases and 64 outstanding tracked requests.
- Cache entries are immutable serialized JSON, not mutable rendered blocks.
  Entries smaller than 257 characters are not cached: advertising a hash would
  consume too much of the potential bandwidth saving.
- The opening backfill rides the open itself (`initialBackfill`, see
  [direct daemon commands](daemon-ipc.md#opening-a-conversation)); its cursor
  is unknown when the open is sent, so its cached base is that conversation's
  previous opening backfill, which content hashes match however far the
  conversation has grown.
- Opening and backfill/viewport requests advertise SHA-256 hashes of entries
  from the corresponding cached page. The daemon compares them against the
  canonical page and sends fresh entries plus an ordered index map. This handles
  appended, edited, duplicated, truncated and shifted entries without relying on
  timestamps, message counts or append-only assumptions.
- Subscription, streaming catch-up, metadata, goals and BTW state
  retain their existing authoritative paths. This cache paints nothing itself;
  an open seeds it from the disk copy, so a TUI that just started still gets deltas.
- Reconstruction happens before existing TUI event handlers. Pending requests
  pin their own bases, so concurrent loads and LRU eviction cannot corrupt them.
  An invalid delta retries the original request once without cache hints.
- Successful endpoint switches clear the cache. Reconnects to the same endpoint
  discard pending bases but can reuse stored pages after content validation.
- Only opt-in requests receive deltas. Older clients receive full responses;
  older daemons ignore the optional hints and return full responses. Local loads
  do not incur cache serialization/hashing overhead.

### Validation

`bun run typecheck`; full TUI/shared tests; focused handler, client, SSH transport,
cache, late-join and edit-message integration tests. Cache tests cover bounded
storage/pins, concurrent responses, UI mutation, cache clearing, legacy peers,
malformed deltas and canonical transcript changes.

An `xenv` + `exotest ssh-conversation-cache` smoke test used two seeded 20-turn
conversations and an isolated SSH stand-in forwarding the real JSON-lines
protocol to the worktree daemon with 40 ms delay in each direction. Sidebar
revisits rendered correctly and reused both the opening and backfill pages:

| Response | Cold JSON bytes | Warm JSON bytes |
| --- | ---: | ---: |
| Opening | 91,600 | 2,690 |
| Backfill | 179,453 | 1,623 |

Warm request hash overhead was 357 + 692 bytes. These are **uncompressed protocol
bytes on synthetic transcripts**, not measured SSH throughput or a real-network
latency claim. SSH already uses `-C`; savings depend on transcript size, changes
and compressibility. Cold opens, round-trip count and rendering work are not
eliminated by this change. Both the TUI and remote daemon need the new code to
benefit from incremental responses.
