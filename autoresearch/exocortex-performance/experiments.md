# Experiment log

All experiment failures and successes are logged here. Successful experiments are committed. Failed code changes are stashed/deleted after logging.

## 000 — Benchmark creation and baseline

Status: success — benchmark only, no production optimization yet.

- Created deterministic benchmark axes for conversation cold/warm opening and sidebar render/navigation/search/list update.
- No optimization experiments attempted before this benchmark.
- Baseline saved to `results/baseline.json`.
- Largest baseline p95s:
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 972.643ms
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 936.742ms
  - `conversation_open_cold/huge_expanded_tools`: 293.676ms
  - `sidebar_search_filter/huge_foldered.performance_query`: 45.006ms
  - `sidebar_render/huge_foldered.root`: 12.329ms

## 001 — Sidebar search use boolean includes instead of all match offsets

Status: failure — production code reverted/deleted.

Hypothesis: `getVisibleConversationIndicesForQuery` only needs to know whether a title contains the search query, so replacing `findAllCaseInsensitiveMatchStarts(...).length > 0` with a boolean lower-case `includes` helper should reduce sidebar search filtering cost without UX changes.

Validation:

- Relevant search tests passed: `bun test src/sidebarsearch.test.ts src/search.test.ts`.
- Full benchmark was too noisy against the original baseline, so I also ran an interleaved control/treatment comparison by temporarily checking out the original production files, benchmarking, re-applying the patch, and benchmarking again.
- Interleaved search p95s:
  - `sidebar_search_filter/small_root.performance_query`: 0.570ms → 0.564ms, ratio 0.989
  - `sidebar_search_filter/large_root.performance_query`: 13.285ms → 13.614ms, ratio 1.025
  - `sidebar_search_filter/huge_foldered.performance_query`: 42.939ms → 50.350ms, ratio 1.173
- Official keep criterion failed due regressions above 2%, including the targeted huge search workload.

Action: reverted `tui/src/searchutil.ts`, `tui/src/sidebarsearch.ts`, and `tui/src/sidebar/rows.ts`; kept only this failure log and result artifacts.

## 002 — Precompute folder descendant counts/statuses during sidebar render

Status: success — kept and committed.

Hypothesis: `renderSidebar` recomputed each visible folder's descendant conversations independently via `folderDescendantConversations`, repeatedly scanning folders/conversations. Precomputing descendant conversation count, streaming, and unread status for all folders once per sidebar render should preserve exact UI while reducing folder-heavy sidebar render time.

Change:

- Removed per-visible-folder calls to `folderDescendantConversations` from `tui/src/sidebar/render.ts`.
- Added a render-local aggregate map that walks each conversation's folder ancestry once and records `{ count, streaming, unread }` per folder.
- Kept rendered folder labels and stream/unread icon semantics the same.

Validation:

- `bun test src/sidebar*.test.ts`: 21 pass, 0 fail.
- `bun run typecheck`: pass.
- `bun test`: 370 pass, 0 fail.
- Result saved to `results/002-folder-aggregate-render.json`.
- Interleaved control/treatment p95s for directly affected sidebar render/filter axes:
  - `sidebar_render/small_root.root`: 0.746ms → 0.401ms, ratio 0.538
  - `sidebar_render/large_root.root`: 6.962ms → 5.073ms, ratio 0.729
  - `sidebar_render/huge_foldered.root`: 38.211ms → 19.210ms, ratio 0.503
  - `sidebar_render/large_root.visual_selection`: 6.834ms → 6.960ms, ratio 1.018 (within 2% tolerance)
  - `sidebar_search_filter/small_root.performance_query`: 1.122ms → 0.800ms, ratio 0.713
  - `sidebar_search_filter/large_root.performance_query`: 24.371ms → 20.974ms, ratio 0.861
  - `sidebar_search_filter/huge_foldered.performance_query`: 87.469ms → 85.592ms, ratio 0.979 (within 2% tolerance)

Decision: keep. The optimized production code is isolated to sidebar rendering and all behavior tests passed; directly affected benchmark axes show large p95 wins or remain within tolerance.

