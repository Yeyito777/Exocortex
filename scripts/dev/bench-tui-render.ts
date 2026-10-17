// Read-only TUI render benchmark against an explicitly supplied conversation
// database. Prints timings and byte counts, never transcript text.
//
//   EXOCORTEX_CONFIG_DIR=$(mktemp -d) bun scripts/dev/bench-tui-render.ts DATABASE CONV_ID [--turns N] [--cols C] [--rows R]
//
// --turns bounds the loaded window like an opened conversation (default: the
// whole conversation, i.e. a session scrolled all the way to the top).
// --sidebar FILE opens the sidebar with a saved conversations_list event line.
// --tasks N gives the open conversation N synthetic running tasks (Tasks panel).
import { SqliteConversationStore } from "../../daemon/src/sqlite-conversation-store";
import { createInitialState, type RenderState } from "../../tui/src/state";
import { pushDisplayEntries } from "../../tui/src/events/display";
import { advanceDeferredHistoryRender, hasDeferredHistoryRenderWork, render, invalidateHistoryRenderCache } from "../../tui/src/render";
import { createPendingAI } from "../../tui/src/messages";
import { handleEvent } from "../../tui/src/events";
import type { Event } from "../../tui/src/protocol";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const index = args.indexOf(name);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const [path, convId] = args;
if (!path || !convId) throw new Error("Usage: bun scripts/dev/bench-tui-render.ts DATABASE CONV_ID [--turns N] [--cols C] [--rows R]");
const turns = flag("--turns", 1_000_000);
const cols = flag("--cols", 180);
const rows = flag("--rows", 50);
const sidebarFile = args.includes("--sidebar") ? args[args.indexOf("--sidebar") + 1] : null;
const sidebarEvent = sidebarFile ? JSON.parse(await Bun.file(sidebarFile).text()) as Event : null;
const taskCount = flag("--tasks", 0);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;

const store = new SqliteConversationStore({ path, readonly: true });
const page = store.loadDisplayPage(convId, turns);
store.close();
if (!page) throw new Error("conversation not found");

const realWrite = process.stdout.write.bind(process.stdout);
let bytes = 0;
process.stdout.write = ((chunk: string | Uint8Array) => {
  bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
  return true;
}) as typeof process.stdout.write;
const out = (line: object) => realWrite(JSON.stringify(line) + "\n");

const daemon = new Proxy({}, { get: () => () => undefined }) as never;

function freshState(): RenderState {
  const state = createInitialState();
  state.cols = cols;
  state.rows = rows;
  state.convId = convId;
  state.sidebar.open = sidebarEvent !== null;
  if (sidebarEvent) handleEvent(sidebarEvent, state, daemon);
  if (taskCount > 0) {
    const now = Date.now();
    const tasks = Array.from({ length: taskCount }, (_, i) => ({
      id: `task-${i}`,
      kind: (["subagent", "background", "chrono"] as const)[i % 3],
      title: `Synthetic task ${i} doing some long running work`,
      startedAt: now - i * 61_000,
      ...(i % 3 === 2 ? { dueAt: now + i * 60_000, chronoMode: "wake" as const } : {}),
    }));
    const summary = state.sidebar.conversations.find(conversation => conversation.id === convId);
    if (summary) summary.tasks = tasks;
    else state.sidebar.conversations.push({
      id: convId, provider: state.provider, model: state.model, effort: state.effort, fastMode: state.fastMode,
      createdAt: 0, updatedAt: 0, messageCount: 0, title: "bench", marked: false, pinned: false, streaming: true,
      unread: false, sortOrder: 0, tasks,
    });
  }
  pushDisplayEntries(state, JSON.parse(JSON.stringify([...page!.pinnedEntries, ...page!.entries])));
  return state;
}

function measure(name: string, iterations: number, setup: (state: RenderState) => void, step: (state: RenderState, i: number) => void) {
  if (only && !only.includes(name)) return;
  const state = freshState();
  setup(state);
  render(state); // warm
  const times: number[] = [];
  bytes = 0;
  const heapBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < iterations; i++) {
    step(state, i);
    const t = performance.now();
    render(state);
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  out({
    scenario: name,
    n: iterations,
    meanMs: +(sum / iterations).toFixed(2),
    p50Ms: +times[Math.floor(iterations / 2)].toFixed(2),
    p95Ms: +times[Math.floor(iterations * 0.95)].toFixed(2),
    maxMs: +times[iterations - 1].toFixed(2),
    bytesPerFrame: Math.round(bytes / iterations),
    heapDeltaMB: +((process.memoryUsage().heapUsed - heapBefore) / 1e6).toFixed(1),
  });
}

const typeChar = (state: RenderState, i: number) => {
  const ch = "the quick brown fox "[i % 20];
  state.inputBuffer = state.inputBuffer.slice(0, state.cursorPos) + ch + state.inputBuffer.slice(state.cursorPos);
  state.cursorPos++;
};
const startStream = (state: RenderState) => {
  state.pendingAI = createPendingAI(Date.now(), state.model);
  handleEvent({ type: "block_start", convId, blockType: "text" } as Event, state, daemon);
};
const DELTA = "Some streamed **markdown** text with `code` and a [link](https://example.com). ";
// Paragraph breaks every few chunks, like a real response.
const streamDelta = (state: RenderState, i: number) => {
  const text = i % 8 === 7 ? `${DELTA}\n\n` : DELTA;
  handleEvent({ type: "text_chunk", convId, text } as Event, state, daemon);
};

out({ sidebarConversations: sidebarEvent ? freshState().sidebar.conversations.length : 0, convId, messages: freshState().messages.length, entries: page.entries.length, cols, rows });

{
  const state = freshState();
  let t = performance.now();
  render(state);
  const coldDeferred = performance.now() - t;
  state.pendingAI = createPendingAI(Date.now(), state.model);
  invalidateHistoryRenderCache(state);
  t = performance.now();
  render(state);
  const coldFull = performance.now() - t;
  out({ scenario: "cold", deferredFirstPaintMs: +coldDeferred.toFixed(1), fullHistoryMs: +coldFull.toFixed(1) });
}

measure("idle-rerender", 50, () => {}, () => {});
measure("type-idle", Number(process.env.BENCH_TYPE_N ?? 100), () => {}, typeChar);
measure("type-while-streaming", Number(process.env.BENCH_TYPE_N ?? 100), startStream, typeChar);
measure("stream-delta", Number(process.env.BENCH_STREAM_N ?? 200), startStream, streamDelta);
measure("scroll-up-1", 100, state => { state.scrollOffset = 1; }, state => { state.scrollOffset += 1; });
measure("history-cursor-j", 100, state => {
  state.panelFocus = "chat";
  state.chatFocus = "history";
  render(state);
  state.historyCursor = { row: Math.max(0, state.historyLines.length - 200), col: 0 };
}, state => { state.historyCursor = { row: state.historyCursor.row + 1, col: 0 }; });
measure("loading-older-spinner", 60, state => {
  state.scrollOffset = Math.max(1, Math.floor(state.layout.totalLines / 2));
  state.historyLoadingOlder = true;
  state.historyLoadingStartedAt = Date.now();
}, state => { state.historyLoadingStartedAt! -= 80; });
// A turn finishing: the stream commits, then the TUI's deferred-history timer
// walks the render back to the first loaded message, one turn per tick.
if (!only || only.includes("turn-complete")) {
  const state = freshState();
  startStream(state);
  for (let i = 0; i < 20; i++) { streamDelta(state, i); render(state); }
  state.messages.push(state.pendingAI!);
  state.pendingAI = null;
  bytes = 0;
  const t = performance.now();
  render(state);
  const firstMs = performance.now() - t;
  let steps = 0;
  while (hasDeferredHistoryRenderWork(state) && advanceDeferredHistoryRender(state)) {
    render(state);
    steps++;
  }
  out({ scenario: "turn-complete", firstRenderMs: +firstMs.toFixed(1), deferredSteps: steps,
    totalMs: +(performance.now() - t).toFixed(1), bytes });
}
// Progressive first paint over everything loaded (open, or a width change).
if (!only || only.includes("deferred-walk")) {
  const state = freshState();
  const t = performance.now();
  render(state);
  const firstMs = performance.now() - t;
  let steps = 0;
  let slowestStepMs = 0;
  while (hasDeferredHistoryRenderWork(state) && advanceDeferredHistoryRender(state)) {
    const stepStartedAt = performance.now();
    render(state);
    slowestStepMs = Math.max(slowestStepMs, performance.now() - stepStartedAt);
    steps++;
  }
  out({ scenario: "deferred-walk", firstPaintMs: +firstMs.toFixed(1), steps,
    slowestStepMs: +slowestStepMs.toFixed(1), totalMs: +(performance.now() - t).toFixed(1) });
}
measure("tool-output-toggle", 6, () => {}, state => { state.showToolOutput = !state.showToolOutput; });
