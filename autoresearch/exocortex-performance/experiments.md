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
