# SQLite conversation store

Status: the normalized SQLite conversation store is merged and is the canonical
production backend. The JSON backend remains available for compatibility, import,
export, and rollback.

Current documentation:

- [`design.md`](./design.md) — repository boundary, transactions, paging, and
  concurrency model.
- [`schema.md`](./schema.md) — normalized schema and migration checkpoints.
- [`state-map.md`](./state-map.md) — ownership of durable and ephemeral state.
- [`migration.md`](./migration.md) — import, cutover, backup, export, and rollback
  operations.
- [`validation.md`](./validation.md) — consolidated correctness, migration,
  performance, and end-to-end evidence from the accepted implementation.
- [`baseline.md`](./baseline.md) — pre-overhaul measurements and acceptance
  thresholds.

The temporary implementation TODOs, pre-merge reports, synchronization checklists,
raw autoresearch ledger, and generated benchmark result files were removed after the
feature was accepted. Their history remains available in Git; they are not maintained
as current documentation.
