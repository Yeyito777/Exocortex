# SSH conversation history cache

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
- Opening and backfill/viewport requests advertise SHA-256 hashes of entries
  from the corresponding cached page. The daemon compares them against the
  canonical page and sends fresh entries plus an ordered index map. This handles
  appended, edited, duplicated, truncated and shifted entries without relying on
  timestamps, message counts or append-only assumptions.
- Subscription, streaming catch-up, metadata, goals, tool policy and BTW state
  retain their existing authoritative paths. The cache never paints a stale
  transcript while waiting for validation.
- Reconstruction happens before existing TUI event handlers. Pending requests
  pin their own bases, so concurrent loads and LRU eviction cannot corrupt them.
  An invalid delta retries the original request once without cache hints.
- Successful endpoint switches clear the cache. Reconnects to the same endpoint
  discard pending bases but can reuse stored pages after content validation.
- Only opt-in requests receive deltas. Older clients receive full responses;
  older daemons ignore the optional hints and return full responses. Local loads
  do not incur cache serialization/hashing overhead.

## Validation

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
