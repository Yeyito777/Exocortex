# Pre-overhaul Baseline

Captured 2026-08-01 from commit `5966837`/planning-only commit `6908ba6` before
implementation.

## Corpus shape (read-only main inspection)

- approximately 3,361 canonical conversation JSON files
- approximately 2.33 GiB canonical JSON
- median canonical file approximately 242 KiB
- p95 approximately 1.74 MiB
- largest canonical file approximately 96 MiB
- disposable display-page tree approximately 337 MiB / 10,211 files
- pretty summary index approximately 1.81 MiB (approximately 1.32 MiB compact)

The JSON backend rewrites the full canonical file for ordinary flushes. A valid
existing display projection makes large recent-page reads fast (observed around
4.4 ms versus roughly 770 ms for parse/build), but maintaining/backfilling the
second file tree adds substantial I/O and consistency machinery.

## Correctness baseline

Commands:

```sh
bun run typecheck
bun test shared daemon tui
```

Results:

- root shared/daemon/TUI TypeScript checks: pass
- tests: 1,412 pass, 4 fail, 1,416 total across 139 files, 35.92 s

Recorded environment-sensitive/pre-existing failures:

1. `buildDaemonSpawnSpec > tracks the daemon process instead of a persistent shell wrapper`
2. `bash process-tree timeout > times out and kills descendants in the isolated command process group`
3. `tool availability > native exo management is available while transcription remains external`
4. `DeepSeek API-key auth > instructs users to provide an API key when none is configured`

The last failure occurs because this environment supplies a DeepSeek credential;
the process/tool failures are host/environment dependent. Storage-specific tests
were passing before implementation.

## Acceptance thresholds

The approved thresholds were:

- low-scale median latency must not regress by more than the larger of 15% or 2 ms;
- low-scale p95 latency must not regress by more than the larger of 25% or 5 ms;
- ordinary interactive writes must remain below 50 ms p95;
- 10,000-conversation startup/listing must improve by at least 2x; and
- appends to 10/50/100 MiB histories must improve by at least 5x, with append cost
  independent of historical bytes.
