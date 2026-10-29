# SSH conversation history cache

Over `/ssh` the TUI keeps two caches of conversation history: the opened
conversations on disk, which make an open paint at once, and an in-memory
transport cache, which makes the open's request cheap. Both are content-checked:
neither can leave a stale transcript on screen.

## Opened conversations on disk

`tui/src/viewcache.ts` keeps, per SSH alias, the opening page, initial
backfill and a running turn's live part (its pendingAI, without tool output)
of the 64 most recently opened conversations (64 MiB at most, 8 MiB per
conversation, least recently opened out first) in
`config/runtime/ssh-view-cache/<alias>/`, as the daemon last sent them, with
the history revision they were built at. The directory is the index: a file's
name carries its conversation, revision and fold, its mtime the last open.
Copies that pushes update are written at most every 5 s, and on exit.

**Opening one** (`tui/src/cachedopen.ts`) paints the copy on the first frame,
as if the daemon had answered, a running turn's live part and status rows
included, placed like any open (saved position, unread response), with the
sidebar's newer model, effort and goal. The open's request still goes out as
before (it subscribes and clears unread); it names the copy, by number when
the daemon keeps it current (`baseCopy`, below), else by entry hashes and
`liveBase`, so its answer carries only what is newer. When the answer comes:

- **It matches** (same entries and cursors, a live part that only grew):
  only metadata is applied (context size, BTW, goal), and newer live text
  and blocks stream in where the copy left off. Nothing else is redrawn.
- **It differs**: it is applied as the open landing, placed by that open's
  intent if the reader has not moved yet, else where they are. The bottom
  anchor holds and the change snaps (no smooth-scroll glide).

A copy is **current** when its revision is the latest this connection has
heard of, and either the conversation is idle or the daemon is keeping its
live part current (within one push). A copy not known current is
still painted at once, but the top bar says `↻ updating` if the answer has
not landed after `STALE_COPY_MARK_DELAY_MS` (250 ms; 0 marks it at once).
Until the answer, a stale copy fetches no older pages or elided work, whose
cursors may have moved.

**Revisions** (`daemon/src/conversations.ts`, protocol `HistoryRevisionsEvent`)
change with everything a history page shows: messages appended, edited in
place, unwound (edits, rewinds), trimmed or compacted, instructions set, a
move to another folder, a turn or handoff starting or ending (it changes what
folded pages elide). Pinned folder instructions (not drawn) are not covered,
nor is a running turn's live tail (pushes carry that); the open's content
check catches either. They
are in memory: a restarted daemon starts a new epoch, so no revision from
before it matches one after it.

**Keeping copies current.** Clients with the `history-revisions` capability
get `history_revisions` pushes (coalesced, at most every 250 ms) for every
change. On each connection the TUI asks `get_history_revisions` for its cached
conversations. Stale copies among the 12 most recently opened (and running
ones the daemon does not keep current yet), not open, are refreshed in the
background 1.5 s after the last change, two at a time, with
`load_conversation { peek: true }`: the same pages, as a delta against the
copy, with no subscription, unread change, prewarm or catch-up.

**Pushes** (`history-push`, protocol `HistoryPushEvent`). Every open and peek
asks with `watch`: the daemon then keeps a record of the copy it sent that
connection (its page, backfill and live blocks, by hash; the 16 most recently
watched, `daemon/src/handler.ts`) and numbers it (`copySeq`). Whenever one
changes while the client is not subscribed to it, the daemon sends a
`history_push` at most every 500 ms: a changed page as entry indexes into the
last one plus a changed AI entry's new blocks (`entryBlocks`, so a round
committed to a long turn sends that round, not the turn), an unchanged
backfill not at all, and the live part as the base's blocks kept plus the
text appended to the last one (`blocksBase`, shared/src/live-delta.ts), tool
output left out (`load_tool_outputs` serves a running round's results when
they are shown). Each push names the copy it updates; the TUI applies it only
to that copy, and peeks one it cannot. An open of a watched copy names it
(`baseCopy`) and its answer is encoded against the daemon's record, so neither
side resends or describes the copy; the subscription's catch-up leaves out the
blocks the answer already carried. So a conversation that changed, or is
streaming, while you were elsewhere is current when you return, its turn in
progress included.

**Older daemons** answer `get_history_revisions` with an error: no copy is
ever current and nothing is peeked, but opens still paint the copy at once and
the answer confirms or replaces it. A daemon without `history-push` ignores
`watch`, `liveBase` and `baseCopy` and answers in full. Older TUIs never send
the new fields and get the whole live part, with tool output, as before.

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

Streaming conversations, with pushes (Oct 30): the same harness against a
worktree daemon whose three chats run scripted turns from a local fake model
(prose at 40 tokens/s, a 3 s Bash call with ~19 KB of output per round), the
TUI sitting on an idle chat for 10 s, then opening each
(`~/Workspace/research/ssh-live-cache-20261030/measure2.ts`):

| Streaming open | Before | After |
| --- | ---: | ---: |
| First frame | 2–5 ms, the copy from before the turn | 2–5 ms, finished messages and the turn in progress |
| Answer (~107 ms) | turn in progress pops in (6-row scroll) | same frame but the spinner; newer text streams on |
| Bytes down / up per open | 35–37 KB / 2.9 KB raw | 2.0–2.7 KB / 0.6 KB raw |
| After a TUI restart mid-turn | (no copy of the turn) | 8 ms from the disk copy, one round behind; the answer (114 ms) updated the step in place |
| 1 Mbit/s link | — | 3–5 ms first frame, answer ~127 ms, nothing changes |

Background cost with three chats streaming: 1.9–2.0 KiB/s of pushes before
SSH compression, 0.36–0.38 KiB/s on the wire (the simulator compresses like
`ssh -C`); before, those chats cost nothing but their copies went stale.

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
