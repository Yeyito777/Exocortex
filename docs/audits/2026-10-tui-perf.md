# TUI rendering and input performance audit (October 2026)

Audit #2 of 4. Scope: the render loop and frame diffing, history line building
and its caches (markdown/word-wrap/block render, math text layout), scrolling and
history paging in long conversations, keypress-to-paint latency, streaming-delta
cost, the sidebar with thousands of conversations, the Tasks panel, memory growth
in long sessions and startup. Image rendering, conversation-open flicker, daemon
internals and the wire protocol belong to other audits.

## Method

All measurements use real conversations, copied read-only.

- `scripts/dev/bench-tui-render.ts DB CONV [--turns N] [--sidebar FILE] [--tasks N]`
  loads a conversation's display page from a read-only `SqliteConversationStore`
  into TUI state and times `render()` for: idle repaint, typing (idle and while a
  reply streams), streaming deltas, scrolling, history-cursor moves, Ctrl+O,
  turn completion (including the deferred-history walk that follows), the
  older-history loading row, and a from-scratch deferred walk. It counts stdout
  bytes per frame and heap growth. `--sidebar` replays a saved
  `conversations_list` event (the live list: 3,405 conversations, 31 folders).
- `scripts/dev/bench-tui-history-paging.ts DB CONV` scrolls up through a whole
  conversation, feeding every older page through the real
  `conversation_history_loaded` handler while scrolled up, and times the
  loading-row frame, the page apply and the following render.
- An end-to-end session in a nested X env (`dwm start`) with the owner's `st`,
  running the worktree TUI under `script --log-timing` against an instance daemon
  seeded from the live DB (151 real conversations including the big ones, 3,256
  title-only stubs, the real folders). Bytes and first-output latency per input
  event come from the timing log.

Conversations: `1791667824123-k14mhj` (Paramount: 975 entries, 7.5k blocks,
2.6k tool calls, 39k rendered rows when fully loaded) and `1784817195288-etaemx`
(OpenAI agentic chat: 6,021 entries, 112k blocks, 37k tool calls, 294k rows).
"Fully loaded" means the session has scrolled to the top (the TUI never unloads
pages) or has stayed open on a conversation for a long time. The host had a load
average of 15-20 throughout, so absolute timings are noisy; before/after pairs
were run back to back.

## Findings, ranked by user impact

| # | Finding | Status | Before (main) | After |
|---|---------|--------|--------|-------|
| 1 | Deferred history walk restarts after every completed turn (and after any scrolled-up or streaming frame), walking back one turn per tick and rebuilding all rows each step | Fixed | 4.2 s CPU per turn end (Paramount, full); 285 s (6k chat, 2,738 steps) | 0.8 ms; 4.8 ms |
| 2 | Every streaming frame and every keypress during a stream rebuilt the whole loaded history (serializing every tool call's input) | Fixed | typing 17.3 ms / stream frame 18.8 ms (Paramount, full); 175 / 175 ms (6k chat) | 0.45 / 2.0 ms; 2.9 / 4.3 ms |
| 3 | Scrolling up through history: each arriving page rebuilt all rows twice; while a page was in flight every 80 ms spinner frame was an uncached full rebuild | Fixed | page 182 of the 6k chat: spinner frame 153 ms, apply 356 ms, render 154 ms | 27 ms, 48 ms, 5 ms |
| 4 | Sidebar folder aggregates recomputed over every conversation on every frame | Fixed | 1.2 ms per keypress, 1.4 ms idle frame (3,405 conversations) | 0.5 ms, 0.7 ms |
| 5 | Scrolling back through history repainted the whole message area (scroll region used in one direction only, capped at 10 rows) | Fixed | 6.1 KB per line at 180 columns, ~11 KB at 239; half page ~10 KB | 247-370 B per line; half page redraws only the exposed rows |
| 6 | ANSI word wrap was quadratic in paragraph length | Fixed | 526 ms for a 160 KB paragraph | 24 ms |
| 7 | With the sidebar or Tasks panel open, terminal scroll regions are unusable, so each new streamed line repaints the full message area | Not fixed | ~1.3-1.6 KB per stream frame vs 165 B (11-16 KB per new line) | - |
| 8 | The streaming text block is re-rendered from scratch every frame | Not fixed (low) | ~2 ms per frame at 15 KB (largest real block) | - |
| 9 | Viewport-preserving mutations index and copy every row | Partly fixed | anchor index over all rows per mutation | per-owner scans; array copies remain |
| 10 | Startup: ~150 ms module load; sidebar waits for a 1.7 MB `conversations_list` | Not fixed (other areas) | first paint 200-330 ms, ready 370-770 ms locally | - |

Typical case (Paramount with the newest 15 turns loaded, real sidebar): idle
frame 1.37 -> 0.71 ms, keypress 1.17 -> 0.51 ms, keypress while streaming
2.2 -> 1.0 ms, stream frame 4.2 -> 2.9 ms, turn completion 31 -> 4.5 ms. Real
`st` session (Paramount, sidebar open, 239x51): ~2 ms from keypress to output,
~290 B per typed character, ~1 KB per history-cursor move, ~860 B per sidebar
move.

Memory: a 400-turn simulated streaming session grows the heap linearly with
message data (~25 KB per turn, 7 MB to 16 MB) with no retained render garbage;
module-level caches (rehydrated blocks, math images, image previews) are all
LRU/byte bounded. Streaming frames used to allocate ~5 MB of garbage each in a
fully loaded long chat (finding 2); they now allocate almost nothing.

### 1. The deferred history walk restarted after every full render

`getHistoryRender` cleared `state.deferredHistoryRender` whenever it rendered
the whole history (every frame with `pendingAI`, a scroll offset, history focus,
search or tool output). The next idle frame then started a new progressive suffix
and `scheduleDeferredHistoryRenderWork` walked it back one turn per
`setTimeout(0)`, each step rebuilding every row it included. After every
completed turn in a fully loaded chat this burned 3.8 s (Paramount, 494 steps)
to 159 s (6k chat, 2,738 steps) of CPU at ~8-60 ms per step, competing with
input the whole time. Same after scrolling up one line and back.

Fix (`render.ts`): a full build marks deferral complete for that conversation
and width, and a walk that does run grows by as many turns as it already shows
(logarithmic steps: a from-scratch walk over the 6k chat is 10 steps).

### 2. History rebuilt on every streaming frame and keypress

With `pendingAI` set, `getHistoryRender` bypassed its cache, and the cache was
also invalidated on every daemon event (`main.ts`), so each frame re-ran
`buildMessageLines` over the whole loaded history. Profile (6k chat): 42%
`JSON.stringify` (the block cache rebuilt each tool call's content key), 16%
per-row anchor allocation, the rest row assembly; 5 MB of garbage per frame.

Fixes:
- `blockrenderer.ts`: the block cache compares the block's field references
  before computing a content key. Streaming prefixes no longer churn the shared
  rehydration LRU.
- `conversation.ts`: `buildMessageLines` keeps the committed messages' rows per
  width and rebuilds from the first message whose references changed. Validity
  is checked structurally on every build (message, block and field identity),
  so in-place mutations (loaded tool outputs, reconciled blocks, replaced
  metadata) are always seen. Cross-message dependencies are handled
  conservatively: rebuilds start at the assistant run before a change; errored
  tool-call ids, the pending-continuation flag and an active durable sleep mark
  their messages dirty.
- The render loop (`reuseArrays`) takes over the previous result's arrays
  instead of copying them; other callers (`chatscroll`, `historycursor`) get
  copies, and results carry a `revision` that the floating-viewport cache keys
  on.
- `conversationscroll/chat.ts`: streaming autoscroll looks for the pending block
  within the pending message's rows instead of scanning all rows.

`history-build-cache.test.ts` differentially checks incremental builds against
fresh builds (cloned messages, so the block caches miss too) across appends,
in-place block/tool-output/metadata edits, streaming start/growth/commit,
errored tool results, unwinds, prepends, the loading row, width changes and
diagnostics toggles; mutating the dirty logic makes it fail.

### 3. Scrolling up through a long conversation

Each older page prepends messages, which changes every row index; the page apply
(`preserveViewportAcrossHistoryPrepend`) and the following render both rebuilt
everything, and the viewport-preservation content index stripped every row. While
the request was in flight, the animated loading row made the history uncacheable,
so each 80 ms spinner frame was a full rebuild (~115 ms deep in the 6k chat,
i.e. the UI was saturated for the whole round trip).

Fixes: the committed-history cache also reuses the unchanged trailing messages,
shifted, after rebuilding the changed front up to the previous segment boundary
(a real user message or terminal notice, after which no row reads earlier
messages); a same-height front (the spinner animating) is patched in place. The
content-match index in `chatscroll.ts` is built only when an anchor lookup
misses, and the anchor index scans just the owners a remap asks about.

### 4. Sidebar folder aggregates

`renderSidebar` rebuilt folder aggregates on every frame: a walk over all 3,405
conversations allocating a `Set` each, ~70% of every frame while the sidebar was
open. They are now reused while their inputs (compared by value, since summaries
are updated in place) are unchanged, and the walk no longer allocates per
conversation. Keypress with the sidebar open: 2.3 ms -> 0.7 ms p50 (bench);
~2 ms keypress-to-output in the real `st` session.

### 5. Scroll-region use when scrolling back

`frame.ts` only used DECSTBM scrolling when content moved up (toward newer
history), and only for shifts up to 10 rows. Scrolling back now uses reverse
index at the top margin, and any shift leaving three or more reusable rows
scrolls. Verified cell-for-cell against a full repaint in the test terminal model
(which learned scroll margins, LF at the bottom margin and RI) and pixel-for-pixel
in `st` (screenshot after scrolling both ways equals the screenshot after a
forced full repaint). Only applies while no sidebar, Tasks panel, overlay or
inline image is visible (see 7).

### 6. ANSI wrap

`takeAnsiRow` measured the whole remainder, sliced it per escape and copied it
per row. It now works on offsets with the carried SGR state passed in. Output is
identical to the previous implementation on 200k random styled strings.

## Not fixed

7. **Sidebar/Tasks panel disable scroll regions.** DECSTBM scrolls full-width
   rows, so with a sidebar or the floating Tasks panel the renderer repaints the
   whole message area for every new streamed line or scroll step (11-16 KB at
   239 columns). DECSLRM left/right margins would fix it but `st` does not
   implement them. Options: diff each row's sidebar and chat segments separately
   and resend only the chat segment (`ESC[K` from the chat column), or scroll the
   full width and then repaint only the sidebar column of the shifted rows. Each
   saves roughly 30-50% of those bytes; worth doing if SSH bandwidth matters on
   lossy links.
8. **Streaming text block re-render.** The pending text block is re-wrapped from
   scratch each frame, so cost is linear in the response so far. The largest
   real text blocks are ~15 KB, which costs ~2 ms per 50 ms stream frame; not
   worth an incremental markdown renderer yet.
9. **Viewport-preserving mutations still copy every row.** Ctrl+O, page
   prepends, resize and sidebar toggles now index anchors only for the owners
   they look up (`chatscroll.ts`), but still build a copied history for the old
   and new state. The first Ctrl+O in fully loaded Paramount takes ~200 ms
   (unchanged from main; later toggles hit the cache, 0.6 ms). Resize and sidebar
   toggles rebuild the new width from scratch (~1 s for the fully loaded 6k
   chat). Not addressed because it is rare and bounded per keypress.
10. **Startup.** Module load is ~150 ms of TypeScript transpilation (a bundled
    TUI would cut it); the sidebar waits for a 1.7 MB `conversations_list`
    (3,405 summaries), which over SSH is the dominant startup cost. That event is
    the wire-protocol audit's area. First paint is 200-330 ms locally.

Also observed, outside this area:
- `bun run typecheck` fails on main at
  `daemon/src/tools/bash-runner.ts:293` (`number | Signals | null` passed as
  `string | null`), reproducible on the merge base `d0c8a1de`.

## Shared files touched

For merging alongside the open-flicker agent (history/opening path):
`tui/src/render.ts` (`getHistoryRender`, deferred walk, viewport cache revision),
`tui/src/chatscroll.ts` (lazy content index only), `tui/src/conversation.ts`
(`buildMessageLines`), `tui/src/conversationscroll/chat.ts`, `tui/src/frame.ts`.
