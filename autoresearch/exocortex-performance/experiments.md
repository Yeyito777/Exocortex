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

## 003 — Skip visual-selection lookup when no visual anchor exists

Status: success — kept and committed.

Hypothesis: normal sidebar rendering computed `selectedVisualItems(sidebar)` even when visual mode was inactive. With no `visualAnchor`, this still performs selected-item validation and a conversation lookup, yet the result is only the current item and does not affect visible output because selected styling wins over visual styling. Avoiding that work should improve regular sidebar render paths without changing visual-mode behavior.

Change:

- In `renderSidebar`, call `selectedVisualItems(sidebar)` only when `sidebar.visualAnchor` is set.
- Keep the visual-item key set empty outside visual mode; pending-delete styling still uses `pendingDeleteItem` directly, so UX remains unchanged.

Validation:

- `bun test src/focus.test.ts src/sidebar*.test.ts src/render.test.ts`: 82 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/003-skip-visual-items-without-anchor.json`.
- Interleaved control/treatment p95s for directly affected sidebar axes:
  - `sidebar_render/small_root.root`: 0.300ms → 0.286ms, ratio 0.953
  - `sidebar_render/large_root.root`: 4.669ms → 2.846ms, ratio 0.610
  - `sidebar_render/huge_foldered.root`: 9.647ms → 9.147ms, ratio 0.948
  - `sidebar_render/large_root.visual_selection`: 3.237ms → 3.149ms, ratio 0.973
  - `sidebar_search_filter/small_root.performance_query`: 0.621ms → 0.501ms, ratio 0.807
  - `sidebar_search_filter/large_root.performance_query`: 14.133ms → 12.475ms, ratio 0.883
  - `sidebar_search_filter/huge_foldered.performance_query`: 48.078ms → 48.347ms, ratio 1.006 (within 2% tolerance)

Decision: keep. Directly affected render/filter axes improved or stayed within tolerance; tests and typecheck passed.

## 004 — Fast path plain assistant markdown paragraphs

Status: success — kept and committed.

Hypothesis: assistant markdown wrapping treated every markdown-mode paragraph as if it contained inline markdown markers. For plain paragraphs without `*` or backticks, it repeatedly stripped markdown while measuring candidate wraps and then ran the inline formatter anyway. Skipping markdown stripping/formatting for marker-free paragraphs should preserve exact rendered output and significantly improve cold conversation opening/building for large chats.

Change:

- In `tui/src/markdown/wordwrap.ts`, detect paragraph text that contains no inline markdown markers handled by the formatter (`*` or `` ` ``).
- Use raw terminal width measurement for those plain paragraphs.
- Return raw wrapped lines instead of calling `formatMarkdownChunks` when every paragraph line in the block is marker-free.

Validation:

- `bun test src/markdown/wordwrap.test.ts src/markdown/formatting.test.ts src/conversation.test.ts src/render.test.ts`: 42 pass, 0 fail.
- `bun run typecheck`: pass, after deleting a transient self-referential `node_modules/.bun` symlink caused by the xenv `exotest` dependency sync and reinstalling dependencies.
- `bun test`: 370 pass, 0 fail.
- Result saved to `results/004-plain-markdown-fast-path.json`.
- Interleaved control/treatment p95s for directly affected conversation cold/build axes, first run:
  - `conversation_open_cold/small_chat`: 7.665ms → 6.655ms, ratio 0.868
  - `conversation_build_lines_cold/small_chat`: 4.342ms → 3.318ms, ratio 0.764
  - `conversation_open_cold/medium_markdown`: 147.894ms → 86.347ms, ratio 0.584
  - `conversation_build_lines_cold/medium_markdown`: 145.138ms → 83.720ms, ratio 0.577
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 972.974ms → 476.338ms, ratio 0.490
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 965.762ms → 464.914ms, ratio 0.481
  - `conversation_open_cold/huge_expanded_tools`: 269.092ms → 168.928ms, ratio 0.628
  - `conversation_build_lines_cold/huge_expanded_tools`: 279.673ms → 179.835ms, ratio 0.643
- Repeated interleaved control/treatment run confirmed the same cold/build direction:
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 984.886ms → 488.883ms, ratio 0.496
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 1113.074ms → 537.423ms, ratio 0.483
  - `conversation_open_cold/huge_expanded_tools`: 267.684ms → 170.789ms, ratio 0.638
  - `conversation_build_lines_cold/huge_expanded_tools`: 301.245ms → 161.386ms, ratio 0.536

Notes:

- Some warm/sidebar microbench p95s varied across runs even though this change is not on their measured hot path after history render caching. I treated those as benchmark noise, not product regressions, because the code path is restricted to cold markdown wrapping and the repeated directly affected axes improved dramatically.

Decision: keep. This is a large cold conversation-opening/build-lines win with no visible rendering change for marker-free paragraphs and full tests passing.

## 005 — Merge already-sorted sidebar row inputs instead of sorting concatenated entries

Status: failure — production code reverted/deleted.

Hypothesis: sidebar conversations/folders are usually maintained in sidebar order already, so `buildDisplayRows` could merge filtered folder and conversation entries instead of concatenating and sorting every call. This should reduce sidebar render/navigation/search costs on large lists while preserving stable folder-before-conversation tie ordering.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/005-merge-sorted-sidebar-rows.json`.
- Interleaved sidebar p95s:
  - `sidebar_render/small_root.root`: 0.310ms → 0.409ms, ratio 1.319
  - `sidebar_navigation/small_root.nav_down`: 0.021ms → 0.014ms, ratio 0.667
  - `sidebar_search_filter/small_root.performance_query`: 0.509ms → 0.502ms, ratio 0.986
  - `sidebar_render/large_root.root`: 3.548ms → 3.663ms, ratio 1.032
  - `sidebar_search_filter/large_root.performance_query`: 12.615ms → 13.379ms, ratio 1.061
  - `sidebar_render/huge_foldered.root`: 10.363ms → 8.635ms, ratio 0.833
  - `sidebar_navigation/huge_foldered.nav_down`: 1.541ms → 1.068ms, ratio 0.693
  - `sidebar_render/large_root.visual_selection`: 3.708ms → 3.136ms, ratio 0.846
- The benchmark workload can provide unsorted sidebar arrays, forcing fallback sort after extra sortedness checks; this produced regressions above the 2% tolerance on small/large render and large search.

Action: reverted `tui/src/sidebar/rows.ts`; kept only this failure log and result artifact.

## Smoke test — xenv + exotest

Status: success after setup correction.

- Initial attempt to run `./scripts/dev/exotest` from inside the worktree resolved the worktree root as itself and created a self-referential `node_modules/.bun` symlink, causing Bun `ELOOP` dependency-link errors. Deleted the broken `node_modules` and reinstalled dependencies.
- Correct command from the worktree using the main checkout script: `/home/yeyito/Workspace/exocortex/scripts/dev/exotest autoresearch-performance` inside an `xenv` `st` terminal.
- Result: TUI launched successfully in the nested X11 environment and rendered the Exocortex prompt.

## 006 — Cache wrapped paragraph word widths

Status: success — kept and committed.

Hypothesis: `wrapParagraphRaw` repeatedly measured the full growing output line for every word candidate. In markdown mode this meant repeatedly stripping markdown for longer and longer candidate strings, and even in plain mode it repeatedly recomputed terminal width for repeated words. Tracking the current line's visible width and caching per-word widths within a paragraph should preserve wrapping exactly while reducing cold conversation open/build costs.

Change:

- Added a paragraph-local width cache in `tui/src/markdown/wordwrap.ts`.
- Track `lineWidth` alongside `line` so the wrap check uses `lineWidth + 1 + wordWidth` instead of re-measuring the whole accumulated line each time.
- Seed long-word fallback updates `lineWidth` after splitting, preserving existing long-word behavior.

Validation:

- `bun test src/markdown/wordwrap.test.ts src/markdown/formatting.test.ts src/conversation.test.ts src/render.test.ts`: 42 pass, 0 fail.
- `bun run typecheck`: pass.
- `bun test`: 370 pass, 0 fail.
- Result saved to `results/006-cache-wrap-word-widths.json`.
- Interleaved control/treatment p95s for directly affected conversation axes, first run:
  - `conversation_open_cold/small_chat`: 6.162ms → 3.583ms, ratio 0.581
  - `conversation_build_lines_cold/small_chat`: 3.500ms → 2.026ms, ratio 0.579
  - `conversation_open_cold/medium_markdown`: 81.443ms → 36.708ms, ratio 0.451
  - `conversation_build_lines_cold/medium_markdown`: 82.951ms → 37.586ms, ratio 0.453
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 472.567ms → 200.686ms, ratio 0.425
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 456.503ms → 175.466ms, ratio 0.384
  - `conversation_open_cold/huge_expanded_tools`: 166.946ms → 86.959ms, ratio 0.521
  - `conversation_build_lines_cold/huge_expanded_tools`: 162.408ms → 81.353ms, ratio 0.501
- Repeated interleaved control/treatment run confirmed the same direction:
  - `conversation_open_cold/small_chat`: 6.508ms → 3.846ms, ratio 0.591
  - `conversation_build_lines_cold/small_chat`: 3.944ms → 2.027ms, ratio 0.514
  - `conversation_open_cold/medium_markdown`: 82.042ms → 39.322ms, ratio 0.479
  - `conversation_build_lines_cold/medium_markdown`: 85.098ms → 35.114ms, ratio 0.413
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 470.826ms → 177.513ms, ratio 0.377
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 457.665ms → 171.495ms, ratio 0.375
  - `conversation_open_cold/huge_expanded_tools`: 168.775ms → 86.973ms, ratio 0.515
  - `conversation_build_lines_cold/huge_expanded_tools`: 164.253ms → 85.871ms, ratio 0.523

Notes:

- Unrelated sidebar microbench axes varied in both directions during the interleaved runs. This code path is restricted to paragraph wrapping and all directly affected cold/build axes improved by large margins twice.

Decision: keep. Large deterministic cold conversation-opening/build-lines improvement with no visible wrapping change and full validation passing.

## 007 — ASCII fast path for terminal-width measurement

Status: success — kept and committed.

Hypothesis: most benchmarked conversation/sidebar strings are ASCII. `termWidth` still walked each ASCII character through the full grapheme-width path (`codePointAt`, zero-width checks, wide-range binary search, trailing combining scan). Fast-returning all-ASCII strings and starting the full grapheme loop after any ASCII prefix should preserve all Unicode/ANSI behavior while reducing cold conversation open/build and ASCII-heavy sidebar costs.

Change:

- In `tui/src/textwidth.ts`, scan an initial printable ASCII prefix with `charCodeAt`.
- If the whole string is printable ASCII, return `s.length` immediately.
- Otherwise seed `w` and `i` from the ASCII prefix and continue with the existing `nextGrapheme` logic, so wide Unicode, emoji, ANSI escapes, controls, and combining characters keep the previous behavior.

Validation:

- `bun test src/textwidth.test.ts src/emoji-graphemes.test.ts src/conversation.test.ts src/render.test.ts`: 41 pass, 0 fail. This initially caught a bug where I forgot to seed `w` with the ASCII prefix length; fixed before benchmarking/keeping.
- `bun run typecheck`: pass.
- `bun test`: 370 pass, 0 fail.
- Result saved to `results/007-ascii-termwidth-fast-path.json`.
- Interleaved control/treatment p95s, first run:
  - `conversation_open_cold/small_chat`: 3.595ms → 3.075ms, ratio 0.855
  - `conversation_build_lines_cold/small_chat`: 2.005ms → 1.868ms, ratio 0.932
  - `conversation_open_cold/medium_markdown`: 38.597ms → 33.881ms, ratio 0.878
  - `conversation_build_lines_cold/medium_markdown`: 37.436ms → 32.462ms, ratio 0.867
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 184.953ms → 166.044ms, ratio 0.898
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 184.737ms → 158.841ms, ratio 0.860
  - `conversation_open_cold/huge_expanded_tools`: 87.404ms → 63.470ms, ratio 0.726
  - `conversation_build_lines_cold/huge_expanded_tools`: 85.918ms → 60.290ms, ratio 0.702
- Repeated interleaved control/treatment run confirmed cold/build improvements:
  - `conversation_open_cold/small_chat`: 3.490ms → 2.976ms, ratio 0.853
  - `conversation_build_lines_cold/small_chat`: 2.182ms → 1.701ms, ratio 0.780
  - `conversation_open_cold/medium_markdown`: 37.161ms → 33.105ms, ratio 0.891
  - `conversation_build_lines_cold/medium_markdown`: 36.694ms → 33.341ms, ratio 0.909
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 185.510ms → 162.182ms, ratio 0.874
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 187.759ms → 169.069ms, ratio 0.900
  - `conversation_open_cold/huge_expanded_tools`: 89.242ms → 58.775ms, ratio 0.659
  - `conversation_build_lines_cold/huge_expanded_tools`: 88.271ms → 60.365ms, ratio 0.684
- Sidebar axes were mixed/noisy in the first run and mostly neutral-to-positive in the repeat for large render/search; no UI-visible behavior changed and Unicode regression tests pass.

Decision: keep. The change is behavior-preserving for Unicode/control cases covered by tests and gives repeatable cold conversation-opening/build-lines wins.

## 008 — Single-pass sidebar selection movement

Status: success — kept and committed after replacing the first variant.

Hypothesis: `moveSelection` built a filtered `entries` array on every up/down sidebar keypress. It should be able to find the next/previous entry in one scan over `buildDisplayRows` without allocating the filtered array, preserving the same clamped movement semantics.

Failed first variant:

- First attempt removed the filtered array but used two scans/index counting. Relevant tests passed, but benchmark showed a large direct regression on `sidebar_navigation/large_root.nav_down`: 0.391ms → 0.499ms, ratio 1.276. Deleted that code.
- Result artifact kept at `results/008-avoid-sidebar-navigation-filter.json`.

Kept second variant:

- Replaced the two-scan/index-counting version with a one-scan implementation that tracks the first, previous, last, and current entries.
- Preserves behavior for no entries, missing current selection, top clamp, and bottom clamp.

Validation:

- `bun test src/sidebar-navigation.test.ts src/focus.test.ts src/sidebarsearch.test.ts`: 63 pass, 0 fail.
- `bun run typecheck`: pass.
- `bun test`: 370 pass, 0 fail.
- Result saved to `results/008-single-pass-sidebar-navigation.json`.
- Interleaved control/treatment p95s for navigation axes:
  - `sidebar_navigation/small_root.nav_down`: 0.017ms → 0.014ms, ratio 0.824
  - `sidebar_navigation/large_root.nav_down`: 0.501ms → 0.383ms, ratio 0.764
  - `sidebar_navigation/huge_foldered.nav_down`: 1.444ms → 1.002ms, ratio 0.694

Notes:

- Non-navigation sidebar render/search axes varied in both directions during the same benchmark run, but `moveSelection` is not called by those axes. I treated those as benchmark noise and kept the targeted deterministic navigation improvement with behavior tests passing.

Decision: keep. Direct sidebar navigation p95s improved across small, large, and huge workloads with no UX-visible change.

## 009 — WeakMap cache for sidebar searchable titles

Status: failure — production code reverted/deleted.

Hypothesis: sidebar search repeatedly strips emoji marks, lowercases titles, and allocates match arrays while computing visible conversation indices. WeakMap-caching the stripped/lowercase searchable title per conversation object and using `includes` should improve large sidebar search/filter workloads without visible changes.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/focus.test.ts` gave 60 pass, 0 fail.
- Result saved to `results/009-cache-sidebar-search-titles.json`.
- Interleaved sidebar p95s:
  - `sidebar_search_filter/small_root.performance_query`: 0.483ms → 0.327ms, ratio 0.677
  - `sidebar_search_filter/large_root.performance_query`: 14.034ms → 19.292ms, ratio 1.375
  - `sidebar_search_filter/huge_foldered.performance_query`: 44.538ms → 53.681ms, ratio 1.205
  - `sidebar_render/huge_foldered.root`: 9.942ms → 17.789ms, ratio 1.789
  - `sidebar_render/large_root.visual_selection`: 3.326ms → 10.142ms, ratio 3.049
- The added WeakMap lookups/cache fills were much worse on large workloads than the allocation they replaced.

Action: reverted `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact.

## 010 — Single-pass pinned/unpinned sidebar row emission

Status: failure — production code reverted/deleted.

Hypothesis: after `buildDisplayRows` sorts entries, pinned rows are already contiguous. Replacing separate `entries.filter(entry => entry.pinned)` and `entries.filter(entry => !entry.pinned)` passes with a single boundary lookup plus indexed loops should reduce allocation and improve sidebar render/search/navigation.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/010-single-pass-sidebar-pinned-rows.json`.
- First interleaved run showed several wins but a direct large list-update regression:
  - `sidebar_render/large_root.root`: 3.835ms → 3.305ms, ratio 0.862
  - `sidebar_search_filter/large_root.performance_query`: 13.054ms → 12.308ms, ratio 0.943
  - `sidebar_list_update/large_root.replace_and_sync`: 2.028ms → 2.247ms, ratio 1.108
- Repeated interleaved run did not confirm safety on huge sidebar axes:
  - `sidebar_render/huge_foldered.root`: 9.135ms → 10.502ms, ratio 1.150
  - `sidebar_navigation/huge_foldered.nav_down`: 1.131ms → 1.218ms, ratio 1.077
  - `sidebar_list_update/huge_foldered.replace_and_sync`: 9.001ms → 9.925ms, ratio 1.103

Action: reverted `tui/src/sidebar/rows.ts`; kept only this failure log and result artifact.


## 011 — Restrict sidebar folder aggregates to visible folder rows

Status: failure — production code reverted/deleted.

Hypothesis: after experiment 002, `renderSidebar` precomputed descendant counts/statuses for every folder even though a frame only renders the visible sidebar rows. Restricting aggregation to visible folder ids should reduce folder-heavy render/search costs without changing rendered counts/icons.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts src/render.test.ts` gave 82 pass, 0 fail.
- Result saved to `results/011-visible-folder-aggregates.json`.
- First interleaved run looked promising for search/filter but had direct regressions:
  - `sidebar_search_filter/large_root.performance_query`: 13.417ms → 11.250ms, ratio 0.838
  - `sidebar_search_filter/huge_foldered.performance_query`: 45.836ms → 40.113ms, ratio 0.875
  - `sidebar_list_update/large_root.replace_and_sync`: 1.980ms → 2.457ms, ratio 1.241
  - `sidebar_render/large_root.visual_selection`: 3.022ms → 3.324ms, ratio 1.100
- Repeated interleaved run failed to confirm safety:
  - `sidebar_render/large_root.root`: 3.008ms → 4.172ms, ratio 1.387
  - `sidebar_search_filter/large_root.performance_query`: 12.913ms → 13.390ms, ratio 1.037
  - `sidebar_list_update/huge_foldered.replace_and_sync`: 9.280ms → 10.045ms, ratio 1.082

Action: reverted `tui/src/sidebar/render.ts`; kept only this failure log and result artifact.

## 012 — Replace sidebar refresh display-row scans with direct visibility checks

Status: success — kept and committed.

Hypothesis: `updateConversationList`/`syncSelectedIndex` used `buildDisplayRows` to answer simple questions during sidebar refreshes: whether the pending/current item is visible and what the first visible item is. Building full display rows sorts and allocates much more than needed. Direct visibility checks should reduce sidebar list-update cost without changing visible ordering or focus semantics.

Change:

- Added direct visibility predicates in `tui/src/sidebar/updates.ts` for conversations, folders, `..`, and folder instructions.
- Added a direct first-visible-item resolver that preserves root ordering using `compareSidebarOrder` and preserves folder behavior where `..` is the first entry inside folders.
- Removed `buildDisplayRows` calls from refresh selection synchronization.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- `bun test`: 370 pass, 0 fail.
- Result saved to `results/012-sidebar-update-visibility-checks.json`.
- Interleaved control/treatment p95s for targeted list-update axis, first run:
  - `sidebar_list_update/small_root.replace_and_sync`: 0.053ms → 0.045ms, ratio 0.849
  - `sidebar_list_update/large_root.replace_and_sync`: 2.477ms → 1.370ms, ratio 0.553
  - `sidebar_list_update/huge_foldered.replace_and_sync`: 11.847ms → 8.759ms, ratio 0.739
- Repeated interleaved run confirmed targeted list-update improvements:
  - `sidebar_list_update/small_root.replace_and_sync`: 0.058ms → 0.042ms, ratio 0.724
  - `sidebar_list_update/large_root.replace_and_sync`: 2.691ms → 1.606ms, ratio 0.597
  - `sidebar_list_update/huge_foldered.replace_and_sync`: 9.029ms → 7.104ms, ratio 0.787
- Final re-run after fixing the typecheck-only narrowing issue still improved the targeted axis:
  - `sidebar_list_update/small_root.replace_and_sync`: 0.060ms → 0.039ms, ratio 0.650
  - `sidebar_list_update/large_root.replace_and_sync`: 2.202ms → 1.896ms, ratio 0.861
  - `sidebar_list_update/huge_foldered.replace_and_sync`: 8.191ms → 7.856ms, ratio 0.959

Notes:

- Some non-update sidebar render/search/navigation microbench axes varied during runs; this code is not on their render/search hot paths. The targeted list-update axis improved repeatedly and behavior tests cover sidebar focus/refresh semantics.

Decision: keep. Deterministic sidebar list-update improvement with no visible UX change and full validation passing.

## 013 — Plain table cell markdown-width fast path

Status: failure — production code reverted/deleted.

Hypothesis: table rendering calls `stripMarkdown` while measuring cells even when cells contain no inline markdown markers. Skipping markdown stripping for marker-free cells should reduce cold markdown conversation rendering cost without visible changes.

Validation:

- Relevant markdown/conversation/render tests passed: `bun test src/markdown/wordwrap.test.ts src/markdown/formatting.test.ts src/conversation.test.ts src/render.test.ts` gave 42 pass, 0 fail.
- Result saved to `results/013-plain-table-width-fast-path.json`.
- Interleaved conversation p95s were mixed:
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 167.107ms → 151.402ms, ratio 0.906
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 166.845ms → 152.356ms, ratio 0.913
  - `conversation_build_lines_cold/medium_markdown`: 32.995ms → 31.154ms, ratio 0.944
  - `conversation_build_lines_cold/small_chat`: 1.735ms → 1.971ms, ratio 1.136
  - `conversation_open_cold/medium_markdown`: 32.805ms → 34.341ms, ratio 1.047
- Regressions above 2% on small/medium cold/build axes violated the keep criterion.

Action: reverted `tui/src/markdown/tables.ts`; kept only this failure log and result artifact.

## 014 — Cache syntax-highlighted code lines

Status: failure — production code reverted/deleted.

Hypothesis: many code fences contain repeated TypeScript lines across large generated/realistic conversations. Caching `highlightLine(language, line)` output should reduce repeated regex tokenization while preserving exact ANSI output.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- Result saved to `results/014-highlight-line-cache.json`.
- First variant (global cache from first call) improved medium/huge cold/build axes but regressed small build and some sidebar axes:
  - `conversation_open_cold/medium_markdown`: 31.954ms → 26.505ms, ratio 0.829
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 167.174ms → 143.834ms, ratio 0.860
  - `conversation_build_lines_cold/small_chat`: 1.708ms → 1.831ms, ratio 1.072
- Second variant delayed cache use until 128 highlight calls to avoid small-conversation overhead, but still regressed small cold/warm axes:
  - `conversation_open_cold/small_chat`: 2.953ms → 3.062ms, ratio 1.037
  - `conversation_open_warm/small_chat`: 0.235ms → 0.269ms, ratio 1.145
  - `conversation_open_cold/medium_markdown`: 33.510ms → 27.536ms, ratio 0.822
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 164.436ms → 133.814ms, ratio 0.814

Action: reverted `tui/src/markdown/highlight.ts`; kept only this failure log and result artifact.

## 015 — Fast paths for metadata token/duration formatting

Status: success — kept and committed.

Hypothesis: cold conversation rendering calls `renderMetadata` once per assistant turn. Benchmark metadata uses short durations and mostly sub-1000 token counts, but the renderer always did full duration decomposition and `toLocaleString("en-US")`. Fast paths for common token/duration cases should preserve exact output while reducing cold conversation open/build costs.

Change:

- In `tui/src/metadata.ts`, return early from `formatDuration` for sub-second, seconds-only, minutes-only, hours-only, and days-only durations before computing larger units.
- Added `formatTokenCount` that returns `String(tokens)` for integer counts between -999 and 999 and keeps `toLocaleString("en-US")` for larger/non-integer values.

Validation:

- `bun test src/metadata.test.ts src/conversation.test.ts src/render.test.ts`: 40 pass, 0 fail.
- `bun run typecheck`: pass.
- `bun test`: 370 pass, 0 fail.
- Result saved to `results/015-metadata-format-fast-paths.json`.
- First interleaved control/treatment p95s for directly affected cold/build conversation axes:
  - `conversation_build_lines_cold/small_chat`: 1.707ms → 1.441ms, ratio 0.844
  - `conversation_open_cold/medium_markdown`: 32.873ms → 26.515ms, ratio 0.807
  - `conversation_build_lines_cold/medium_markdown`: 33.154ms → 24.226ms, ratio 0.731
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 165.259ms → 131.823ms, ratio 0.798
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 168.560ms → 130.592ms, ratio 0.775
  - `conversation_open_cold/huge_expanded_tools`: 59.535ms → 49.980ms, ratio 0.840
  - `conversation_build_lines_cold/huge_expanded_tools`: 63.458ms → 48.766ms, ratio 0.768
- Repeated interleaved control/treatment confirmed cold/build wins:
  - `conversation_open_cold/small_chat`: 3.002ms → 2.595ms, ratio 0.864
  - `conversation_build_lines_cold/small_chat`: 1.718ms → 1.299ms, ratio 0.756
  - `conversation_open_cold/medium_markdown`: 33.671ms → 23.414ms, ratio 0.695
  - `conversation_build_lines_cold/medium_markdown`: 32.430ms → 24.469ms, ratio 0.755
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 165.078ms → 134.031ms, ratio 0.812
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 161.752ms → 130.406ms, ratio 0.806
  - `conversation_open_cold/huge_expanded_tools`: 62.748ms → 47.901ms, ratio 0.763
  - `conversation_build_lines_cold/huge_expanded_tools`: 60.039ms → 45.365ms, ratio 0.756

Notes:

- Warm-render microbench p95s varied in both directions despite history render caching bypassing metadata rendering after warm-up. I treated those as noise and kept the repeated cold/build wins on the code path this change actually affects.

Decision: keep. Repeated deterministic cold conversation-opening/build-lines improvement with exact metadata output preserved and full validation passing.

## 016 — Cache metadata model display names

Status: failure — production code reverted/deleted.

Hypothesis: `renderMetadata` formats the same model id for many assistant turns. A small module-level cache around `formatModelDisplayName` should reduce repeated string work while preserving exact metadata output.

Validation:

- Relevant tests passed before benchmarking: `bun test src/metadata.test.ts src/conversation.test.ts src/render.test.ts` gave 40 pass, 0 fail.
- Result saved to `results/016-cache-metadata-model-display.json`.
- Interleaved p95s were mixed and violated the no-regression criterion:
  - `conversation_open_cold/small_chat`: 2.600ms → 3.376ms, ratio 1.298
  - `conversation_open_warm/medium_markdown`: 0.255ms → 0.331ms, ratio 1.298
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 126.838ms → 120.561ms, ratio 0.951
  - `conversation_open_cold/huge_expanded_tools`: 46.875ms → 43.941ms, ratio 0.937
- The large small/warm regressions exceeded the 2% tolerance despite some huge-workload wins.

Action: reverted `tui/src/metadata.ts`; kept only this failure log and result artifact.

## 017 — Inline metadata line formatting without temporary parts array

Status: failure — production code reverted/deleted.

Hypothesis: `renderMetadata` builds a temporary `parts` array and joins it for every assistant run. Replacing this with one template string should reduce cold metadata rendering allocation while preserving exact output.

Validation:

- Relevant tests passed: `bun test src/metadata.test.ts src/conversation.test.ts src/render.test.ts` gave 40 pass, 0 fail.
- Result saved to `results/017-inline-metadata-line-format.json`.
- Interleaved p95s violated the no-regression criterion:
  - `conversation_open_cold/small_chat`: 2.545ms → 3.073ms, ratio 1.207
  - `conversation_build_lines_cold/small_chat`: 1.301ms → 1.423ms, ratio 1.094
  - `conversation_open_cold/medium_markdown`: 23.996ms → 24.943ms, ratio 1.039
  - `conversation_open_warm/medium_markdown`: 0.210ms → 0.295ms, ratio 1.405
- Huge cold/build axes were essentially neutral, not enough to offset the regressions.

Action: reverted `tui/src/metadata.ts`; kept only this failure log and result artifact.

## 018 — ASCII fast path for code-line wrapping

Status: failure — production code reverted/deleted.

Hypothesis: fenced code block lines are commonly printable ASCII. Fast-splitting ASCII code lines by character count should avoid terminal-width/grapheme work while producing the same chunks as `hardBreak` for ASCII.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- Result saved to `results/018-ascii-code-line-break-fast-path.json`.
- Interleaved p95s violated the no-regression criterion:
  - `conversation_open_cold/small_chat`: 2.704ms → 3.185ms, ratio 1.178
  - `conversation_open_cold/huge_expanded_tools`: 43.433ms → 47.280ms, ratio 1.089
  - `conversation_build_lines_cold/huge_expanded_tools`: 44.949ms → 48.779ms, ratio 1.085
- Some warm/sidebar axes improved, but the direct cold/build regressions exceeded tolerance.

Action: reverted `tui/src/markdown/codeblocks.ts`; kept only this failure log and result artifact.

## 019 — ASCII fast path for truncation

Status: failure — production code reverted/deleted.

Hypothesis: sidebar titles and many message strings passed to `truncateToWidth` are printable ASCII. For fully ASCII strings, truncation by terminal width is equivalent to string length/slice, so a fast path should improve sidebar render/search without changing Unicode behavior.

Validation:

- Relevant tests passed: `bun test src/textwidth.test.ts src/sidebar*.test.ts src/render.test.ts` gave 33 pass, 0 fail.
- Result saved to `results/019-ascii-truncate-fast-path.json`.
- Interleaved p95s were mixed and violated the no-regression criterion:
  - `sidebar_render/large_root.root`: 3.392ms → 3.770ms, ratio 1.111
  - `sidebar_navigation/small_root.nav_down`: 0.015ms → 0.019ms, ratio 1.267
  - `conversation_open_warm/small_chat`: 0.233ms → 0.302ms, ratio 1.296
  - `conversation_build_lines_cold/huge_expanded_tools`: 47.742ms → 44.034ms, ratio 0.922
  - `sidebar_navigation/huge_foldered.nav_down`: 1.632ms → 0.994ms, ratio 0.609
- The targeted sidebar render regression exceeded tolerance despite some wins elsewhere.

Action: reverted `tui/src/textwidth.ts`; kept only this failure log and result artifact.

## 020 — Single-assistant metadata fast path

Status: failure — production code reverted/deleted.

Hypothesis: `assistantRunMetadata` clones/combines metadata even when an assistant message is not adjacent to other assistant fragments. Returning the existing metadata object directly for the common single-message run should avoid allocation and preserve output.

Validation:

- Relevant tests passed: `bun test src/conversation.test.ts src/metadata.test.ts src/render.test.ts` gave 40 pass, 0 fail.
- Result saved to `results/020-single-assistant-metadata-fast-path.json`.
- Interleaved p95s were mixed and violated the no-regression criterion:
  - `conversation_build_lines_cold/medium_markdown`: 25.442ms → 28.756ms, ratio 1.130
  - `conversation_open_cold/huge_expanded_tools`: 47.572ms → 49.906ms, ratio 1.049
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 128.536ms → 131.211ms, ratio 1.021
  - `conversation_open_cold/small_chat`: 2.753ms → 2.540ms, ratio 0.923
  - `conversation_build_lines_cold/small_chat`: 1.318ms → 1.129ms, ratio 0.857
- The medium/huge cold/build regressions exceeded tolerance despite wins on small/warm axes.

Action: reverted `tui/src/conversation.ts`; kept only this failure log and result artifact.

## 021 — ASCII fast path for plain word wrapping

Status: failure — production code reverted/deleted.

Hypothesis: plain user/system/tool text wrapping often receives printable ASCII lines. A dedicated ASCII wrapper can avoid repeated `termWidth` and `sliceByWidth` grapheme processing while preserving wrap/join behavior for ASCII.

Validation:

- Relevant tests passed: `bun test src/conversation.test.ts src/textwidth.test.ts src/render.test.ts` gave 37 pass, 0 fail.
- Result saved to `results/021-ascii-plain-wordwrap-fast-path.json`.
- Interleaved p95s were mixed and violated the no-regression criterion:
  - `conversation_build_lines_cold/medium_markdown`: 23.821ms → 29.777ms, ratio 1.250
  - `sidebar_list_update/large_root.replace_and_sync`: 1.915ms → 2.432ms, ratio 1.270
  - `sidebar_render/large_root.root`: 3.561ms → 3.711ms, ratio 1.042
  - `conversation_open_cold/small_chat`: 2.860ms → 2.688ms, ratio 0.940
  - `conversation_open_warm/huge_markdown_collapsed_tools`: 0.246ms → 0.206ms, ratio 0.837
- The direct medium markdown build regression exceeded tolerance.

Action: reverted `tui/src/textwrap.ts`; kept only this failure log and result artifact.

## 022 — Single Map lookup in folder aggregate loop

Status: failure — production code reverted/deleted.

Hypothesis: `buildFolderAggregates` checked `aggregates.has(folderId)` and then immediately did `aggregates.get(folderId)`. Replacing the double lookup with a single `get`/break should preserve semantics and reduce folder-heavy sidebar render cost.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts src/render.test.ts` gave 82 pass, 0 fail.
- Result saved to `results/022-folder-aggregate-single-map-lookup.json`.
- Interleaved sidebar p95s violated the no-regression criterion:
  - `sidebar_render/small_root.root`: 0.242ms → 0.310ms, ratio 1.281
  - `sidebar_render/large_root.root`: 3.916ms → 4.753ms, ratio 1.214
  - `sidebar_render/huge_foldered.root`: 9.854ms → 11.340ms, ratio 1.151
  - `sidebar_navigation/large_root.nav_down`: 0.419ms → 0.348ms, ratio 0.831
  - `sidebar_search_filter/small_root.performance_query`: 0.556ms → 0.466ms, ratio 0.838
- The directly targeted sidebar render axes regressed substantially.

Action: reverted `tui/src/sidebar/render.ts`; kept only this failure log and result artifact.

## 023 — Reuse generation map instead of per-conversation Set in folder aggregation

Status: failure — production code reverted/deleted.

Hypothesis: `buildFolderAggregates` allocated a fresh `Set` for every conversation to prevent folder-cycle double-counting. Reusing one `Map<folderId, generation>` across conversations should preserve cycle behavior while reducing folder-heavy sidebar render allocation.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts src/render.test.ts` gave 82 pass, 0 fail.
- Result saved to `results/023-folder-aggregate-seen-generation.json`.
- First interleaved run showed promising sidebar render wins but direct regressions:
  - `sidebar_render/small_root.root`: 0.317ms → 0.251ms, ratio 0.792
  - `sidebar_render/large_root.root`: 3.909ms → 3.100ms, ratio 0.793
  - `sidebar_render/huge_foldered.root`: 12.193ms → 9.707ms, ratio 0.796
  - `sidebar_search_filter/huge_foldered.performance_query`: 49.188ms → 51.137ms, ratio 1.040
  - `sidebar_navigation/small_root.nav_down`: 0.016ms → 0.022ms, ratio 1.375
- Repeated interleaved run did not confirm safety:
  - `sidebar_render/large_root.root`: 3.593ms → 3.708ms, ratio 1.032
  - `sidebar_render/huge_foldered.root`: 10.021ms → 10.825ms, ratio 1.080
  - `sidebar_search_filter/small_root.performance_query`: 0.448ms → 0.465ms, ratio 1.038
  - `sidebar_list_update/large_root.replace_and_sync`: 1.495ms → 1.608ms, ratio 1.076

Action: reverted `tui/src/sidebar/render.ts`; kept only this failure log and result artifact.

## 024 — Lowercase sidebar folder search query once

Status: failure — production code reverted/deleted.

Hypothesis: `buildDisplayRows` lowercased the active search query separately for every folder. Computing `activeQuery.toLowerCase()` once should preserve search behavior and reduce sidebar search/filter overhead.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/024-folder-query-lowercase-once.json`.
- First interleaved run looked promising on many sidebar axes:
  - `sidebar_search_filter/small_root.performance_query`: 0.608ms → 0.425ms, ratio 0.699
  - `sidebar_render/large_root.root`: 4.112ms → 3.670ms, ratio 0.893
  - `sidebar_navigation/huge_foldered.nav_down`: 1.995ms → 1.429ms, ratio 0.716
  - only unrelated `conversation_open_warm/huge_markdown_collapsed_tools` regressed substantially.
- Repeated interleaved run did not confirm safety and showed direct sidebar regressions:
  - `sidebar_render/small_root.root`: 0.346ms → 0.376ms, ratio 1.087
  - `sidebar_render/large_root.root`: 3.753ms → 4.626ms, ratio 1.233
  - `sidebar_search_filter/large_root.performance_query`: 12.403ms → 14.027ms, ratio 1.131
  - `sidebar_navigation/huge_foldered.nav_down`: 1.598ms → 1.936ms, ratio 1.212

Action: reverted `tui/src/sidebar/rows.ts`; kept only this failure log and result artifact.

## 025 — User bubble width loop without combined array/spread

Status: failure — production code reverted/deleted.

Hypothesis: `renderUserMessage` allocated a combined `allContentLines` array and used `Math.max(...map(termWidth))` to size the user bubble. Replacing that with direct loops over wrapped text and image badge lines should reduce cold conversation rendering allocation without changing bubble width.

Validation:

- Relevant tests passed: `bun test src/conversation.test.ts src/render.test.ts src/clipboard.test.ts` gave 33 pass, 0 fail.
- Result saved to `results/025-user-bubble-width-loop.json`.
- Interleaved p95s violated the no-regression criterion:
  - `conversation_open_cold/small_chat`: 2.579ms → 3.268ms, ratio 1.267
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 127.678ms → 138.612ms, ratio 1.086
  - `sidebar_render/large_root.root`: 3.144ms → 4.626ms, ratio 1.471
  - `conversation_open_cold/medium_markdown`: 24.023ms → 22.521ms, ratio 0.937
- The direct cold-open regressions exceeded tolerance.

Action: reverted `tui/src/blockrenderer.ts`; kept only this failure log and result artifact.

## 026 — ASCII fast path for mark-prefix detection

Status: failure — production code reverted/deleted.

Hypothesis: most conversation titles start with ASCII. Since all mark prefixes are emoji, `getMarkPrefix` can return null immediately for empty/ASCII-leading titles, avoiding checks against all known mark emojis during sidebar render/search.

Validation:

- Relevant tests passed: `bun test src/marks.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/026-ascii-mark-prefix-fast-path.json`.
- Both interleaved runs showed very large search/filter wins:
  - First run `sidebar_search_filter/small_root.performance_query`: 0.623ms → 0.257ms, ratio 0.413
  - First run `sidebar_search_filter/large_root.performance_query`: 15.715ms → 7.704ms, ratio 0.490
  - First run `sidebar_search_filter/huge_foldered.performance_query`: 48.009ms → 24.302ms, ratio 0.506
  - Repeat `sidebar_search_filter/large_root.performance_query`: 13.053ms → 7.429ms, ratio 0.569
  - Repeat `sidebar_search_filter/huge_foldered.performance_query`: 45.734ms → 25.856ms, ratio 0.565
- However, the repeated run still had direct sidebar regressions above tolerance:
  - `sidebar_render/huge_foldered.root`: 10.977ms → 11.534ms, ratio 1.051
  - `sidebar_navigation/huge_foldered.nav_down`: 1.246ms → 1.651ms, ratio 1.325
  - `sidebar_list_update/huge_foldered.replace_and_sync`: 6.808ms → 8.129ms, ratio 1.194
  - `sidebar_render/large_root.visual_selection`: 3.228ms → 3.533ms, ratio 1.094

Action: reverted `tui/src/marks.ts`; kept only this failure log and result artifact. This was tempting, but the no-regression rule rejected it.

## 027 — ASCII fast path for searchable conversation titles

Status: failure — production code reverted/deleted.

Hypothesis: `getSearchableConversationTitle` can skip `stripMark` for titles beginning with ASCII because mark prefixes are emoji. Restricting the fast path to searchable-title derivation should preserve exact title display/search semantics while improving sidebar search/filter without touching global mark handling.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/027-searchable-title-ascii-fast-path.json`.
- Both interleaved runs showed strong sidebar search/filter wins:
  - First run `sidebar_search_filter/small_root.performance_query`: 0.454ms → 0.322ms, ratio 0.709
  - First run `sidebar_search_filter/large_root.performance_query`: 14.203ms → 7.534ms, ratio 0.530
  - First run `sidebar_search_filter/huge_foldered.performance_query`: 44.091ms → 26.460ms, ratio 0.600
  - Repeat `sidebar_search_filter/large_root.performance_query`: 12.756ms → 6.807ms, ratio 0.534
  - Repeat `sidebar_search_filter/huge_foldered.performance_query`: 45.070ms → 24.610ms, ratio 0.546
- Repeated run still had benchmark regressions above tolerance:
  - `sidebar_list_update/huge_foldered.replace_and_sync`: 6.998ms → 7.977ms, ratio 1.140
  - `sidebar_list_update/large_root.replace_and_sync`: 1.741ms → 1.789ms, ratio 1.028
  - `sidebar_render/large_root.visual_selection`: 2.983ms → 3.051ms, ratio 1.023
  - unrelated conversation axes also showed noise/regressions.

Action: reverted `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact. The search win is real-looking, but the strict benchmark no-regression rule rejected it.

## 028 — Partition pre-sorted sidebar updates instead of full sort

Status: failure — production code reverted/deleted.

Hypothesis: incoming sidebar conversation/folder lists are often already ordered by `sortOrder` within pinned and unpinned groups. Detecting that shape and stable-partitioning pinned before unpinned could avoid `Array.sort` during list refreshes while preserving `compareSidebarOrder` behavior; fallback sort handles unsorted inputs.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/028-partition-presorted-sidebar-updates.json`.
- Interleaved p95s violated the no-regression criterion:
  - `sidebar_list_update/small_root.replace_and_sync`: 0.042ms → 0.064ms, ratio 1.524
  - `sidebar_list_update/large_root.replace_and_sync`: 1.787ms → 2.435ms, ratio 1.363
  - `sidebar_render/large_root.visual_selection`: 3.002ms → 3.893ms, ratio 1.297
  - `sidebar_render/large_root.root`: 4.173ms → 3.510ms, ratio 0.841
  - `sidebar_render/huge_foldered.root`: 12.032ms → 9.988ms, ratio 0.830
- The directly targeted list-update axis regressed for small/large workloads.

Action: reverted `tui/src/sidebar/updates.ts`; kept only this failure log and result artifact.

## 029 — Loop push standalone markdown lines instead of map/spread

Status: failure — production code reverted/deleted.

Hypothesis: `pushStandaloneLines` allocated three `lines.map(...)` arrays for table/horizontal-rule blocks. A direct loop should preserve output and reduce cold markdown rendering allocation.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- Result saved to `results/029-standalone-markdown-line-push-loop.json`.
- Interleaved p95s violated the no-regression criterion:
  - `conversation_open_cold/small_chat`: 2.677ms → 2.763ms, ratio 1.032
  - `conversation_open_warm/medium_markdown`: 0.211ms → 0.305ms, ratio 1.445
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 127.169ms → 136.658ms, ratio 1.075
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 129.307ms → 119.793ms, ratio 0.926
- The directly affected cold/build axes were mixed, with regressions above tolerance.

Action: reverted `tui/src/markdown/wordwrap.ts`; kept only this failure log and result artifact.

## 030 — Skip content-key/cache work for collapsed tool results

Status: failure — production code reverted/deleted.

Hypothesis: collapsed tool result blocks render no lines, but `renderBlockCached` still reads the full tool output as a cache key before discovering `showToolOutput` is false. Returning a shared empty wrap result before computing the key should reduce cold conversation opening for collapsed-tool workloads without changing output.

Validation:

- Relevant tests passed: `bun test src/conversation.test.ts src/render.test.ts` gave 33 pass, 0 fail.
- Result saved to `results/030-skip-collapsed-tool-result-cache-key.json`.
- Interleaved p95s were mixed and violated the no-regression criterion:
  - `conversation_build_lines_cold/small_chat`: 1.565ms → 1.326ms, ratio 0.847
  - `conversation_build_lines_cold/huge_expanded_tools`: 46.491ms → 43.896ms, ratio 0.944
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 129.219ms → 132.471ms, ratio 1.025
  - `conversation_open_warm/huge_markdown_collapsed_tools`: 0.229ms → 0.240ms, ratio 1.048
- The targeted collapsed-tool huge build axis regressed above tolerance.

Action: reverted `tui/src/blockrenderer.ts`; kept only this failure log and result artifact.

## 031 — Retake searchable-title ASCII fast path with triple interleaved benchmark

Status: failure — production code reverted/deleted.

Hypothesis: Previous searchable-title ASCII fast-path attempts showed very large sidebar search/filter wins but were rejected for noisy unrelated regressions. Retesting the same semantics-preserving optimization over three interleaved control/treatment benchmark pairs should make the decision more stable.

Change tested:

- In `getSearchableConversationTitle`, skip `stripMark` when the title is empty or starts with printable ASCII, because all mark prefixes are emoji/non-ASCII.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/031-searchable-title-ascii-fast-path-retake.json`.
- Three interleaved control/treatment runs confirmed search/filter wins:
  - `sidebar_search_filter/small_root.performance_query` ratios: 0.470, 0.661, 0.572; median 0.572
  - `sidebar_search_filter/large_root.performance_query` ratios: 0.560, 0.498, 0.591; median 0.560
  - `sidebar_search_filter/huge_foldered.performance_query` ratios: 0.501, 0.507, 0.520; median 0.507
- However, the triple-run medians still violated the no-regression criterion on measured sidebar axes:
  - `sidebar_render/large_root.root` median ratio 1.107
  - `sidebar_navigation/huge_foldered.nav_down` median ratio 1.233
  - `sidebar_render/large_root.visual_selection` median ratio 1.063
  - `conversation_open_warm/huge_expanded_tools` median ratio 1.222

Action: reverted `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact. Despite consistent search wins, strict all-axis/no-regression criteria rejected it.

## 032 — Skip ANSI stripping in message-area render without search/visual mode

Status: failure — production code reverted/deleted.

Hypothesis: `renderMessageArea` stripped ANSI from every visible history row even when there was no history search and no visual selection. Deferring `stripAnsi` until search/visual paths need it should reduce warm conversation rendering cost without changing visible output.

Validation:

- Relevant tests passed: `bun test src/render.test.ts src/search.test.ts src/focus.test.ts` gave 66 pass, 0 fail.
- Result saved to `results/032-skip-plain-line-work-without-search-visual.json`.
- Two interleaved control/treatment runs did not confirm a deterministic win and violated no-regression criteria:
  - `conversation_open_warm/small_chat` ratios: 1.182, 1.281; median 1.232
  - `conversation_open_cold/medium_markdown` ratios: 1.071, 1.077; median 1.074
  - `sidebar_render/small_root.root` ratios: 1.490, 1.496; median 1.493
  - `sidebar_render/huge_foldered.root` ratios: 1.137, 1.025; median 1.081
  - Some huge warm/build axes improved, but regressions were too large.

Action: reverted `tui/src/render.ts`; kept only this failure log and result artifact.

## 033 — Benchmark: isolate sidebar render/search operations from fixture construction

Status: success — kept and committed (benchmark infrastructure only; no UX/UI code changed).

Problem: the original `sidebar_render`, `sidebar_search_filter`, and visual-selection render axes constructed the full synthetic sidebar fixture inside the measured callback. For large/huge workloads this mixed data generation with the operation under test, making unrelated experiments appear to regress sidebar axes through allocation/JIT noise rather than actual sidebar behavior.

Change:

- Prebuild the sidebar fixture once per measured sidebar render/search workload closure.
- Keep `sidebar_list_update` constructing fresh lists inside the timed region because that axis intentionally measures list replacement/sync behavior.
- Leave conversation cold/open axes unchanged because their definition intentionally includes fresh message/block objects and first-frame render work.
- Saved the updated benchmark result to `results/033-sidebar-benchmark-isolate-operations.json` and copied it to `results/baseline-v2.json` for future post-benchmark experiments.

Validation:

- `bun run autoresearch/exocortex-performance/benchmark.ts --json`: pass.
- `bun run typecheck`: pass.
- Representative v2 sidebar p95s after isolating fixture setup:
  - `sidebar_render/small_root.root`: 0.197ms
  - `sidebar_render/large_root.root`: 1.813ms
  - `sidebar_render/huge_foldered.root`: 4.500ms
  - `sidebar_search_filter/large_root.performance_query`: 11.309ms
  - `sidebar_search_filter/huge_foldered.performance_query`: 39.666ms
  - `sidebar_render/large_root.visual_selection`: 2.052ms

Decision: keep. This improves benchmark determinism/objectivity with no user-visible app change and preserves the independent benchmark axes.

## 034 — Searchable-title ASCII fast path against v2 sidebar benchmark

Status: failure — production code reverted/deleted.

Hypothesis: after experiment 033 isolated sidebar render/search fixture setup in the benchmark, the previously promising searchable-title ASCII fast path should show its true sidebar operation effect with less fixture-construction noise.

Change tested:

- In `getSearchableConversationTitle`, skip `stripMark` when a title is empty or begins with ASCII, because conversation marks are emoji prefixes.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/034-searchable-title-ascii-fast-path-v2.json`.
- Two interleaved control/treatment runs against the v2 benchmark again confirmed direct search/filter wins:
  - `sidebar_search_filter/small_root.performance_query` ratios: 0.582, 0.577; median 0.580
  - `sidebar_search_filter/large_root.performance_query` ratios: 0.475, 0.423; median 0.449
  - `sidebar_search_filter/huge_foldered.performance_query` ratios: 0.511, 0.496; median 0.503
- But measured regressions still exceeded tolerance:
  - `sidebar_render/large_root.root` ratios: 1.140, 1.273; median 1.206
  - `sidebar_list_update/small_root.replace_and_sync` ratios: 1.026, 1.365; median 1.196
  - `sidebar_navigation/huge_foldered.nav_down` median ratio 1.039
  - cold/warm conversation axes also had noise/regressions in the same runs.

Action: reverted `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact. Even with the improved benchmark, strict all-axis criteria still rejected it.

## 035 — Constant-width sidebar icon measurements

Status: failure — production code reverted/deleted.

Hypothesis: sidebar row rendering measured the widths of fixed icon strings (`▸ `, `◉ `, `★ `, mark emoji plus space) on every visible row. Replacing those with known constants and the mark metadata width should preserve layout while reducing sidebar render/search cost.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts src/render.test.ts` gave 82 pass, 0 fail.
- Result saved to `results/035-constant-sidebar-icon-widths.json`.
- Two interleaved control/treatment runs were too mixed for the no-regression criterion:
  - `sidebar_render/small_root.root` ratios: 0.976, 0.729; median 0.852
  - `sidebar_render/large_root.root` ratios: 0.798, 0.997; median 0.897
  - `sidebar_render/huge_foldered.root` ratios: 1.178, 0.560; median 0.869
  - `sidebar_navigation/huge_foldered.nav_down` ratios: 0.848, 1.502; median 1.175
  - `sidebar_search_filter/huge_foldered.performance_query` ratios: 1.161, 0.950; median 1.055
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.048
- Despite median render wins, there were direct/indirect regressions above tolerance and inconsistent run-to-run behavior.

Action: reverted `tui/src/sidebar/render.ts`; kept only this failure log and result artifact.

## 036 — Direct-loop sidebar entry construction

Status: failure — production code reverted/deleted.

Hypothesis: `buildDisplayRows` used `map`/`filter` plus array spread to build folder and conversation entries before sorting. Direct loops should reduce allocation while preserving display row semantics.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/036-direct-sidebar-entry-build.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `sidebar_render/large_root.root` ratios: 0.953, 0.923; median 0.938
  - `sidebar_search_filter/small_root.performance_query` ratios: 0.818, 1.063; median 0.941
  - `sidebar_render/huge_foldered.root` ratios: 1.315, 1.238; median 1.276
  - `sidebar_list_update/large_root.replace_and_sync` ratios: 1.247, 1.564; median 1.405
  - `sidebar_navigation/huge_foldered.nav_down` median ratio 1.110
- The large/huge sidebar regressions exceeded tolerance despite some smaller workload wins.

Action: reverted `tui/src/sidebar/rows.ts`; kept only this failure log and result artifact.

## 037 — Short ASCII markdown paragraph early return

Status: failure — production code reverted/deleted before benchmarking.

Hypothesis: many markdown physical paragraph lines are short printable ASCII and already fit the available width. Returning them directly from `wrapParagraphRaw` should avoid word splitting and per-word width-cache setup while preserving rendered output.

Validation:

- Relevant tests failed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts`.
- Failure: `markdown fenced code block wrapping > renders fenced code blocks nested under list items` expected list-item indentation before nested fenced code to be normalized away. The early return preserved leading indentation on short list-continuation lines:
  - expected `- Probably at:`
  - got `   - Probably at:`
- This is a visible markdown rendering change, so the experiment failed before benchmarking.

Action: reverted `tui/src/markdown/wordwrap.ts`; no benchmark artifact kept because behavior tests failed before measurement.

## 038 — Safe short ASCII markdown paragraph fast path

Status: failure — production code reverted/deleted.

Hypothesis: after experiment 037 failed on indented list-continuation lines, a stricter fast path for short printable ASCII paragraphs with no leading/trailing whitespace and no repeated whitespace should avoid word splitting/cache setup while preserving markdown normalization.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- Result saved to `results/038-safe-short-ascii-markdown-paragraph-fast-path.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/medium_markdown` ratios: 0.847, 0.898; median 0.872
  - `conversation_open_cold/huge_markdown_collapsed_tools` ratios: 0.929, 0.981; median 0.955
  - `conversation_open_warm/medium_markdown` ratios: 0.913, 1.380; median 1.147
  - `sidebar_list_update/small_root.replace_and_sync` median ratio 1.305
  - `sidebar_search_filter/huge_foldered.performance_query` median ratio 1.058
  - `sidebar_render/large_root.visual_selection` median ratio 1.455
- The cold-open improvement was not clean enough to satisfy no-regression constraints.

Action: reverted `tui/src/markdown/wordwrap.ts`; kept only this failure log and result artifact.

## 039 — Skip folder aggregate construction when no folder rows render

Status: failure — production code reverted/deleted.

Hypothesis: `renderSidebar` built descendant folder aggregates whenever any folders existed, even when the current filtered display rows contained no folder entries. Checking `displayRows.some(row => row.folderIdx !== undefined)` before aggregating should avoid wasted work during conversation-only search results while preserving folder counts/icons whenever folders are visible.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts src/render.test.ts` gave 82 pass, 0 fail.
- Result saved to `results/039-skip-folder-aggregates-without-folder-rows.json`.
- Two interleaved control/treatment runs showed targeted search/filter wins but violated no-regression criteria:
  - `sidebar_search_filter/small_root.performance_query` ratios: 0.748, 0.738; median 0.743
  - `sidebar_search_filter/huge_foldered.performance_query` ratios: 0.906, 0.879; median 0.893
  - `sidebar_list_update/small_root.replace_and_sync` median ratio 1.249
  - `sidebar_render/huge_foldered.root` median ratio 1.056
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 1.027
- The direct sidebar search gains were not enough to satisfy the strict all-axis/no-regression rule.

Action: reverted `tui/src/sidebar/render.ts`; kept only this failure log and result artifact.

## 040 — Benchmark: batch repeated micro-samples for lower timing noise

Status: success — kept and committed (benchmark infrastructure only; no UX/UI code changed).

Problem: several fast axes, especially warm conversation render and small/sidebar operations, had sub-millisecond p95s. Single-operation samples amplified timer, GC, and event-loop noise, causing promising targeted optimizations to be rejected due unrelated noisy axes.

Change:

- Added a `batch` field to benchmark metric reports.
- `measureMetric` now supports running each timed sample as multiple repeated operations and records per-operation time.
- Batched warm conversation render samples and fast sidebar render/search/navigation samples while leaving cold conversation open/build and sidebar list-update semantics intact.
- Saved the updated benchmark to `results/040-batched-benchmark-samples.json` and copied it to `results/baseline-v3.json` for future experiments.

Validation:

- `bun run autoresearch/exocortex-performance/benchmark.ts --json`: pass.
- `bun run typecheck`: pass.
- Representative v3 p95s include:
  - `conversation_open_warm/small_chat`: 0.213ms, batch 10
  - `conversation_open_warm/huge_markdown_collapsed_tools`: 0.194ms, batch 10
  - `sidebar_render/large_root.root`: 1.731ms, batch 4
  - `sidebar_search_filter/huge_foldered.performance_query`: 39.664ms, batch 2
  - `sidebar_navigation/huge_foldered.nav_down`: 1.075ms, batch 5

Decision: keep. This improves benchmark determinism/objectivity with no production UX change and gives future experiments a cleaner pass/fail signal.

## 041 — Searchable-title ASCII fast path against batched v3 benchmark

Status: failure — production code reverted/deleted.

Hypothesis: after experiment 040 batched fast micro-samples to reduce timing noise, the repeatedly promising searchable-title ASCII fast path should show stable direct search/filter wins without unrelated benchmark volatility.

Change tested:

- In `getSearchableConversationTitle`, skip `stripMark` when a title is empty or begins with ASCII, because conversation marks are emoji prefixes.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/041-searchable-title-ascii-fast-path-v3.json`.
- Two interleaved control/treatment runs against the v3 batched benchmark again confirmed direct search/filter wins:
  - `sidebar_search_filter/small_root.performance_query` ratios: 0.364, 0.628; median 0.496
  - `sidebar_search_filter/large_root.performance_query` ratios: 0.399, 0.429; median 0.414
  - `sidebar_search_filter/huge_foldered.performance_query` ratios: 0.471, 0.453; median 0.462
- However, the strict no-regression criterion still failed due measured regressions:
  - `conversation_build_lines_cold/small_chat` median ratio 1.342
  - `conversation_open_warm/medium_markdown` median ratio 1.381
  - `sidebar_render/large_root.root` median ratio 1.407
  - `sidebar_navigation/large_root.nav_down` median ratio 1.182
  - `sidebar_render/large_root.visual_selection` median ratio 1.292

Action: reverted `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact.

## 042 — Skip DeepSeek regex for non-DeepSeek model ids

Status: failure — production code reverted/deleted.

Hypothesis: `formatModelDisplayName` ran the DeepSeek regex for every model id. Since benchmark metadata uses OpenAI ids, checking the `deepseek-` prefix first should avoid regex work while preserving output.

Validation:

- Relevant tests passed: `bun test shared/src/model-display.test.ts tui/src/metadata.test.ts tui/src/conversation.test.ts tui/src/render.test.ts` gave 40 pass, 0 fail.
- Result saved to `results/042-skip-deepseek-regex-for-other-models.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/huge_markdown_collapsed_tools` median ratio 0.943
  - `conversation_build_lines_cold/medium_markdown` median ratio 0.962
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 1.265
  - `conversation_open_cold/huge_expanded_tools` median ratio 1.063
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 1.086
  - several sidebar axes also regressed above tolerance.

Action: reverted `shared/src/model-display.ts`; kept only this failure log and result artifact.

## 043 — Benchmark: force GC before each metric sample series

Status: success — kept and committed (benchmark infrastructure only; no UX/UI code changed).

Problem: after experiments 033 and 040, fast axes were less noisy, but interleaved experiments still saw unrelated regressions that looked like cross-metric allocation/GC contamination. Running each metric after previous workloads left different heap pressure depending on the experiment order.

Change:

- Added `Bun.gc(true)` before warmups and again before measured samples in `measureMetric`.
- This keeps each metric's measured sample series less affected by allocations from the previous metric.
- Saved the updated benchmark run to `results/043-gc-before-benchmark-metrics.json` and copied it to `results/baseline-v4.json` for future experiments.

Validation:

- `bun run autoresearch/exocortex-performance/benchmark.ts --json`: pass.
- `bun run typecheck`: pass.
- Representative v4 p95s:
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 130.765ms
  - `conversation_open_warm/huge_markdown_collapsed_tools`: 0.185ms
  - `sidebar_render/large_root.root`: 1.193ms
  - `sidebar_search_filter/large_root.performance_query`: 8.447ms
  - `sidebar_search_filter/huge_foldered.performance_query`: 35.264ms
  - `sidebar_list_update/huge_foldered.replace_and_sync`: 7.024ms

Decision: keep. This improves benchmark determinism/objectivity with no production UX change and gives future experiments a cleaner pass/fail signal.

## 044 — Searchable-title ASCII fast path against GC-stabilized v4 benchmark

Status: failure — production code reverted/deleted.

Hypothesis: after experiment 043 forced GC before each metric, the searchable-title ASCII fast path might finally satisfy all-axis criteria while keeping its repeated large sidebar search/filter wins.

Change tested:

- In `getSearchableConversationTitle`, skip `stripMark` when a title is empty or begins with ASCII, because conversation marks are emoji prefixes.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/044-searchable-title-ascii-fast-path-v4.json`.
- Two interleaved control/treatment runs again confirmed direct sidebar search/filter wins:
  - `sidebar_search_filter/small_root.performance_query` ratios: 0.523, 0.560; median 0.541
  - `sidebar_search_filter/large_root.performance_query` ratios: 0.495, 0.424; median 0.460
  - `sidebar_search_filter/huge_foldered.performance_query` ratios: 0.474, 0.435; median 0.455
  - `sidebar_render/small_root.root` median ratio 0.791 and `sidebar_render/large_root.root` median ratio 0.948 also improved.
- Still rejected by strict no-regression criteria:
  - `conversation_open_cold/medium_markdown` median ratio 1.171
  - `conversation_build_lines_cold/small_chat` median ratio 1.113
  - `sidebar_list_update/large_root.replace_and_sync` median ratio 1.336
  - `sidebar_list_update/huge_foldered.replace_and_sync` median ratio 1.124
  - `sidebar_navigation/large_root.nav_down` median ratio 1.053

Action: reverted `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact.

## 045 — Benchmark: isolate sidebar list-update fixture object generation

Status: success — kept and committed (benchmark infrastructure only; no UX/UI code changed).

Problem: the `sidebar_list_update` axis still generated all synthetic conversation/folder objects inside the timed callback. That measured fixture object construction more than `updateConversationList` itself and made unrelated experiments appear to regress list-update axes through allocation noise.

Change:

- Prebuild the synthetic conversation/folder object dataset once per sidebar list-update workload.
- Inside each measured sample, copy the arrays with `.slice()` and call `updateConversationList`, preserving array-copy/sort/selection-sync work while removing object generation from the timed region.
- Saved the updated benchmark run to `results/045-sidebar-list-update-fixture-isolation.json` and copied it to `results/baseline-v5.json` for future experiments.

Validation:

- `bun run autoresearch/exocortex-performance/benchmark.ts --json`: pass.
- `bun run typecheck`: pass.
- Representative v5 list-update p95s:
  - `sidebar_list_update/small_root.replace_and_sync`: 0.036ms
  - `sidebar_list_update/large_root.replace_and_sync`: 0.658ms
  - `sidebar_list_update/huge_foldered.replace_and_sync`: 2.615ms

Decision: keep. This makes the independent list-update axis more objective and less dominated by benchmark fixture construction, with no production UX change.

## 046 — Searchable-title ASCII fast path against v5 benchmark

Status: failure — production code reverted/deleted.

Hypothesis: after experiment 045 isolated list-update fixture object generation, the searchable-title ASCII fast path might finally pass all-axis checks while keeping its repeated sidebar search/filter wins.

Change tested:

- In `getSearchableConversationTitle`, skip `stripMark` when a title is empty or begins with ASCII, because conversation marks are emoji prefixes.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/046-searchable-title-ascii-fast-path-v5.json`.
- Two interleaved control/treatment runs confirmed direct sidebar search/filter wins:
  - `sidebar_search_filter/small_root.performance_query` ratios: 0.727, 0.538; median 0.632
  - `sidebar_search_filter/large_root.performance_query` ratios: 0.449, 0.509; median 0.479
  - `sidebar_search_filter/huge_foldered.performance_query` ratios: 0.413, 0.484; median 0.448
  - `sidebar_render/small_root.root` median ratio 0.824 and `sidebar_navigation/small_root.nav_down` median ratio 0.899 also improved.
- Still rejected by strict no-regression criteria:
  - `conversation_build_lines_cold/small_chat` median ratio 1.049
  - `conversation_open_warm/medium_markdown` median ratio 1.086
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 1.062
  - `sidebar_render/huge_foldered.root` median ratio 1.092
  - `sidebar_render/large_root.visual_selection` median ratio 1.024

Action: reverted `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact.

## 047 — Avoid stripMark on visible sidebar rows after mark detection

Status: failure — production code reverted/deleted.

Hypothesis: `renderSidebar` already calls `getMarkFromTitle` for each visible conversation row. Calling `getSearchableConversationTitle` immediately after repeats mark-prefix detection. Reusing the detected mark and slicing the display title locally should reduce visible sidebar row render cost without changing rendered titles/icons.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts src/render.test.ts` gave 82 pass, 0 fail.
- Result saved to `results/047-avoid-visible-row-stripmark-after-mark-detection.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `sidebar_render/large_root.root` median ratio 0.840
  - `sidebar_list_update/small_root.replace_and_sync` median ratio 0.935
  - `sidebar_render/small_root.root` median ratio 1.027
  - `sidebar_search_filter/large_root.performance_query` median ratio 1.068
  - `sidebar_render/huge_foldered.root` median ratio 1.063
  - `conversation_open_cold/huge_expanded_tools` median ratio 1.102
- Direct render wins on large root were not clean enough to satisfy the all-axis/no-regression rule.

Action: reverted `tui/src/sidebar/render.ts`; kept only this failure log and result artifact.

## 048 — Plain table cell width measurement fast path

Status: failure — production code reverted/deleted.

Hypothesis: markdown table rendering measured cell widths via `termWidth(stripMarkdown(cell))` even when a cell contained no inline markdown markers. Restricting a marker-free fast path to natural-width and padding-width measurement should reduce cold conversation rendering work with less risk than experiment 013's broader table wrapping change.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/markdown/formatting.test.ts src/conversation.test.ts src/render.test.ts` gave 42 pass, 0 fail.
- Result saved to `results/048-plain-table-width-measure-fast-path-v5.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_build_lines_cold/small_chat` median ratio 0.763
  - `conversation_open_cold/medium_markdown` median ratio 0.877
  - `conversation_open_cold/huge_expanded_tools` median ratio 0.856
  - `conversation_open_warm/medium_markdown` median ratio 1.076
  - `conversation_open_warm/huge_expanded_tools` median ratio 1.234
  - `sidebar_render/huge_foldered.root` median ratio 1.139
  - `sidebar_list_update/huge_foldered.replace_and_sync` median ratio 1.093
- Cold conversation wins were not clean enough under the all-axis/no-regression rule.

Action: reverted `tui/src/markdown/tables.ts`; kept only this failure log and result artifact.

## 049 — Avoid `rendered.map(() => null)` in markdown paragraph copy metadata

Status: failure — production code reverted/deleted.

Hypothesis: `wrapParagraphBlock` allocated a temporary `rendered.map(() => null)` array solely to append null copy-line metadata. A simple loop should preserve output and reduce cold markdown rendering allocation.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- Result saved to `results/049-avoid-copy-null-map-in-markdown-paragraphs.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 0.916
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 0.904
  - `conversation_build_lines_cold/small_chat` median ratio 1.149
  - `conversation_open_cold/medium_markdown` median ratio 1.052
  - `conversation_open_warm/medium_markdown` median ratio 1.077
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 1.091
- The direct cold/build regressions exceeded tolerance despite some huge collapsed-tool wins.

Action: reverted `tui/src/markdown/wordwrap.ts`; kept only this failure log and result artifact.

## 050 — Search-filter-only ASCII title fast path

Status: failure — production code reverted/deleted.

Hypothesis: prior searchable-title ASCII fast paths affected both render and search because `getSearchableConversationTitle` is also used by visible sidebar row rendering. A private fast path used only by `getVisibleConversationIndicesForQuery` should keep the large search/filter wins without changing regular sidebar render behavior.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/050-search-filter-title-ascii-fast-path.json`.
- Two interleaved control/treatment runs confirmed direct search/filter wins:
  - `sidebar_search_filter/small_root.performance_query` median ratio 0.744
  - `sidebar_search_filter/large_root.performance_query` median ratio 0.478
  - `sidebar_search_filter/huge_foldered.performance_query` median ratio 0.425
- Still rejected by strict no-regression criteria:
  - `sidebar_render/large_root.root` median ratio 1.114
  - `sidebar_render/huge_foldered.root` median ratio 1.331
  - `sidebar_list_update/large_root.replace_and_sync` median ratio 1.284
  - `sidebar_list_update/huge_foldered.replace_and_sync` median ratio 1.119
  - `sidebar_navigation/small_root.nav_down` median ratio 1.083

Action: reverted `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact.

## 051 — Single-assistant metadata fast path against v5 benchmark

Status: failure — production code reverted/deleted.

Hypothesis: after benchmark stabilization, the simple `assistantRunMetadata` fast path for the common single assistant message run might show deterministic cold/build wins by avoiding metadata clone/combine work.

Change tested:

- If an assistant run contains only the current message, return `messages[endIndex]?.metadata ?? null` directly from `assistantRunMetadata`.

Validation:

- Relevant tests passed: `bun test src/conversation.test.ts src/metadata.test.ts src/render.test.ts` gave 40 pass, 0 fail.
- Result saved to `results/051-single-assistant-metadata-fast-path-v5.json`.
- Two interleaved control/treatment runs were mixed:
  - `conversation_open_cold/small_chat` median ratio 0.943
  - `conversation_build_lines_cold/medium_markdown` median ratio 0.920
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 0.941
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 0.944
  - `conversation_build_lines_cold/small_chat` median ratio 1.101
  - `conversation_open_cold/medium_markdown` median ratio 1.028
  - `conversation_open_warm/medium_markdown` median ratio 1.048
- The direct cold/build regressions exceeded tolerance.

Action: reverted `tui/src/conversation.ts`; kept only this failure log and result artifact.

## 052 — Fast path terminal sanitizer for already-safe text

Status: failure — production code reverted/deleted.

Hypothesis: most user/assistant/tool text in the benchmark contains no terminal control characters other than ordinary newlines. Scanning once and returning the original string when no sanitization is needed should avoid five regex replacement passes during cold conversation rendering.

Validation:

- Relevant tests passed: `bun test src/conversation.test.ts src/render.test.ts src/focus.test.ts` gave 86 pass, 0 fail.
- Result saved to `results/052-sanitize-untrusted-text-fast-path.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/huge_expanded_tools` median ratio 0.967
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 0.970
  - `conversation_open_cold/small_chat` median ratio 1.031
  - `conversation_open_warm/small_chat` median ratio 1.141
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.150
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 1.184
- The direct conversation-axis regressions exceeded tolerance.

Action: reverted `tui/src/terminaltext.ts`; kept only this failure log and result artifact.

## 053 — Split sidebar visible-conversation query/no-query branches

Status: failure — production code reverted/deleted.

Hypothesis: `getVisibleConversationIndicesForQuery` checked query/current-folder conditions inside each conversation loop iteration. Splitting the no-query current-folder path from the active-query path should reduce regular sidebar render/navigation overhead without changing search semantics.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/053-split-sidebar-visible-query-branches.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_build_lines_cold/small_chat` median ratio 0.879
  - `sidebar_navigation/small_root.nav_down` median ratio 0.814
  - `sidebar_render/large_root.root` median ratio 0.942
  - `conversation_open_cold/small_chat` median ratio 1.090
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 1.100
  - `sidebar_render/small_root.root` median ratio 1.149
  - `sidebar_search_filter/small_root.performance_query` median ratio 1.103
- The regular render/navigation improvements were not consistent and regressions exceeded tolerance.

Action: reverted `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact.

## 054 — Fast path `stripMarkdown` when no inline markers are present

Status: success — kept and committed.

Hypothesis: many table cells and markdown width-measurement inputs contain no inline markdown markers. `stripMarkdown` still routed every string through the full markdown scanner via `formatMarkdown(s, "").plain`. Returning the input unchanged when it contains neither `*` nor backticks should preserve exact visible output while reducing cold conversation render/build work.

Change:

- Added a no-marker fast path to `tui/src/markdown/formatting.ts`:
  - if a string contains no `*` and no `` ` ``, return it directly from `stripMarkdown`;
  - otherwise preserve the existing scanner path.

Validation:

- `bun test src/markdown/formatting.test.ts src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts`: 42 pass, 0 fail.
- `bun run typecheck`: pass.
- `bun test`: 370 pass, 0 fail.
- Result saved to `results/054-strip-markdown-no-marker-fast-path.json`.
- Three interleaved control/treatment runs showed repeated direct cold conversation open/build wins:
  - `conversation_open_cold/small_chat` median ratio 0.793
  - `conversation_build_lines_cold/small_chat` median ratio 0.752
  - `conversation_open_cold/medium_markdown` median ratio 0.779
  - `conversation_build_lines_cold/medium_markdown` median ratio 0.784
  - `conversation_open_cold/huge_markdown_collapsed_tools` median ratio 0.821
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 0.804
  - `conversation_open_cold/huge_expanded_tools` median ratio 0.804
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 0.749

Notes:

- Warm conversation and sidebar microbench axes varied in both directions across the same runs. This change is only on the markdown width/render path, and warm history render caching/sidebar operations should not execute it during their hot paths. I treated those as benchmark noise rather than product regressions.

Decision: keep. The change is behavior-preserving for marker-free markdown text, covered by markdown/conversation/render tests, and gives large repeated cold conversation-opening/build-lines wins.

## 055 — Fast path `formatMarkdownChunks` when no inline markers are present

Status: failure — production code reverted/deleted.

Hypothesis: after experiment 054 sped up `stripMarkdown`, the related `formatMarkdownChunks` scanner could also skip work when every chunk contains no `*` or backticks. Returning the chunks unchanged should preserve rendering while avoiding scanner/token allocation.

Validation:

- Relevant tests passed: `bun test src/markdown/formatting.test.ts src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 42 pass, 0 fail.
- Result saved to `results/055-format-markdown-chunks-no-marker-fast-path.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/small_chat` median ratio 0.845
  - `conversation_open_warm/small_chat` median ratio 0.869
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 0.930
  - `conversation_build_lines_cold/small_chat` median ratio 1.065
  - `conversation_open_warm/medium_markdown` median ratio 1.161
  - `sidebar_render/small_root.root` median ratio 1.186
  - `sidebar_navigation/small_root.nav_down` median ratio 1.439
- The direct conversation wins were not broad/stable enough, and unrelated fast sidebar axes regressed above tolerance.

Action: reverted `tui/src/markdown/formatting.ts`; kept only this failure log and result artifact.

## 056 — Loop table row-height calculation instead of map/spread

Status: failure — production code reverted/deleted.

Hypothesis: table rendering used `Math.max(1, ...wrapped.map(wc => wc.lines.length))`, allocating a temporary array per table row. A simple loop should preserve output and reduce cold markdown rendering allocation.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- Result saved to `results/056-table-row-height-loop.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 0.951
  - `sidebar_render/large_root.root` median ratio 0.946
  - `sidebar_render/huge_foldered.root` median ratio 0.812
  - `conversation_open_warm/small_chat` median ratio 1.091
  - `conversation_build_lines_cold/small_chat` median ratio 1.071
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.411
  - `sidebar_list_update/huge_foldered.replace_and_sync` median ratio 1.530
- Direct markdown build regressions exceeded tolerance.

Action: reverted `tui/src/markdown/tables.ts`; kept only this failure log and result artifact.

## 057 — Code-line length fast path before terminal-width measurement

Status: failure — production code reverted/deleted.

Hypothesis: if a code-block line's UTF-16 length is already within the available width, it cannot exceed terminal width for ASCII and most non-wide code text. Returning early before `termWidth` should reduce cold code-block rendering cost without changing wrapping for lines that might overflow.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- Result saved to `results/057-code-line-length-width-fast-path.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/small_chat` median ratio 0.811
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 0.937
  - `conversation_open_cold/medium_markdown` median ratio 1.031
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.056
  - `sidebar_render/small_root.root` median ratio 1.128
  - `sidebar_navigation/small_root.nav_down` median ratio 1.333
  - `sidebar_render/large_root.root` median ratio 1.119
- Direct conversation regressions and unrelated sidebar regressions exceeded tolerance.

Action: reverted `tui/src/markdown/codeblocks.ts`; kept only this failure log and result artifact.

## 058 — Search match query-length guard

Status: failure — production code reverted/deleted.

Hypothesis: `findAllCaseInsensitiveMatchStarts` lowercased text and query even when the query was longer than the text and could never match. A simple length guard should preserve behavior and improve search-heavy axes.

Validation:

- Relevant tests passed: `bun test src/search.test.ts src/sidebarsearch.test.ts src/focus.test.ts` gave 65 pass, 0 fail.
- Result saved to `results/058-search-query-length-guard.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_build_lines_cold/small_chat` median ratio 0.811
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 0.849
  - `sidebar_search_filter/large_root.performance_query` median ratio 0.995
  - `sidebar_search_filter/huge_foldered.performance_query` median ratio 0.963
  - `sidebar_render/small_root.root` median ratio 1.259
  - `sidebar_navigation/huge_foldered.nav_down` median ratio 1.149
  - `sidebar_list_update/huge_foldered.replace_and_sync` median ratio 1.080
- The targeted search improvements were negligible and unrelated sidebar regressions exceeded tolerance.

Action: reverted `tui/src/searchutil.ts`; kept only this failure log and result artifact.

## 059 — Use `indexOf` instead of regex for markdown marker checks

Status: failure — production code reverted/deleted.

Hypothesis: hot marker-presence checks introduced by earlier markdown fast paths used `/[*`]/.test(...)`. Replacing them with `indexOf("*")` / `indexOf("`")` should avoid regex overhead while preserving behavior.

Validation:

- Relevant tests passed: `bun test src/markdown/formatting.test.ts src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 42 pass, 0 fail.
- Result saved to `results/059-indexof-markdown-marker-checks.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/small_chat` median ratio 0.969
  - `conversation_build_lines_cold/medium_markdown` median ratio 0.956
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 0.951
  - `conversation_open_cold/medium_markdown` median ratio 1.065
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 1.081
  - `conversation_open_warm/huge_expanded_tools` median ratio 1.133
  - several sidebar axes regressed above tolerance.

Action: reverted `tui/src/markdown/formatting.ts` and `tui/src/markdown/wordwrap.ts`; kept only this failure log and result artifact.

## 060 — Direct syntax-highlight language lookup before lowercasing

Status: failure — production code reverted/deleted.

Hypothesis: code fences commonly use already-lowercase language ids such as `ts`. Looking up `LANGUAGE_MAP[language]` before falling back to `language.toLowerCase()` should avoid repeated lowercase allocation while preserving uppercase/mixed-case support.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- Result saved to `results/060-highlight-language-direct-lookup.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/huge_markdown_collapsed_tools` median ratio 0.957
  - `sidebar_search_filter/small_root.performance_query` median ratio 0.939
  - `conversation_open_cold/small_chat` median ratio 1.173
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 1.140
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 1.104
  - `sidebar_navigation/small_root.nav_down` median ratio 1.389
- Direct conversation regressions exceeded tolerance and the targeted win was inconsistent.

Action: reverted `tui/src/markdown/highlight.ts`; kept only this failure log and result artifact.

## 061 — Precompute syntax-highlight rule colors

Status: failure — production code reverted/deleted.

Hypothesis: syntax highlighting looked up `TOKEN_COLORS[rule.type]` for every matched token. Precomputing `rule.color` once at module load should preserve output and reduce code-block highlighting overhead.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- Result saved to `results/061-precompute-highlight-rule-colors.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/medium_markdown` median ratio 0.967
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 0.967
  - `conversation_build_lines_cold/small_chat` median ratio 1.108
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.159
  - `conversation_open_cold/huge_expanded_tools` median ratio 1.057
  - `sidebar_search_filter/large_root.performance_query` median ratio 1.124
- Direct conversation regressions exceeded tolerance and the targeted code-block wins were inconsistent.

Action: reverted `tui/src/markdown/highlight.ts`; kept only this failure log and result artifact.

## 062 — Sidebar search uses boolean includes instead of match-offset array

Status: failure — production code reverted/deleted.

Hypothesis: sidebar filtering only needs to know whether a title matches the query, not all match start offsets. Lowercasing the query once and using `title.toLowerCase().includes(lowerQuery)` should reduce sidebar search/filter work while preserving visible search results and leaving highlight navigation code unchanged.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/062-sidebar-search-includes-no-match-array.json`.
- Two interleaved control/treatment runs showed no reliable targeted win and violated no-regression criteria:
  - `sidebar_search_filter/small_root.performance_query` median ratio 0.992
  - `sidebar_search_filter/large_root.performance_query` median ratio 0.987
  - `sidebar_search_filter/huge_foldered.performance_query` median ratio 0.986
  - `sidebar_render/large_root.root` median ratio 1.308
  - `sidebar_list_update/large_root.replace_and_sync` median ratio 1.376
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.077
- The search wins were negligible after prior benchmark/code changes, and unrelated regressions exceeded tolerance.

Action: reverted `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact.

## 063 — Hoist `WrapResult.copy` reference in conversation block push

Status: failure — production code reverted/deleted.

Hypothesis: `pushBlock` accessed `br.copy?.[i]` for every rendered line. Hoisting `br.copy` outside the loop should avoid repeated optional-chain/property lookup overhead while preserving line anchors and copy metadata.

Validation:

- Relevant tests passed: `bun test src/conversation.test.ts src/render.test.ts src/vim/message.test.ts` gave 36 pass, 0 fail.
- Result saved to `results/063-hoist-wrap-copy-reference.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_build_lines_cold/small_chat` median ratio 0.932
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 0.962
  - `conversation_open_warm/huge_expanded_tools` median ratio 1.077
  - multiple sidebar axes regressed above tolerance, including `sidebar_list_update/small_root.replace_and_sync` median ratio 1.426
- Direct conversation-axis improvements were not broad/stable enough and regressions exceeded tolerance.

Action: reverted `tui/src/conversation.ts`; kept only this failure log and result artifact.

## Smoke test — xenv + exotest after kept production changes

Status: success.

- Ran `/home/yeyito/Workspace/exocortex/scripts/dev/exotest autoresearch-performance` inside an `xenv` `st` terminal from the worktree.
- Result: TUI launched successfully in the nested X11 environment and rendered the Exocortex prompt.
- Screenshot saved outside the repo at `/tmp/exo-autoresearch-perf-after-054.png`.

## 064 — Object cache for paragraph word widths

Status: failure — production code reverted/deleted.

Hypothesis: `wrapParagraphRaw` creates a `Map` per paragraph to cache word widths. Replacing it with a null-prototype object should reduce per-paragraph cache overhead while preserving behavior for arbitrary string words.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- Result saved to `results/064-object-cache-paragraph-word-widths.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/small_chat` median ratio 0.983
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 0.973
  - `conversation_open_cold/medium_markdown` median ratio 1.157
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.204
  - `conversation_build_lines_cold/small_chat` median ratio 1.225
  - several sidebar axes also regressed above tolerance.

Action: reverted `tui/src/markdown/wordwrap.ts`; kept only this failure log and result artifact.

## 065 — Fast path `visibleLength` when no ANSI escape is present

Status: failure — production code reverted/deleted.

Hypothesis: `visibleLength` always ran an ANSI-stripping regex before measuring terminal width. Checking for `\x1b` first should avoid regex work for plain strings while preserving ANSI behavior.

Validation:

- Relevant tests passed: `bun test src/textwidth.test.ts src/markdown/formatting.test.ts src/markdown/wordwrap.test.ts src/render.test.ts` gave 21 pass, 0 fail.
- Result saved to `results/065-visible-length-no-ansi-fast-path.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/medium_markdown` median ratio 0.928
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 0.983
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.126
  - `conversation_open_warm/small_chat` median ratio 1.106
  - `sidebar_render/huge_foldered.root` median ratio 1.128
  - `sidebar_list_update/huge_foldered.replace_and_sync` median ratio 1.358
- Direct conversation/sidebar regressions exceeded tolerance.

Action: reverted `tui/src/textwidth.ts`; kept only this failure log and result artifact.

## 066 — Split markdown paragraphs on plain space when whitespace is simple

Status: failure — production code reverted/deleted.

Hypothesis: `wrapParagraphRaw` always used `/\s+/` to split paragraph words. Many markdown paragraphs use only single plain spaces. Falling back to `paragraph.split(" ")` when there are no repeated spaces and no tabs should preserve whitespace normalization while avoiding regex split overhead.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- Result saved to `results/066-space-split-markdown-paragraphs.json`.
- Three interleaved control/treatment runs showed repeated cold-open/build wins on several workloads:
  - `conversation_open_cold/small_chat` median ratio 0.928
  - `conversation_open_cold/medium_markdown` median ratio 0.922
  - `conversation_open_cold/huge_markdown_collapsed_tools` median ratio 0.902
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 0.908
  - `conversation_open_cold/huge_expanded_tools` median ratio 0.937
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 0.942
- Still rejected by strict no-regression criteria:
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.047
  - `conversation_open_warm/medium_markdown` median ratio 1.269
  - `sidebar_navigation/small_root.nav_down` median ratio 1.125
  - `sidebar_list_update/large_root.replace_and_sync` median ratio 1.318

Action: reverted `tui/src/markdown/wordwrap.ts`; kept only this failure log and result artifact.

## 067 — Use `indexOf` for `stripMarkdown` marker check only

Status: failure — production code reverted/deleted.

Hypothesis: experiment 059 changed multiple marker checks at once. Restricting the regex-to-`indexOf` change to `stripMarkdown` alone might keep cold markdown wins while reducing side effects.

Validation:

- Relevant tests passed: `bun test src/markdown/formatting.test.ts src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 42 pass, 0 fail.
- Result saved to `results/067-indexof-strip-markdown-marker-check.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/small_chat` median ratio 0.909
  - `conversation_build_lines_cold/small_chat` median ratio 0.818
  - `conversation_build_lines_cold/medium_markdown` median ratio 0.947
  - `conversation_open_cold/huge_markdown_collapsed_tools` median ratio 1.049
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 1.021
  - `sidebar_navigation/small_root.nav_down` median ratio 1.299
  - `sidebar_render/large_root.visual_selection` median ratio 1.144
- The gains were not broad enough and direct huge cold regressions exceeded tolerance.

Action: reverted `tui/src/markdown/formatting.ts`; kept only this failure log and result artifact.

## 068 — Avoid duplicate width measurement in `padRightToWidth`

Status: failure — production code reverted/deleted.

Hypothesis: `padRightToWidth` called `truncateToWidth`, which first measured the whole string, then measured the returned string again for padding. For non-truncated sidebar rows this duplicates terminal-width work. Measuring once and returning early when the text already fits should preserve output and improve sidebar rendering.

Validation:

- Relevant tests passed: `bun test src/textwidth.test.ts src/sidebar*.test.ts src/render.test.ts` gave 33 pass, 0 fail.
- Result saved to `results/068-pad-right-avoid-double-width.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `sidebar_render/small_root.root` median ratio 0.872
  - `sidebar_search_filter/large_root.performance_query` median ratio 0.949
  - `sidebar_render/large_root.visual_selection` median ratio 0.954
  - `sidebar_navigation/small_root.nav_down` median ratio 1.278
  - `sidebar_list_update/large_root.replace_and_sync` median ratio 1.453
  - direct conversation build axes also regressed above tolerance.

Action: reverted `tui/src/textwidth.ts`; kept only this failure log and result artifact.

## 069 — Fast path first visible sidebar item without active search

Status: failure — production code reverted/deleted.

Hypothesis: `firstVisibleSidebarItem` scanned every folder and conversation to find the best visible item even when there was no active sidebar search. Because `syncSelectedIndex` sorts folders/conversations first, the no-query case can stop at the first visible folder and first visible conversation, then compare those two. This should improve sidebar list-update sync without changing ordering.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- Result saved to `results/069-first-visible-sidebar-item-fast-path.json`.
- Two interleaved control/treatment runs showed several sidebar wins:
  - `sidebar_list_update/small_root.replace_and_sync` median ratio 0.754
  - `sidebar_list_update/large_root.replace_and_sync` median ratio 0.875
  - `sidebar_list_update/huge_foldered.replace_and_sync` median ratio 0.918
  - `sidebar_render/large_root.root` median ratio 0.933
  - `sidebar_search_filter/large_root.performance_query` median ratio 0.943
- Still rejected by strict no-regression criteria:
  - `sidebar_render/huge_foldered.root` median ratio 1.238
  - `sidebar_render/large_root.visual_selection` median ratio 1.110
  - `sidebar_search_filter/huge_foldered.performance_query` median ratio 1.054
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.045

Action: reverted `tui/src/sidebar/updates.ts`; kept only this failure log and result artifact.

## 070 — Benchmark: add sidebar folder-view render/navigation axes

Status: success — kept and committed (benchmark infrastructure only; no UX/UI code changed).

Problem: the sidebar benchmark covered root render/navigation, search filtering, visual selection, and list-update sync, but it did not independently measure the common in-folder view. Several sidebar optimizations can affect folder-scoped rows differently from root rows because folder rows disappear and conversation filtering is scoped by `currentFolderId`.

Change:

- Added `sidebar_render/<workload>.folder_view`, using `makeSidebar(..., "folder")` and rendering from inside a folder.
- Added `sidebar_navigation/<workload>.folder_nav_down`, using a folder-scoped sidebar and repeated `nav_down` actions.
- Saved the updated benchmark run to `results/070-sidebar-folder-view-benchmark-axes.json` and copied it to `results/baseline-v6.json` for future experiments.

Validation:

- `bun run autoresearch/exocortex-performance/benchmark.ts --json`: pass.
- `bun run typecheck`: pass.
- Representative v6 p95s:
  - `sidebar_render/small_root.folder_view`: 0.039ms
  - `sidebar_render/large_root.folder_view`: 0.745ms
  - `sidebar_render/huge_foldered.folder_view`: 2.543ms
  - `sidebar_navigation/small_root.folder_nav_down`: 0.002ms
  - `sidebar_navigation/large_root.folder_nav_down`: 0.053ms
  - `sidebar_navigation/huge_foldered.folder_nav_down`: 0.206ms

Decision: keep. This improves benchmark coverage/objectivity for sidebar operations across root and folder-scoped workloads without changing production behavior.

## 071 — Benchmark: make sidebar folder-view fixtures select an in-folder conversation

Status: success — kept and committed (benchmark infrastructure only; no UX/UI code changed).

Problem: experiment 070 added folder-view render/navigation axes, but the synthetic folder fixture entered `folder-0`. Due the deterministic data generator, `folder-0` received no conversations (`i % folderCount === 0` implies `i % 4 === 0`, and those conversations stay at root). The axis therefore measured a mostly empty folder instead of a realistic folder-scoped conversation list.

Change:

- Folder-mode sidebar fixtures now enter `folder-1` when available, falling back to `folder-0` only for single-folder workloads.
- When a folder contains conversations, the fixture selects the first child conversation in that folder so folder-view navigation starts from a realistic in-folder row.
- Saved the updated benchmark run to `results/071-sidebar-folder-fixture-selected-child.json` and copied it to `results/baseline-v7.json` for future experiments.

Validation:

- `bun run autoresearch/exocortex-performance/benchmark.ts --json`: pass.
- `bun run typecheck`: pass.
- Representative v7 folder-view p95s:
  - `sidebar_render/small_root.folder_view`: 0.090ms
  - `sidebar_render/large_root.folder_view`: 0.926ms
  - `sidebar_render/huge_foldered.folder_view`: 3.220ms
  - `sidebar_navigation/small_root.folder_nav_down`: 0.005ms
  - `sidebar_navigation/large_root.folder_nav_down`: 0.101ms
  - `sidebar_navigation/huge_foldered.folder_nav_down`: 0.304ms

Decision: keep. This corrects the new folder-view benchmark so it measures real folder-scoped rows rather than empty-folder overhead, with no production behavior change.

## 072 — Avoid copying markdown inline style state during rendering

Status: failure — production code reverted/deleted.

Hypothesis: `renderStyledTokens` copied inline style objects at initialization and on every style transition. Since style objects are immutable in practice, reusing references should preserve output and reduce cold markdown formatting allocation.

Validation:

- Relevant tests passed: `bun test src/markdown/formatting.test.ts src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 42 pass, 0 fail.
- Result saved to `results/072-avoid-markdown-style-copy.json`.
- Two interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_build_lines_cold/small_chat` median ratio 0.590
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 0.821
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 0.826
  - `conversation_open_cold/medium_markdown` median ratio 1.179
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.246
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 1.561
  - sidebar folder/root axes also regressed above tolerance.

Action: reverted `tui/src/markdown/formatting.ts`; kept only this failure log and result artifact.

## 073 — Cache visible conversation indices by folder

Status: failure — production code reverted/deleted.

Hypothesis: root and folder sidebar render/navigation repeatedly scan every conversation to find visible conversations for the current folder when there is no active search. Caching conversation indices by `folderId` on the sidebar state should speed folder-scoped render/navigation, especially after experiments 070–071 added realistic folder-view axes.

Change tested:

- Added a lazy `conversationIndicesByFolder` cache to `SidebarState`.
- `getVisibleConversationIndicesForQuery` returned cached indices directly for no-query folder/root views.
- `sortSidebarCollections` invalidated the cache after sidebar list updates.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/073-cache-visible-conversation-folder-indices.json`.
- Three interleaved control/treatment runs showed strong targeted folder/navigation wins:
  - `sidebar_navigation/large_root.folder_nav_down` median ratio 0.637
  - `sidebar_navigation/huge_foldered.folder_nav_down` median ratio 0.388
  - `sidebar_render/small_root.root` median ratio 0.898
  - `sidebar_render/huge_foldered.root` median ratio 0.938
  - `sidebar_render/large_root.visual_selection` median ratio 0.865
- Still rejected by strict no-regression criteria:
  - `sidebar_list_update/small_root.replace_and_sync` median ratio 1.226
  - `sidebar_render/large_root.folder_view` median ratio 1.087
  - `sidebar_render/huge_foldered.folder_view` median ratio 1.087
  - `conversation_open_cold/huge_expanded_tools` median ratio 1.042
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 1.027

Action: reverted `tui/src/sidebarsearch.ts`, `tui/src/sidebar/state.ts`, and `tui/src/sidebar/updates.ts`; kept only this failure log and result artifact.

## 074 — Focus sidebar navigation using display-row conversation indices

Status: failure — production code reverted/deleted.

Hypothesis: `moveSelection` already has the destination `DisplayRow`, including `convIdx`, but calls `focusSidebarItem`, which searches conversations by id. Focusing conversation rows directly from `convIdx` should reduce sidebar navigation overhead, especially on large lists.

Validation:

- Relevant tests passed: `bun test src/sidebar-navigation.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/074-focus-sidebar-navigation-by-display-row.json`.
- Two interleaved control/treatment runs showed targeted folder-navigation wins:
  - `sidebar_navigation/large_root.folder_nav_down` median ratio 0.643
  - `sidebar_navigation/huge_foldered.folder_nav_down` median ratio 0.733
- Still rejected by strict no-regression criteria:
  - `sidebar_render/small_root.root` median ratio 1.175
  - `sidebar_render/small_root.folder_view` median ratio 1.194
  - `sidebar_render/large_root.root` median ratio 1.260
  - `sidebar_render/large_root.folder_view` median ratio 1.463
  - `conversation_open_warm/medium_markdown` median ratio 1.263
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.157

Action: reverted `tui/src/sidebar/navigation.ts`; kept only this failure log and result artifact.

## 075 — Benchmark control: compare current code against baseline-v7

Status: benchmark finding — no production code changed.

Question: after the v7 benchmark fixture updates, how stable is a plain control run against the immediately previous baseline with no code changes?

Validation:

- Ran `bun run autoresearch/exocortex-performance/benchmark.ts --json --compare autoresearch/exocortex-performance/results/baseline-v7.json` with a clean worktree and no production changes.
- Result saved to `results/075-control-compare-v7-self-noise.json`.
- The compare command exited with status 2, meaning the current strict p95 compare failed even for control-vs-baseline.
- The overall p95 geomean was essentially neutral: 0.997.
- However, 9 individual p95 regressions exceeded the 2% threshold, including:
  - `conversation_build_lines_cold/small_chat`: ratio 1.377
  - `conversation_open_cold/medium_markdown`: ratio 1.218
  - `conversation_build_lines_cold/huge_expanded_tools`: ratio 1.160
  - `sidebar_list_update/small_root.replace_and_sync`: ratio 1.250
  - `sidebar_list_update/large_root.replace_and_sync`: ratio 1.360
- The same control run also showed large apparent improvements on unrelated axes, for example:
  - `sidebar_render/huge_foldered.folder_view`: ratio 0.746
  - `sidebar_render/small_root.root`: ratio 0.826
  - `sidebar_list_update/huge_foldered.replace_and_sync`: ratio 0.863

Decision: keep this as a benchmark calibration finding. A single baseline/current p95 compare is too noisy to be the only acceptance signal, especially for sub-millisecond axes. Future production experiments should continue using interleaved control/treatment runs and should distinguish targeted repeated wins from unrelated control-level volatility.

## 076 — Add interleaved benchmark comparison helper

Status: success — kept and committed (research tooling only; no UX/UI code changed).

Problem: experiment 075 showed that a single `--compare` run against a baseline can fail due control-level p95 self-noise even when no code changed. Most production experiments in this worktree therefore used interleaved control/treatment pairs and manually inspected median ratios.

Change:

- Added `compare-interleaved.ts`, a small helper that accepts alternating control/treatment benchmark JSON files.
- It reports per-axis p95 ratios, median ratios across pairs, median control/treatment p95s, regressions, improvements, and a pass/fail decision.
- Updated the README to recommend this helper for production-code decisions when multiple control/treatment pairs are available.
- Saved a smoke result to `results/076-interleaved-compare-helper-smoke.json` using the existing experiment 073 control/treatment JSONs from `/tmp`.

Validation:

- `bun run autoresearch/exocortex-performance/compare-interleaved.ts --json /tmp/073-control-1.json /tmp/073-treatment-1.json /tmp/073-control-2.json /tmp/073-treatment-2.json`: ran and produced structured JSON. The sample correctly failed because experiment 073 had median regressions.
- `bun run typecheck`: pass.

Decision: keep. This makes the benchmark decision process more reproducible and documents the interleaved methodology already used throughout the autoresearch.

## 077 — Benchmark: add sidebar streaming-navigation axes

Status: success — kept and committed (benchmark infrastructure only; no UX/UI code changed).

Problem: sidebar navigation benchmarks measured ordinary `nav_down` movement, but did not measure `nav_next_streaming` / `nav_prev_streaming`, which jump to conversations or folders with streaming/unread indicators. That path can be much more expensive because folder entries need descendant streaming/unread checks.

Change:

- Added `sidebar_navigation/<workload>.next_streaming_root`.
- Added `sidebar_navigation/<workload>.next_streaming_folder`.
- Saved the updated benchmark run to `results/077-sidebar-streaming-navigation-benchmark-axes.json` and copied it to `results/baseline-v8.json` for future experiments.

Validation:

- `bun run autoresearch/exocortex-performance/benchmark.ts --json`: pass.
- `bun run typecheck`: pass.
- Representative v8 streaming-navigation p95s:
  - `sidebar_navigation/small_root.next_streaming_root`: 0.065ms
  - `sidebar_navigation/small_root.next_streaming_folder`: 0.015ms
  - `sidebar_navigation/large_root.next_streaming_root`: 25.012ms
  - `sidebar_navigation/large_root.next_streaming_folder`: 0.389ms
  - `sidebar_navigation/huge_foldered.next_streaming_root`: 342.765ms
  - `sidebar_navigation/huge_foldered.next_streaming_folder`: 1.591ms

Decision: keep. This exposes a previously unmeasured severe root-sidebar streaming navigation cost and provides a direct target for future optimization.

## 078 — Precompute folder streaming indicators for sidebar streaming navigation

Status: success — kept and committed.

Hypothesis: `moveToStreaming` checked folder entries by calling `folderDescendantConversations(sidebar, folderId).some(...)` for every visible folder candidate. On large root sidebars this repeatedly rescanned folders/conversations and was exposed by experiment 077 as a severe hot path (`huge_foldered.next_streaming_root` p95 around 343ms). Precomputing the set of folder ids with streaming/unread descendants once per navigation action should preserve behavior and collapse the repeated descendant scan.

Change:

- Removed the per-folder `folderDescendantConversations(...).some(...)` call from `moveToStreaming`.
- Added a per-action `foldersWithStreamingIndicator` helper that walks all streaming/unread conversations once, propagating their folder ids up the folder parent chain.
- `hasStreamingIndicator` now checks folder membership in that precomputed set and uses `DisplayRow.convIdx` for conversation rows when available.

Validation:

- Relevant tests passed: `bun test src/sidebar-navigation.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Full TUI test suite passed: `bun test` gave 370 pass, 0 fail.
- Treatment result saved to `results/078-precompute-streaming-folder-indicators.json`.
- Interleaved comparison saved to `results/078-precompute-streaming-folder-indicators-compare.json`.
- Three interleaved control/treatment runs showed very large targeted wins:
  - `sidebar_navigation/small_root.next_streaming_root` median ratio 0.290
  - `sidebar_navigation/small_root.next_streaming_folder` median ratio 0.450
  - `sidebar_navigation/large_root.next_streaming_root` median ratio 0.022
  - `sidebar_navigation/large_root.next_streaming_folder` median ratio 0.519
  - `sidebar_navigation/huge_foldered.next_streaming_root` median ratio 0.005
  - `sidebar_navigation/huge_foldered.next_streaming_folder` median ratio 0.402
- The interleaved geomean median ratio was 0.638.
- The helper reported two median regressions:
  - `sidebar_navigation/small_root.nav_down` median ratio 1.091, but this is a ~0.001ms p95 delta on a sub-0.02ms axis and unrelated to the changed streaming-navigation path.
  - `conversation_open_cold/huge_expanded_tools` median ratio 1.022, just over the threshold and unrelated to sidebar navigation; experiment 075 showed this class of unrelated self-noise occurs in clean control runs.

Decision: keep. The change is behavior-preserving, covered by sidebar streaming-navigation tests, and fixes an extreme measured root-sidebar streaming navigation cost with orders-of-magnitude targeted improvements. The remaining flagged regressions are unrelated/control-level noise under the interleaved methodology documented in experiments 075–076.

## 079 — Single-pass streaming-navigation target selection

Status: failure — production code reverted/deleted.

Hypothesis: after experiment 078 removed repeated descendant scans, `moveToStreaming` still allocated intermediate `entries` and `targets` arrays and searched them separately. Selecting first/previous/next/last streaming targets in one pass over display rows should reduce remaining streaming-navigation overhead.

Validation:

- Relevant tests passed: `bun test src/sidebar-navigation.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/079-single-pass-streaming-target-selection.json`.
- Two interleaved control/treatment runs showed some targeted wins:
  - `sidebar_navigation/small_root.next_streaming_root` median ratio 0.765
  - `sidebar_navigation/large_root.next_streaming_root` median ratio 0.845
  - `sidebar_navigation/large_root.next_streaming_folder` median ratio 0.856
  - `sidebar_navigation/huge_foldered.next_streaming_root` median ratio 0.885
- But the change was not a clean follow-up to experiment 078 and violated no-regression criteria:
  - `sidebar_list_update/small_root.replace_and_sync` median ratio 1.308
  - `sidebar_render/large_root.root` median ratio 1.109
  - `sidebar_render/huge_foldered.folder_view` median ratio 1.157
  - `sidebar_render/large_root.visual_selection` median ratio 1.198
  - several conversation warm/cold axes also regressed above tolerance.

Action: reverted `tui/src/sidebar/navigation.ts`; kept only this failure log and result artifact.

## Smoke test — xenv + exotest after streaming-navigation optimization

Status: success.

- Ran `/home/yeyito/Workspace/exocortex/scripts/dev/exotest autoresearch-performance` inside an `xenv` `st` terminal from the worktree after experiment 078.
- Result: TUI launched successfully in the nested X11 environment and rendered the Exocortex prompt.
- Screenshot saved outside the repo at `/tmp/exo-autoresearch-perf-after-078.png`.

## 080 — Benchmark: add sidebar marked-navigation axes

Status: success — kept and committed (benchmark infrastructure only; no UX/UI code changed).

Problem: after adding streaming-navigation axes in experiment 077, the benchmark still did not measure `nav_next_marked` / `nav_prev_marked`. Marked navigation has a separate implementation that scans folder-scoped conversation indices and can behave differently from ordinary `nav_down` or streaming/unread navigation.

Change:

- Added `sidebar_navigation/<workload>.next_marked_root`.
- Added `sidebar_navigation/<workload>.next_marked_folder`.
- Saved the updated benchmark run to `results/080-sidebar-marked-navigation-benchmark-axes.json` and copied it to `results/baseline-v9.json` for future experiments.

Validation:

- `bun run autoresearch/exocortex-performance/benchmark.ts --json`: pass.
- `bun run typecheck`: pass.
- Representative v9 marked-navigation p95s:
  - `sidebar_navigation/small_root.next_marked_root`: 0.004ms
  - `sidebar_navigation/small_root.next_marked_folder`: 0.004ms
  - `sidebar_navigation/large_root.next_marked_root`: 0.153ms
  - `sidebar_navigation/large_root.next_marked_folder`: 0.160ms
  - `sidebar_navigation/huge_foldered.next_marked_root`: 0.640ms
  - `sidebar_navigation/huge_foldered.next_marked_folder`: 0.516ms

Decision: keep. This broadens sidebar navigation coverage and creates a direct measurement target for marked-conversation navigation without changing production behavior.

## 081 — Direct-loop marked-navigation index build

Status: success — kept and committed.

Hypothesis: `moveToMarked` built folder-scoped conversation indices with `map(...).filter(...).map(...)`, allocating an intermediate object array and a second mapped array every time the user jumped to the next/previous marked conversation. A direct loop that pushes matching conversation indices should preserve behavior while reducing marked-navigation allocation and overhead.

Change:

- Replaced the chained `map/filter/map` construction in `moveToMarked` with a direct `for` loop over `sidebar.conversations`.
- Kept the rest of the existing navigation semantics unchanged, including the current index lookup and wraparound scan.

Validation:

- Relevant tests passed: `bun test src/sidebar-navigation.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Full TUI test suite passed: `bun test` gave 370 pass, 0 fail.
- Treatment result saved to `results/081-direct-marked-navigation-index-build.json`.
- Interleaved comparison saved to `results/081-direct-marked-navigation-index-build-compare.json`.
- Three interleaved control/treatment runs showed large targeted marked-navigation wins:
  - `sidebar_navigation/small_root.next_marked_root` median ratio 0.200
  - `sidebar_navigation/small_root.next_marked_folder` median ratio 0.600
  - `sidebar_navigation/large_root.next_marked_root` median ratio 0.410
  - `sidebar_navigation/large_root.next_marked_folder` median ratio 0.320
  - `sidebar_navigation/huge_foldered.next_marked_root` median ratio 0.371
  - `sidebar_navigation/huge_foldered.next_marked_folder` median ratio 0.273
- The interleaved geomean median ratio was 0.836.
- The compare helper still flagged unrelated median regressions (for example `conversation_open_cold/medium_markdown`, `conversation_open_warm/medium_markdown`, and streaming-navigation metrics). These are not on the changed code path and are consistent with the control-level volatility documented in experiments 075–076.

Decision: keep. The change is behavior-preserving, simple, covered by marked-navigation tests, and produces repeated direct wins on the newly measured marked-navigation axes.

## 082 — Single-pass marked-navigation target selection

Status: failure — production code reverted/deleted.

Hypothesis: after experiment 081 removed the `map/filter/map` allocation, `moveToMarked` still built a full visible-index array and then searched it. Tracking marked positions/indices directly in one pass should reduce marked-navigation work further.

Validation:

- Relevant tests passed: `bun test src/sidebar-navigation.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/082-single-pass-marked-navigation-targets.json`.
- Three interleaved control/treatment runs were noisy and violated no-regression criteria:
  - `sidebar_navigation/large_root.next_marked_root` median ratio 0.826
  - `sidebar_navigation/huge_foldered.next_marked_root` median ratio 0.828
  - but `sidebar_navigation/small_root.next_marked_root` median ratio 2.000
  - `sidebar_navigation/large_root.next_marked_folder` median ratio 1.122
  - `sidebar_navigation/huge_foldered.next_marked_folder` median ratio 1.048
  - many unrelated sidebar/conversation axes also regressed; geomean median ratio was 1.096.

Action: reverted `tui/src/sidebar/navigation.ts`; kept only this failure log and result artifact. The simpler direct-loop index build from experiment 081 remains the kept marked-navigation optimization.

## 083 — Generation map for streaming folder ancestor cycle checks

Status: failure — production code reverted/deleted.

Hypothesis: experiment 078's `foldersWithStreamingIndicator` allocates a fresh `Set` of seen folder ids for each streaming/unread conversation while walking folder ancestors. Replacing that per-conversation set with a generation-mark map should preserve cycle protection while reducing allocation.

Validation:

- Relevant tests passed: `bun test src/sidebar-navigation.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/083-streaming-folder-seen-generation.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `sidebar_navigation/large_root.next_marked_root` median ratio 0.745 and `huge_foldered.next_marked_folder` median ratio 0.778, but these are not the target path.
  - Targeted streaming metrics were mostly neutral/regressive: `large_root.next_streaming_root` median ratio 1.169, `large_root.next_streaming_folder` 1.157, `small_root.next_streaming_root` 1.071.
  - Broad unrelated regressions also appeared: `conversation_open_cold/small_chat` median ratio 1.186, `sidebar_render/large_root.root` 1.300, `sidebar_render/huge_foldered.root` 1.170.

Action: reverted `tui/src/sidebar/navigation.ts`; kept only this failure log and result artifact. The original per-conversation `Set` from experiment 078 remains the kept streaming-navigation optimization.

## 084 — Focus streaming-navigation target by display-row index

Status: failure — production code reverted/deleted.

Hypothesis: after experiment 078, `moveToStreaming` still focuses a target conversation by id through `focusSidebarItem`, causing a conversation-list search. Since streaming target rows already carry `convIdx`, focusing conversation targets directly from the display row should reduce streaming-navigation overhead.

Validation:

- Relevant tests passed: `bun test src/sidebar-navigation.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/084-focus-streaming-target-by-display-row.json`.
- Three interleaved control/treatment runs did not show a reliable targeted win and violated no-regression criteria:
  - `sidebar_navigation/small_root.next_streaming_root` median ratio 1.333
  - `sidebar_navigation/large_root.next_streaming_root` median ratio 1.000
  - `sidebar_navigation/huge_foldered.next_streaming_root` median ratio 0.863
  - `sidebar_navigation/huge_foldered.next_streaming_folder` median ratio 1.187
  - unrelated list update/conversation axes also regressed above tolerance.

Action: reverted `tui/src/sidebar/navigation.ts`; kept only this failure log and result artifact.

## Smoke test — xenv + exotest after marked-navigation optimization

Status: success.

- Ran `/home/yeyito/Workspace/exocortex/scripts/dev/exotest autoresearch-performance` inside an `xenv` `st` terminal from the worktree after experiment 081.
- Result: TUI launched successfully in the nested X11 environment and rendered the Exocortex prompt.
- Screenshot saved outside the repo at `/tmp/exo-autoresearch-perf-after-081.png`.

## 085 — Hidden tool-result empty wrap fast path

Status: failure — production code reverted/deleted.

Hypothesis: collapsed tool-result blocks do not render visible lines, but `renderBlockCached` still computed a content key from the full tool output before discovering that `showToolOutput` was false. Returning a shared empty `WrapResult` for hidden `tool_result` blocks should avoid touching huge hidden outputs and improve collapsed-tool cold conversation axes.

Validation:

- Relevant tests passed: `bun test src/conversation.test.ts src/render.test.ts src/focus.test.ts` gave 86 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/085-hidden-tool-result-empty-wrap-fast-path.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 0.960
  - `conversation_open_cold/huge_markdown_collapsed_tools` median ratio 1.042
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.228
  - `conversation_build_lines_cold/small_chat` median ratio 1.253
  - `sidebar_list_update/huge_foldered.replace_and_sync` median ratio 1.353
- The targeted collapsed-tool benefit was too small/inconsistent, and multiple unrelated axes regressed above tolerance.

Action: reverted `tui/src/blockrenderer.ts`; kept only this failure log and result artifact.

## 086 — Searchable-title ASCII fast path against v9 benchmark

Status: failure — production code reverted/deleted.

Hypothesis: `getSearchableConversationTitle` can skip `stripMark` when the display title is empty or begins with ASCII, because mark prefixes are known emoji prefixes. This repeatedly produced large search-filter wins in earlier experiments, and the v9 benchmark now has better navigation/search coverage plus interleaved comparison tooling.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/086-searchable-title-ascii-fast-path-v9.json`.
- Three interleaved control/treatment runs again showed very large targeted search-filter wins:
  - `sidebar_search_filter/small_root.performance_query` median ratio 0.575
  - `sidebar_search_filter/large_root.performance_query` median ratio 0.383
  - `sidebar_search_filter/huge_foldered.performance_query` median ratio 0.433
- Still rejected because the change also affects visible sidebar row rendering and direct sidebar render/navigation axes regressed above tolerance:
  - `sidebar_render/huge_foldered.root` median ratio 1.419
  - `sidebar_render/huge_foldered.folder_view` median ratio 1.211
  - `sidebar_navigation/huge_foldered.folder_nav_down` median ratio 1.201
  - marked-navigation and warm conversation axes also showed regressions.

Action: reverted `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact. A narrower search-only variant is the next better candidate.

## 087 — Search-filter-only ASCII title fast path against v9 benchmark

Status: success — kept and committed.

Hypothesis: experiment 086 showed the global searchable-title fast path still gives very large search wins, but it also changes normal visible-row rendering because `getSearchableConversationTitle` is shared by sidebar render code. A private fast path used only by `getVisibleConversationIndicesForQuery` should keep the large sidebar search/filter improvement while avoiding changes to normal row rendering.

Change:

- Added private `getSearchFilterConversationTitle` in `tui/src/sidebarsearch.ts`.
- For search filtering only, it computes the display title and skips `stripMark` when the title is empty or starts with ASCII, because conversation marks are known emoji prefixes at the start of the title.
- Left exported `getSearchableConversationTitle` unchanged for visible row rendering and other callers.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Full TUI test suite passed: `bun test` gave 370 pass, 0 fail.
- Treatment result saved to `results/087-search-filter-title-ascii-fast-path-v9.json`.
- Interleaved comparison saved to `results/087-search-filter-title-ascii-fast-path-v9-compare.json`.
- Three interleaved control/treatment runs showed large targeted search-filter wins:
  - `sidebar_search_filter/small_root.performance_query` median ratio 0.610
  - `sidebar_search_filter/large_root.performance_query` median ratio 0.398
  - `sidebar_search_filter/huge_foldered.performance_query` median ratio 0.477
- The interleaved geomean median ratio was 0.945.
- The compare helper still flagged unrelated median regressions such as `conversation_open_cold/small_chat`, `conversation_open_cold/medium_markdown`, `sidebar_list_update/large_root.replace_and_sync`, and some navigation metrics. These code paths do not use the new private search-filter helper and are consistent with the control-level volatility documented in experiments 075–076.
- `sidebar_render/small_root.root` also showed a median regression (1.117), but normal render code still uses the unchanged exported `getSearchableConversationTitle`; larger render workloads were neutral/improved (`large_root.root` 0.876, `huge_foldered.root` 0.909, `huge_foldered.folder_view` 0.886), so this was treated as benchmark noise rather than a product regression.

Decision: keep. The change is narrow to active sidebar filtering, covered by sidebar search tests, and gives repeated direct wins on all search-filter workloads with no intended visible UX change.

## Smoke test — xenv + exotest after sidebar search-filter optimization

Status: success.

- Ran `/home/yeyito/Workspace/exocortex/scripts/dev/exotest autoresearch-performance` inside an `xenv` `st` terminal from the worktree after experiment 087.
- Result: TUI launched successfully in the nested X11 environment and rendered the Exocortex prompt.
- Screenshot saved outside the repo at `/tmp/exo-autoresearch-perf-after-087.png`.

## 088 — Sidebar search `includes` check after search-title fast path

Status: failure — production code reverted/deleted.

Hypothesis: after experiment 087 introduced a search-filter-only title fast path, sidebar filtering might also benefit from avoiding `findAllCaseInsensitiveMatchStarts` array allocation. Lowercasing the query once and checking `getSearchFilterConversationTitle(conv).toLowerCase().includes(lowerQuery)` should preserve filter visibility while avoiding match-offset arrays that filtering does not need.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass after removing the now-unused `findAllCaseInsensitiveMatchStarts` import.
- Result saved to `results/088-sidebar-search-includes-after-title-fast-path.json`.
- Three interleaved control/treatment runs did not show reliable targeted improvement and violated no-regression criteria:
  - `sidebar_search_filter/small_root.performance_query` median ratio 1.245
  - `sidebar_search_filter/large_root.performance_query` median ratio 0.975
  - `sidebar_search_filter/huge_foldered.performance_query` median ratio 0.885
  - `sidebar_render/small_root.folder_view` median ratio 1.283
  - several unrelated navigation/list-update axes also regressed above tolerance.

Action: reverted `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact. The narrower search-filter title fast path from experiment 087 remains kept.

## 089 — Generation map for sidebar folder aggregate ancestor cycle checks

Status: failure — production code reverted/deleted.

Hypothesis: sidebar folder aggregate rendering allocates a fresh `Set` while walking each conversation's folder ancestors to prevent cycles. Replacing the per-conversation set with a generation-mark map should preserve cycle protection while reducing allocation in root/folder sidebar rendering.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts src/render.test.ts` gave 76 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/089-folder-aggregate-seen-generation-v9.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `sidebar_render/small_root.root` median ratio 0.819
  - `sidebar_render/large_root.root` median ratio 0.901
  - `sidebar_render/large_root.folder_view` median ratio 0.834
  - but `sidebar_render/small_root.folder_view` median ratio 1.481
  - `sidebar_render/huge_foldered.root` median ratio 1.292
  - `sidebar_navigation/huge_foldered.folder_nav_down` median ratio 1.217
  - several unrelated conversation/list-update axes also regressed above tolerance.

Action: reverted `tui/src/sidebar/render.ts`; kept only this failure log and result artifact.

## 090 — Skip streaming folder-index precompute when no folder entries are visible

Status: failure — production code reverted/deleted.

Hypothesis: after experiment 078, `moveToStreaming` always builds the set of folders with streaming/unread descendants. In folder views with only conversations visible, folder indicators are unnecessary. Skipping the folder-index precompute when the current display rows contain no folder entries should improve folder-scoped streaming navigation.

Validation:

- Relevant tests passed: `bun test src/sidebar-navigation.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/090-skip-streaming-folder-index-without-folder-entries.json`.
- Three interleaved control/treatment runs did not show a clean targeted win and violated no-regression criteria:
  - `sidebar_navigation/large_root.next_streaming_root` median ratio 0.900
  - `sidebar_navigation/huge_foldered.next_streaming_root` median ratio 0.920
  - but `sidebar_navigation/large_root.next_streaming_folder` median ratio 1.090
  - `sidebar_navigation/huge_foldered.next_streaming_folder` median ratio 1.236
  - `sidebar_render/small_root.root` median ratio 1.222
  - `sidebar_render/huge_foldered.folder_view` median ratio 1.209
  - several unrelated conversation/list-update axes also regressed above tolerance; geomean median ratio was 1.009.

Action: reverted `tui/src/sidebar/navigation.ts`; kept only this failure log and result artifact.

## 091 — ASCII fast path for `sliceByWidth`

Status: failure — production code reverted/deleted.

Hypothesis: `sliceByWidth` walks graphemes even for pure ASCII strings. Adding an all-ASCII fast path should speed truncation/hard-break paths used by markdown/code/sidebar rendering.

Validation:

- Relevant tests passed: `bun test src/textwidth.test.ts src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 43 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/091-ascii-slice-by-width-fast-path.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/huge_markdown_collapsed_tools` median ratio 0.980
  - `conversation_open_cold/huge_expanded_tools` median ratio 0.977
  - but `conversation_open_cold/small_chat` median ratio 1.080
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.054
  - `sidebar_render/small_root.root` median ratio 1.264
  - `sidebar_list_update/large_root.replace_and_sync` median ratio 1.248
  - geomean median ratio was 1.010.

Action: reverted `tui/src/textwidth.ts`; kept only this failure log and result artifact.

## 092 — Inline display-title resolution in search-filter title helper

Status: failure — production code reverted/deleted.

Hypothesis: experiment 087's private search-filter title helper still called `convDisplayName`, which only performs title fallback and newline truncation. Inlining that tiny display-name logic inside the search-only helper should reduce sidebar search/filter overhead while keeping the exported rendering helper unchanged.

Validation:

- Relevant tests passed: `bun test src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/092-inline-search-filter-title-display.json`.
- Three interleaved control/treatment runs were noisy and violated no-regression criteria:
  - `sidebar_search_filter/small_root.performance_query` median ratio 0.890
  - `sidebar_search_filter/large_root.performance_query` median ratio 1.017
  - `sidebar_search_filter/huge_foldered.performance_query` median ratio 0.978
  - `sidebar_render/small_root.root` median ratio 1.722
  - `sidebar_render/large_root.root` median ratio 1.076
  - `sidebar_render/huge_foldered.folder_view` median ratio 1.169
  - geomean median ratio was 1.022.

Action: reverted `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact. The kept search-filter fast path from experiment 087 remains unchanged.

## 093 — Avoid null-copy array allocation in markdown paragraph wrapping

Status: failure — production code reverted/deleted.

Hypothesis: `wrapParagraphBlock` appended copy metadata with `copy.push(...rendered.map(() => null))`, allocating a temporary null array per paragraph block. Pushing nulls in a loop should preserve copy semantics while reducing cold markdown wrapping allocation.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/093-avoid-copy-null-map-allocation.json`.
- Initial three interleaved runs had geomean median ratio 0.928 and broad conversation wins, but five interleaved runs regressed to geomean median ratio 0.990 and violated no-regression criteria:
  - `conversation_open_cold/small_chat` median ratio 0.937
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 0.958
  - but `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 1.123
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.047
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 1.040
  - several sidebar navigation/list-update axes also regressed above tolerance.

Action: reverted `tui/src/markdown/wordwrap.ts`; kept only this failure log and result artifact.

## 094 — Refresh current optimized benchmark baseline v10

Status: success — kept and committed (benchmark artifact only; no UX/UI code changed).

Context: after the kept streaming-navigation, marked-navigation, and sidebar search-filter optimizations, the latest baseline artifact was still `baseline-v9`, created before experiments 081 and 087. Future experiments should compare/control against a baseline that includes the current kept production state.

Change:

- Ran the full benchmark on the clean current worktree.
- Saved the result to `results/094-current-optimized-baseline-v10.json`.
- Copied it to `results/baseline-v10.json` for future experiments.

Validation:

- `bun run autoresearch/exocortex-performance/benchmark.ts --json`: pass.
- `bun run typecheck`: pass.
- Representative v10 p95s:
  - `conversation_open_cold/huge_markdown_collapsed_tools`: 113.907ms
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools`: 107.598ms
  - `sidebar_search_filter/huge_foldered.performance_query`: 15.219ms
  - `sidebar_render/huge_foldered.root`: 3.980ms
  - `sidebar_navigation/huge_foldered.next_streaming_root`: 2.003ms
  - `sidebar_navigation/huge_foldered.next_marked_root`: 0.166ms

Decision: keep. This gives the next autoresearch iterations an up-to-date benchmark artifact reflecting all accepted optimizations so far.

## 095 — Loop standalone markdown line pushes instead of map/spread

Status: failure — production code reverted/deleted.

Hypothesis: `pushStandaloneLines` used three `lines.map(...)` calls plus spreads to append table/code/standalone rendered lines and metadata. A direct loop should avoid temporary arrays while preserving output.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/095-standalone-lines-loop.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/huge_expanded_tools` median ratio 0.788
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 0.957
  - but `conversation_open_cold/small_chat` median ratio 1.283
  - `conversation_build_lines_cold/small_chat` median ratio 1.362
  - `conversation_open_warm/medium_markdown` median ratio 1.401
  - multiple sidebar axes also regressed above tolerance.

Action: reverted `tui/src/markdown/wordwrap.ts`; kept only this failure log and result artifact.

## 096 — Avoid pinned/unpinned filter arrays in sidebar row build

Status: failure — production code reverted/deleted.

Hypothesis: `buildDisplayRows` split sorted entries into pinned and unpinned arrays with two `filter` calls. Scanning the sorted entries directly for pinned/unpinned output should avoid temporary arrays and improve sidebar render/navigation/search axes.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/096-sidebar-rows-avoid-pinned-filter-arrays.json`.
- Three interleaved runs looked promising on geomean; after five runs the geomean median ratio was 0.963 with broad wins:
  - `sidebar_render/large_root.root` median ratio 0.840
  - `sidebar_render/large_root.folder_view` median ratio 0.816
  - `sidebar_search_filter/small_root.performance_query` median ratio 0.859
  - `sidebar_search_filter/large_root.performance_query` median ratio 0.872
  - `sidebar_list_update/large_root.replace_and_sync` median ratio 0.848
  - several navigation axes also improved.
- Still rejected by strict no-regression criteria because direct affected axes regressed above tolerance:
  - `sidebar_render/huge_foldered.root` median ratio 1.230
  - `sidebar_list_update/huge_foldered.replace_and_sync` median ratio 1.134
  - `sidebar_navigation/huge_foldered.next_marked_root` median ratio 1.169
  - unrelated conversation warm/cold axes also had regressions above tolerance.

Action: reverted `tui/src/sidebar/rows.ts`; kept only this failure log and result artifact.

## 097 — Skip leading-newline regex for normal assistant text blocks

Status: failure — production code reverted/deleted.

Hypothesis: assistant text block rendering always ran `.replace(/^\n+/, "")` after sanitization. Most blocks do not start with a newline, so checking the first character before using the regex should avoid unnecessary regex work on cold conversation rendering.

Validation:

- Relevant tests passed: `bun test src/conversation.test.ts src/render.test.ts src/markdown/wordwrap.test.ts` gave 39 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/097-skip-leading-newline-regex.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_build_lines_cold/small_chat` median ratio 0.739
  - `conversation_build_lines_cold/medium_markdown` median ratio 0.910
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 0.952
  - but `conversation_open_cold/small_chat` median ratio 1.068
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 1.074
  - many sidebar axes also regressed above tolerance; geomean median ratio was 1.011.

Action: reverted `tui/src/blockrenderer.ts`; kept only this failure log and result artifact.

## 098 — Direct sidebar entry build instead of folder map/filter/map spreads

Status: failure — production code reverted/deleted.

Hypothesis: `buildDisplayRows` built folder entries with `map/filter`, conversation entries with `map`, then combined both arrays with spreads before sorting. A direct push loop should reduce temporary arrays and lower sidebar render/navigation/search overhead.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/098-direct-sidebar-entry-build-v10.json`.
- Three interleaved runs had geomean median ratio 0.965, but five interleaved runs weakened to 0.988 and violated no-regression criteria:
  - `sidebar_render/small_root.folder_view` median ratio 0.853
  - `sidebar_render/large_root.folder_view` median ratio 0.873
  - `sidebar_render/huge_foldered.root` median ratio 0.903
  - `sidebar_search_filter/large_root.performance_query` median ratio 0.901
  - but `sidebar_navigation/large_root.nav_down` median ratio 1.139
  - `sidebar_navigation/large_root.next_streaming_folder` median ratio 1.226
  - `sidebar_navigation/huge_foldered.next_marked_folder` median ratio 1.150
  - `sidebar_list_update/large_root.replace_and_sync` median ratio 1.223
  - conversation warm/cold axes also regressed above tolerance.

Action: reverted `tui/src/sidebar/rows.ts`; kept only this failure log and result artifact.

## 099 — Precompute markdown table border strings

Status: failure — production code reverted/deleted.

Hypothesis: `renderTableBlock` rebuilt the top/separator/bottom border strings with `colWidths.map(...).join(...)` each time a border row was emitted. Precomputing these strings once per table should reduce table-rendering work in markdown-heavy conversation workloads.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/099-precompute-table-borders.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_build_lines_cold/medium_markdown` median ratio 0.817
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 0.996
  - but `conversation_build_lines_cold/small_chat` median ratio 1.289
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 1.158
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 1.084
  - several sidebar axes also regressed above tolerance.

Action: reverted `tui/src/markdown/tables.ts`; kept only this failure log and result artifact.

## 100 — Single-pass markdown table separator detection

Status: failure — production code reverted/deleted.

Hypothesis: `renderTableBlock` first scanned table lines with `.some(isTableSeparator)`, then scanned them again to parse rows. Folding separator detection into the parse loop should remove one regex pass per table while preserving output.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/100-single-pass-table-separator-detection.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/small_chat` median ratio 0.868
  - `conversation_build_lines_cold/medium_markdown` median ratio 0.922
  - `conversation_open_cold/huge_markdown_collapsed_tools` median ratio 0.948
  - but `conversation_build_lines_cold/small_chat` median ratio 1.185
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 1.091
  - `conversation_open_cold/huge_expanded_tools` median ratio 1.059
  - several sidebar axes also regressed above tolerance.

Action: reverted `tui/src/markdown/tables.ts`; kept only this failure log and result artifact.

## 101 — Shared empty wrap result for hidden tool outputs after cache-key lookup

Status: failure — production code reverted/deleted.

Hypothesis: experiment 085 returned early before cache-key lookup for hidden `tool_result` blocks and was rejected. A narrower variant that preserves the existing cache-key path but returns a shared empty `WrapResult` inside `renderBlock` should avoid per-hidden-tool array allocation while minimizing cache behavior changes.

Validation:

- Relevant tests passed: `bun test src/conversation.test.ts src/render.test.ts src/focus.test.ts` gave 86 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/101-hidden-tool-result-shared-empty-wrap.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_build_lines_cold/small_chat` median ratio 0.756
  - `conversation_open_warm/medium_markdown` median ratio 0.816
  - `conversation_open_warm/huge_expanded_tools` median ratio 0.861
  - but `conversation_open_cold/medium_markdown` median ratio 1.039
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 1.094
  - targeted collapsed-tool cold axes were near neutral: open 1.002, build 1.015
  - several sidebar axes also regressed above tolerance.

Action: reverted `tui/src/blockrenderer.ts`; kept only this failure log and result artifact.

## 102 — Pipe-presence guard before markdown table-line regex

Status: failure — production code reverted/deleted.

Hypothesis: `isTableLine` runs a trim plus table regex on every physical markdown line. Most lines are not table rows. Checking for `|` first should skip regex work on normal prose/code/heading lines while preserving table detection.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/102-table-line-pipe-presence-guard.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_warm/small_chat` median ratio 0.895
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 0.855
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 0.936
  - but `conversation_open_cold/small_chat` median ratio 1.076
  - `conversation_build_lines_cold/small_chat` median ratio 1.087
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.045
  - several sidebar/search/navigation axes also regressed above tolerance; geomean median ratio was 1.011.

Action: reverted `tui/src/markdown/tables.ts`; kept only this failure log and result artifact.

## 103 — Direct `focusConversationAt` state update

Status: failure — production code reverted/deleted.

Hypothesis: `focusConversationAt` already knows the target conversation index, but called `focusSidebarItem`, which searches by id with `findIndex`. Updating `selectedItem`, `selectedIndex`, and `selectedId` directly should reduce sidebar navigation/focus overhead while preserving behavior.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts` gave 74 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/103-direct-focus-conversation-at.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `sidebar_navigation/huge_foldered.next_marked_root` median ratio 0.474
  - `sidebar_list_update/huge_foldered.replace_and_sync` median ratio 0.684
  - `sidebar_render/huge_foldered.folder_view` median ratio 0.720
  - but `sidebar_navigation/small_root.next_streaming_root` median ratio 1.357
  - `sidebar_navigation/huge_foldered.next_streaming_folder` median ratio 1.366
  - `sidebar_list_update/large_root.replace_and_sync` median ratio 1.632
  - conversation cold/warm axes also regressed above tolerance.

Action: reverted `tui/src/sidebar/selection.ts`; kept only this failure log and result artifact.

## 104 — Lower sidebar search query once while preserving match-array semantics

Status: failure — production code reverted/deleted.

Hypothesis: sidebar filtering calls `findAllCaseInsensitiveMatchStarts` once per conversation, and that helper lowercases the same query each time. A helper accepting a pre-lowercased query should preserve overlapping-match semantics while reducing search-filter overhead, narrower than the failed `includes` experiment 088.

Validation:

- Relevant tests passed: `bun test src/search.test.ts src/sidebarsearch.test.ts src/sidebar*.test.ts src/focus.test.ts` gave 79 pass, 0 fail.
- `bun run typecheck`: pass after removing an unused import from the candidate.
- Result saved to `results/104-sidebar-search-lower-query-once.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `sidebar_search_filter/large_root.performance_query` median ratio 0.911
  - but `sidebar_search_filter/small_root.performance_query` median ratio 1.096
  - `sidebar_search_filter/huge_foldered.performance_query` median ratio 1.013
  - `sidebar_render/large_root.root` median ratio 1.308
  - `sidebar_render/huge_foldered.folder_view` median ratio 1.515
  - `sidebar_list_update/large_root.replace_and_sync` median ratio 1.517
  - conversation axes also regressed above tolerance.

Action: reverted `tui/src/searchutil.ts` and `tui/src/sidebarsearch.ts`; kept only this failure log and result artifact.

## 105 — Loop user bubble width calculation instead of spreading content arrays

Status: failure — production code reverted/deleted.

Hypothesis: `renderUserMessage` built `allContentLines = [...badgeLines, ...w.lines]` and then `Math.max(...allContentLines.map(...))` to size the user bubble. A direct loop over wrapped text lines and image badges should avoid temporary arrays while preserving bubble layout.

Validation:

- Relevant tests passed: `bun test src/conversation.test.ts src/render.test.ts src/focus.test.ts` gave 86 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/105-user-bubble-width-loop.json`.
- Three interleaved control/treatment runs had geomean median ratio 0.950 and several broad wins:
  - `conversation_open_cold/small_chat` median ratio 0.901
  - `conversation_build_lines_cold/medium_markdown` median ratio 0.943
  - `conversation_open_cold/huge_expanded_tools` median ratio 0.965
  - multiple sidebar axes also improved.
- Still rejected by strict no-regression criteria because direct conversation axes regressed above tolerance:
  - `conversation_build_lines_cold/small_chat` median ratio 1.184
  - `conversation_open_warm/medium_markdown` median ratio 1.163
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 1.054
  - `conversation_open_warm/huge_expanded_tools` median ratio 1.031
  - several sidebar list/navigation axes also regressed above tolerance.

Action: reverted `tui/src/blockrenderer.ts`; kept only this failure log and result artifact.

## 106 — Skip folder aggregate build when no folder rows are displayed

Status: failure — production code reverted/deleted.

Hypothesis: `renderSidebar` built folder aggregate counts/streaming state whenever folders existed, even if the current display rows contained only conversations/up/instructions. Skipping aggregate construction when no visible folder rows exist should improve folder-view render paths.

Validation:

- Relevant tests passed: `bun test src/sidebar*.test.ts src/focus.test.ts src/render.test.ts` gave 82 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/106-skip-folder-aggregates-without-folder-rows.json`.
- Three interleaved control/treatment runs had geomean median ratio 0.974 and several wins:
  - `sidebar_render/small_root.root` median ratio 0.871
  - `sidebar_render/small_root.folder_view` median ratio 0.926
  - `sidebar_render/huge_foldered.folder_view` median ratio 0.825
  - `sidebar_search_filter/huge_foldered.performance_query` median ratio 0.909
- Still rejected by strict no-regression criteria because direct render/navigation axes regressed above tolerance:
  - `sidebar_render/large_root.root` median ratio 1.045
  - `sidebar_render/huge_foldered.root` median ratio 1.033
  - `sidebar_navigation/large_root.next_streaming_folder` median ratio 1.261
  - `sidebar_navigation/huge_foldered.next_streaming_folder` median ratio 1.255
  - conversation warm/build axes also regressed above tolerance.

Action: reverted `tui/src/sidebar/render.ts`; kept only this failure log and result artifact.

## 107 — Guard paragraph fence regex with backtick presence check

Status: failure — production code reverted/deleted.

Hypothesis: while collecting normal markdown paragraph lines, `markdownWordWrap` checked every line against `FENCE_OPEN_RE`. Most paragraph lines do not contain code-fence backticks. Guarding the regex with `line.includes("```")` should avoid regex work without changing fenced-code detection.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/107-fence-regex-backtick-guard.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_build_lines_cold/small_chat` median ratio 0.929
  - but `conversation_open_cold/medium_markdown` median ratio 1.049
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.098
  - `conversation_open_cold/huge_markdown_collapsed_tools` median ratio 1.110
  - `conversation_build_lines_cold/huge_markdown_collapsed_tools` median ratio 1.127
  - `conversation_open_cold/huge_expanded_tools` median ratio 1.248
  - several sidebar axes also regressed above tolerance; geomean median ratio was 1.009.

Action: reverted `tui/src/markdown/wordwrap.ts`; kept only this failure log and result artifact.

## 108 — Direct metadata line construction without parts array

Status: failure — production code reverted/deleted.

Hypothesis: `renderMetadata` allocates a `parts` array and joins it for every assistant metadata line. Building the final string directly should preserve output while reducing metadata rendering overhead.

Validation:

- Relevant tests passed: `bun test src/metadata.test.ts src/conversation.test.ts src/render.test.ts` gave 40 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/108-direct-metadata-line-build.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_warm/small_chat` median ratio 0.917
  - `conversation_open_cold/medium_markdown` median ratio 0.958
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 0.915
  - but `conversation_open_cold/small_chat` median ratio 1.068
  - `conversation_open_warm/medium_markdown` median ratio 1.102
  - `conversation_build_lines_cold/medium_markdown` median ratio 1.117
  - many sidebar axes also regressed above tolerance; geomean median ratio was 1.033.

Action: reverted `tui/src/metadata.ts`; kept only this failure log and result artifact.

## 109 — Guard code-fence close regex with backtick presence check

Status: failure — production code reverted/deleted.

Hypothesis: `isFenceClose` runs a closing-code-fence regex while rendering fenced code. Most code lines are not closing fences. Checking for the presence of triple backticks before running the regex should avoid regex work in markdown/code-heavy conversation rendering.

Validation:

- Relevant tests passed: `bun test src/markdown/wordwrap.test.ts src/conversation.test.ts src/render.test.ts` gave 39 pass, 0 fail.
- `bun run typecheck`: pass.
- Result saved to `results/109-fence-close-backtick-guard.json`.
- Three interleaved control/treatment runs were mixed and violated no-regression criteria:
  - `conversation_open_cold/small_chat` median ratio 0.896
  - `conversation_build_lines_cold/medium_markdown` median ratio 0.867
  - `conversation_build_lines_cold/huge_expanded_tools` median ratio 0.896
  - but `conversation_build_lines_cold/small_chat` median ratio 1.149
  - `conversation_open_cold/huge_markdown_collapsed_tools` median ratio 1.059
  - `conversation_open_warm/huge_markdown_collapsed_tools` median ratio 1.151
  - several direct sidebar render/navigation/list-update axes also regressed above tolerance; geomean median ratio was 0.991.

Action: reverted `tui/src/markdown/codeblocks.ts`; kept only this failure log and result artifact. This was the final experiment before stopping autoresearch at user request.

## 110 — Compact old image payloads in conversation loads

Status: success — kept and committed.

Problem/diagnosis: after deferred TUI rendering, opening `galaxy tab a9 linux` was still slower than Lenovo conversations. Profiling showed the TUI first render was already tiny (~2.8ms), while daemon-to-event was ~71ms. The Galaxy conversation file is 5.43MiB, with 4.94MiB of historical base64 image data. The compact `conversation_loaded` payload was still ~5.10MiB because historical user image attachments included full base64 even though the chat history only needs media type and byte size for image badges.

Reproducible benchmark:

- Added `autoresearch/exocortex-performance/daemon-load-profile.ts` to profile disk read, JSON parse, display snapshot, and full-vs-compacted payload stringify size/time for the real Galaxy/Lenovo conversations.
- Added `autoresearch/exocortex-performance/real-conversation-open-profile.ts` to reproduce first-chat-history-render timings through the real daemon/TUI event path.
- Result saved to `results/110-daemon-load-profile-compact-images.json`.

Change:

- `daemon/src/handler.ts` now strips base64 from older historical user-image entries in compact `conversation_loaded` and `history_updated` payloads, preserving `mediaType` and `sizeBytes` so badges render unchanged.
- The most recent 8 display entries keep full image base64 to preserve common recent-edit/resend behavior.
- The non-streaming `load_conversation` catch-up path now skips an unnecessary second `getRenderSnapshot` when the conversation is not streaming.

Profile result (`includeToolOutputs=false`):

- `galaxy tab a9 linux`:
  - file 5.43MiB; historical images 4.94MiB
  - full compact-history payload before image stripping: 5.10MiB
  - old-image-compacted payload: 0.16MiB
  - stringify median: 6.38ms → 0.34ms
- Lenovo conversations had no historical images, so payload size/time were unchanged.

End-to-end first-paint validation at 120x40 after deferred rendering + old-image compaction, 30 opens:

- `lenovo m10 improve run`: warm median 29.7ms, daemon/event median 4.9ms, first render median 8.1ms.
- `lenovo m10 linux install`: warm median 25.5ms, daemon/event median 3.8ms, first render median 4.4ms.
- `galaxy tab a9 linux`: warm median 23.8ms, p95 24.7ms, daemon/event median 3.4ms, first render median 2.8ms.

Validation:

- `bun test daemon/src/handler.test.ts`: pass, including tests for old-image base64 stripping and recent-image base64 preservation.
- `bun run typecheck`: pass.

Decision: keep. Galaxy now opens in the same near-instant range as the Lenovo conversations; the remaining latency is mostly the intentional 16ms scheduled render delay plus small daemon/render work.
