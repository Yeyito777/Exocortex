# Paged conversation display storage

Conversation history has two very different consumers:

1. provider replay, compaction, rewind, and mutation need the canonical stored
   messages; and
2. opening the TUI needs a small compact display window.

The canonical `config/data/conversations/<id>.json` file remains the source of
truth. A disposable, page-addressable projection under
`config/data/display-pages/<id>/` serves the second use case without loading the
first one.

## Open path

Pagination-aware clients already request five turns and then older pages by an
absolute entry cursor. The daemon now resolves those requests from:

```text
display-pages/<conversation-id>/
  manifest.json
  <build-id>/
    chunk-000000.json
    chunk-000001.json
    ...
```

The manifest contains source freshness metadata, pinned conversation
instructions, compact scalar conversation settings, absolute user-entry
indices, and chunk ranges. A request reads the manifest plus only the chunks
overlapping its user-turn range.

Projection entries intentionally contain no tool-result bodies. As in the prior
compact-open path, old images retain metadata but omit base64; image payloads are
kept only within the newest eight display entries so recently attached images
still render without an additional round trip. The existing explicit
`load_tool_outputs` path still loads canonical data when a user asks to expand
tool output. Provider replay also continues to call the canonical
full-conversation API.

Folder instructions are not persisted in the projection. They are composed from
the current folder tree at response time, so changing inherited instructions
does not require rewriting every child conversation page.

## Freshness and atomic publication

Each manifest is tied to the canonical JSON size, monotonic mtime, and ctime,
plus the size, mtime, and digest of the tiny targeted-unwind overlay when
present. A mismatch makes the projection a cache miss.

Writers create an immutable build directory, verify that the canonical source
did not change while it was being built, and atomically rename a new manifest
into place. Readers that race cleanup retry from the current manifest once.
The canonical JSON is never made dependent on the projection: deleting the
`display-pages` directory is a safe rollback.

Conversation saves queue a fresh projection after the canonical atomic save.
The persistent index worker coalesces these refreshes so full-history projection
work and chunk writes do not block the daemon event loop. Soft delete removes
the live projection; undo queues a rebuild from the restored canonical file.

## Legacy migration

One second after daemon startup, a worker thread scans conversations in
most-recently-modified order. It builds missing/stale projections without
blocking the daemon event loop. The display-only loader deliberately skips the
expensive active-context prefix validation; canonical replay validates it when
the conversation is actually used for a model turn.

If a user opens a conversation before the worker reaches it, the request builds
that one projection synchronously through the same display-only loader. This is
still substantially faster than the former full load because it avoids both
full-history hashing passes. All later opens are bounded page reads.

## Edit identities

Compact pages use `page-v1:<hash>` user fingerprints derived from conversation
ID, absolute real-user index, and that user message. They are opaque stale-edit
guards, not provider replay hashes. The unwind path accepts both these identities
and the legacy full-prefix hash, preserving compatibility with already-open or
older clients.

## Initial backfill

After the first five-turn paint, the TUI preloads ten more turns. When the view
is still bottom-anchored and history navigation is not focused, prepending that
buffer no longer performs old-and-new full line wrapping merely to preserve an
unchanged viewport. Explicit upward scrolling and history selection retain the
full semantic viewport-preservation path.
