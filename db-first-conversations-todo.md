# DB-first conversations refactor

- [x] Establish and test the persistence/read invariants: completed messages are canonical exactly once, pending stream state contains only the incomplete provider response, and paged reads stay bounded while streaming.
- [x] Add an append-oriented conversation repository API with transactional SQLite message/display projection updates and a compatibility implementation for the JSON backend.
- [x] Move ordinary user-message and completed provider/tool-round persistence onto the append API, leaving whole-conversation save only for rewrites and metadata mutations.
- [x] Replace the overlapping completed streaming-message mirror with a pending-only active-stream state and an explicit committed boundary.
- [x] Serve conversation open/history pages from the durable display index while streaming, overlay only pending state, and build late-join catch-up without rebuilding canonical history.
- [x] Remove obsolete full-history streaming reconciliation paths and add regression, race, unwind, compaction, and large-conversation performance coverage.
- [x] Run typechecks and unit/integration suites, then validate the worktree end to end with xenv + exotest and record the final profile/result.
