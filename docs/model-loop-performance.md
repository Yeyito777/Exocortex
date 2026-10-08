# Model-loop performance investigation

Measured 2026-10-07 in worktree `model-loop-performance`, starting from
`cf364c1`. Instrumentation-only baseline: `e35ac7f`.
The main daemon was not restarted or modified.

## Findings

**There is no seconds-long local tool-to-model scheduling delay in these runs.**
The median interval from completed tools to the next OpenAI request submission
was **3.37 ms before / 3.34 ms after**. The native `exo` dispatch smoke test
started the child's loop **4.57 ms** after entering the parent executor; the
executor batch returned in **5.66 ms** (individual `exo` execution: 4.98 ms).

Two live agents independently built dependency-free browser Snake games in
their isolated conversation directories. Each implemented and executed tests,
fixed failures, and inspected the resulting files.

| Client-observed metric | Baseline | Optimized |
|---|---:|---:|
| Task wall time | 100.777 s | 119.676 s |
| Provider rounds | 6 | 8 |
| Output tokens | 8,236 | 8,437 |
| Total provider-call elapsed | 100.570 s | 119.195 s |
| Total tool execution batches | 182 ms | 442 ms |
| Initial request setup, including connection | 577 ms | 644 ms |
| Warm request setup range | 0.84–1.32 ms | 0.73–1.38 ms |
| Request sent → first response event, median | 390 ms | 504 ms |
| Tool completion → next request sent, median | 3.37 ms | 3.34 ms |
| Tool completion → next request sent, maximum | 3.79 ms | 4.79 ms |
| Total recovery/persistence callback elapsed | 9.2 ms | 13.7 ms |

**“First response event” is a protocol acknowledgement, not TTFT.** It can
precede any assistant text, thinking summary, or tool arguments. The UX
follow-up below measures actual text separately.

Provider-call elapsed includes setup, network, generation, client-side decoding,
callbacks, and accounting; it is **not** a measurement of server execution alone.
The longest code-writing provider round was 80.96 / 92.43 seconds.
Both runs reused the same WebSocket and guarded `previous_response_id` deltas
after the first round, with no transport retries or context compactions.
Fast service was requested; the provider reported standard billing.

**The live runs do not demonstrate an end-to-end speedup.** The second generated
different code and needed two additional rounds. Model variability dominates
the small local overhead. Final independently rerun game tests: baseline
13 pass; optimized 12 pass.

## First-text UX follow-up

The relevant user-facing metric is **submit → first real assistant text frame**,
not `response.created`. New daemon phases distinguish `first_text` and
`first_thinking` from `first_response` and hidden `first_output` progress.
Old records without these phases remain unknown; they are not filled in using
the acknowledgement time. Opt-in TUI logs report `perf: first_text_frame`.
This frame boundary is terminal-output submission, not an acknowledgement from
the display/compositor.

The existing connection cache worked after successful turns, but prewarming
started too late: only existing chats, only after typing, with a 700 ms debounce.
A rapid submit could discard an in-flight warm-up and open a second socket.
The TUI also batched its first text chunk with the normal 50 ms stream delay.

Changes:

- Prewarm on entering an eligible OpenAI view, including a **blank draft**,
  before typing. Reserve a client conversation ID without persisting a chat,
  workspace, user message, or model request; normal submission uses that ID.
- Keep the current eligible view ready with a four-minute background refresh,
  ahead of the existing five-minute parked-connection expiry. No model
  generation is requested. Other views still expire; idle sockets are capped
  at eight and speculative connections at four.
- Deduplicate warm-ups and hand the ready socket to submission. Join an
  in-flight warm-up before auth resolution, with a one-second handoff ceiling
  and immediate abort support. Failed/stalled warm-ups fall back to a normal
  connection; late speculative sockets cannot replace the active turn.
  Speculative connect/retry work receives a five-second abort signal, though
  underlying auth HTTP calls retain their own cancellation/timeouts.
- Render the first non-whitespace assistant text immediately. Subsequent
  chunks retain batching; bookkeeping, auth revision/account guards,
  incremental-replay checks, and model settings are unchanged.

Direct connection-only probes, with cached auth, measured **553–600 ms** for
fresh WebSockets versus **0.04–0.06 ms** to lease the same standby socket.
An independent fresh-process auth verification took approximately 1.01 s;
that is separate from the socket handshake, and the existing 60-second auth
verification TTL is unchanged. These probes do not isolate DNS/TCP/TLS/upgrade
or individual remote proxy hops.
After restarting only the isolated `exotest` instance with the final code,
request-correlated draft warm-up took **568 ms** cold and **0.57 ms** on an
already-ready socket, including IPC. Neither operation created history or
submitted a model request.

Six short real-model calls used the same `gpt-6.1-sol`, high effort, fast-mode
selection, asking for exactly `READY`. Three cold/warm pairs alternated order:

| Pair | Cold submit → first text | Prewarmed submit → first text |
|---|---:|---:|
| 1 | 1,900 ms | 1,570 ms |
| 2 | 2,127 ms | 2,215 ms |
| 3 | 1,988 ms | 1,587 ms |
| Median | **1,988 ms** | **1,587 ms** |

Observed median improvement: 401 ms (~20%). This small sample is **not a
guaranteed latency reduction**; one warm sample was slower. Traces establish
the actual local gain: request setup fell from **553–683 ms** to **0.65–0.87 ms**,
and all three prewarmed calls reused a physical connection. The remaining
time to text varies inside the network/provider path.

A separate actual nested-TUI submission displayed `READY`:
**1,376 ms submit → text received**, **1,378 ms submit → first text frame**,
and **1.78 ms received → frame**. Its blank draft had been prewarmed roughly
70 seconds before submission. Auth re-verification contributed approximately
94 ms of request setup; the socket was still reused. A screenshot confirmed
the text was actually present in the chat, not a synthetic placeholder.

Reproduce the six-call test against an isolated `exotest` daemon:

```sh
bun scripts/dev/profile-ttft.ts --live
```

Manifest: `config/storage/diagnostics/benchmarks/ttft-1791423818531.json`.
The benchmark deletes its short test conversations on success and preserves
diagnostics. TUI test conversation: `1791423802108-2f6khi` (also deleted after
verification). Connection readiness remains best-effort: daemon restarts,
expired/auth-changed sessions, network loss, suspended clients, and cache
eviction can still require reconnecting.

## CPU bottlenecks and changes

A fixed, network-free workload uses one warm-up and seven measured samples,
with Bun's sampling CPU profiler. The baseline profile lasted 11.89 seconds:
`emitTailDiff` consumed 61.9% of CPU samples and
`projectReasoningSummaryText` 26.1%. They repeatedly scanned/flattened the full
accumulated output on each small delta: quadratic work as output grows.

| Fixed workload (median) | Before | After | Speedup |
|---|---:|---:|---:|
| 20,000 text deltas, 360,000 characters | 678.13 ms | 5.80 ms | 117× |
| 20,000 plain reasoning-summary deltas | 698.02 ms | 4.31 ms | 162× |
| 8 MiB replay comparison, 20 rounds, rebuilt wire objects | 79.35 ms | 11.26 ms | 7.0× |
| Mock agent loop, 100 tool rounds | 5.41 ms | 6.99 ms | No improvement |

The mock loop remains tens of microseconds per round. Its small absolute
increase is recorded rather than presented as a speedup. CPU results are
microbenchmarks, not a claim that real conversations become 117× faster.

Changes:

- Cache the last rendered canonical blocks and emit known tail deltas directly.
  Earlier items/parts, raw/summary switches, HTML-placeholder projection, and
  canonical revisions retain the full rebuild/diff path. Previously published
  sync snapshots remain immutable. Bold/HTML-prefixed summaries conservatively
  retain projection checks; the 162× figure applies to plain summaries.
- Compare replay items structurally before falling back to JSON equivalence.
  Unchanged large strings no longer require serializing the entire prefix
  twice per round. Prefix mismatch fallback and account/turn protections remain.
- Parse each WebSocket event once instead of parsing it again to detect errors.
  Malformed/non-object events are ignored safely.
- Do not calculate diagnostic request hashes when profiling is disabled.
- Add opt-in monotonic round/transport checkpoints and per-tool execution /
  scheduling-wait timings. No speculative tool execution, relaxed persistence,
  skipped auth, or unsafe parallelization.

## Reproduction

From a linked worktree, set its **local, untracked** `config/config.json`:

```json
{ "diagnostics": { "performanceProfiling": true } }
```

Profiling is read once at process startup. Use a nested environment, never the
host GUI, and start **only the worktree** daemon/TUI with `exotest`:

```sh
dwm start model-loop-test
dwm -e model-loop-test run -- sh -c \
  'cd /absolute/path/to/worktree && exec st -e ./scripts/dev/exotest worktree-name'

# Opt-in paid live run; labels must be unique. No network is used by the child tools.
bun scripts/dev/profile-model-loop.ts --live sample-1 gpt-6.1-sol
bun scripts/dev/summarize-model-loop.ts <printed-conversation-id>

# Offline CPU run with isolated config; no credentials or model requests needed.
EXOCORTEX_CONFIG_DIR="$(mktemp -d)" bun --cpu-prof --cpu-prof-md \
  --cpu-prof-dir=/tmp --cpu-prof-name=model-loop \
  scripts/dev/profile-model-loop-cpu.ts
```

Live manifests are under `config/storage/diagnostics/benchmarks/`; correlated
round traces are in `model-loop/`, provider records in `model-requests/`, and
per-tool records in `tool-calls/`. JSONL files have the existing seven-day
retention and 32 MiB/kind/day cap. Round traces contain phase names, times,
identifiers, and request byte counts, not prompts, tool contents, or credentials.
Other providers have round-level timings; wire submission/first-response
instrumentation currently covers OpenAI WebSocket and HTTP/SSE.

`request_sent` is a **local** boundary: WebSocket `sendText` completed, or HTTP
submission is about to enter `fetch`. It is not server acknowledgement.
Missing wire data remains unknown. Retries are marked; summaries exclude
blended retry TTFT/setup samples. Cross-turn/process handoffs are not combined.
On observer timeout/disconnect, inspect the conversation before retrying:
the original turn may still be running.

Baseline conversation: `1791419033545-xxfukl`; optimized:
`1791419305533-8ppdhh`. Native dispatch parent:
`1791419455097-q6xlii`; child: `1791419458400-pfkz7k`.
Generated games remain in this worktree's isolated conversation workspaces
until worktree cleanup.

## Validation

- Shared, daemon, and TUI TypeScript checks.
- Targeted regression run: 184 pass, 0 fail across 20 files.
- OpenAI transport/replay/auth/reasoning, agent, diagnostics, tool scheduling,
  watchdog, and persistence regression suites.
- 100 seeded differential streaming cases, comparing fast paths against
  canonical per-event rebuilds, including out-of-order content, corrections,
  malformed indexes, raw/summary changes, and placeholder projection.
- Monotonic timing/summary tests and transport callback ordering.
- Two real game-building runs and native subagent dispatch via the isolated
  `exotest` daemon; final generated game tests independently rerun.
- First-text follow-up regressions: 232 pass across 23 transport/agent/client
  files, 81 handler tests, and 122 TUI event/render tests (435 total).
- Standby deduplication/handoff, rapid abort, failed and stalled speculative
  connections, late-owner isolation, concurrency/idle limits, reserved-draft
  validation/no history, and distinct acknowledgement/text timing tests.
- Six paired live first-text calls and an actual nested-TUI first-text frame.

## Remaining bottlenecks

For these small coding tasks: model reasoning/output generation, then network
response latency and initial connection setup. Heavy external commands,
polling/yield budgets, context compaction, or slow presentation filesystems can
dominate other workloads; the new phases expose them instead of attributing
all inter-request time to OpenAI. The retained canonical correction path can
still rescan long unusual/out-of-order streams. No evidence here justifies
weakening crash recovery, authentication, or side-effect ordering to save
a few milliseconds.
