# Exocortex performance autoresearch

Topic: TUI responsiveness, especially conversation opening and sidebar operations.

## Benchmark-first rule

This directory is the experiment ledger. The benchmark in `benchmark.ts` was created before any optimization experiments in this worktree. Experiments are kept only when they improve the deterministic benchmark objectively with no visible UX/UI change and no correctness/type/test regression.

## Independent benchmark axes

The benchmark reports each axis separately:

- `conversation_open_cold.*`: construct a fresh render state with freshly generated conversation objects and render the first frame. This approximates opening a conversation whose message objects have not populated render caches yet.
- `conversation_open_warm.*`: repeatedly render the same opened conversation after one warm-up render. This approximates returning to or interacting with an already-open conversation where caches should make frames cheap.
- `sidebar_render.*`: render the sidebar for varied sidebar sizes and states.
- `sidebar_navigation.*`: repeatedly move selection through the sidebar.
- `sidebar_search_filter.*`: render/build visible rows while a search filter is active.
- `sidebar_list_update.*`: replace/sync the conversation and folder list, approximating daemon list refreshes and sidebar mutations.

Workloads intentionally range from tiny to huge: small chats, medium markdown chats, huge markdown/tool-output chats, root sidebar lists, folder-heavy sidebars, active visual selection, and active search.

## Keep/trash criterion

For each experiment:

1. Run the benchmark at least once before and after the change under the same command.
2. Keep the change only if:
   - no measured axis regresses by more than **2%** in p95 time;
   - at least one targeted axis improves by **5%** or more in p95 time, or total p95 geometric mean improves by **2%** or more;
   - `bun run typecheck` and the relevant tests pass;
   - the user-visible UX/UI remains unchanged or the change is practically unnoticeable.
3. On success: record the result in `experiments.md` and commit.
4. On failure: record the failure in `experiments.md`, then stash/delete the code change so only the log remains.

Use `--compare` for an automated pass/fail check against a prior JSON result.

## Commands

From the repo root in this worktree:

```bash
bun run autoresearch/exocortex-performance/benchmark.ts --json > autoresearch/exocortex-performance/results/baseline.json
bun run autoresearch/exocortex-performance/benchmark.ts --json --compare autoresearch/exocortex-performance/results/baseline.json
```
