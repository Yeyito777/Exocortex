import { connect } from "net";
import { socketPath } from "../../shared/src/paths";
import { createInitialState } from "../../tui/src/state";
import { handleEvent } from "../../tui/src/events";
import { render, invalidateHistoryRenderCache } from "../../tui/src/render";
import type { Command, Event } from "../../tui/src/protocol";

const targets = [
  { id: "1779400837687-nks3q1", title: "lenovo m10 improve run" },
  { id: "1778547786295-1ofps0", title: "lenovo m10 linux install" },
  { id: "1779235042748-uplq5r", title: "galaxy tab a9 linux" },
];
const runs = Number(process.env.RUNS ?? "5");
const scheduledDelayMs = Number(process.env.FRAME_DELAY_MS ?? "16");
const cols = Number(process.env.COLS ?? "120");
const rows = Number(process.env.ROWS ?? "40");

const originalWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
(process.stdout.write as any) = () => true;

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
function makeReqId(prefix: string) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

const daemonStub = {
  subscribe() {}, unsubscribe() {}, setSystemInstructions() {}, sendMessage() {},
} as any;

type Pending = {
  reqId: string;
  resolve: (event: Event) => void;
  reject: (err: Error) => void;
  type?: string;
  convId?: string;
};

const sock = connect(socketPath());
let buffer = "";
let pending: Pending | null = null;
let conversationsList: Extract<Event, { type: "conversations_list" }> | null = null;
let unsolicited: Event[] = [];

sock.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx = buffer.indexOf("\n");
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) {
      const event = JSON.parse(line) as Event;
      if (event.type === "conversations_list") conversationsList = event as Extract<Event, { type: "conversations_list" }>;
      if (pending && (event as any).reqId === pending.reqId && (!pending.type || event.type === pending.type) && (!pending.convId || (event as any).convId === pending.convId)) {
        const p = pending;
        pending = null;
        p.resolve(event);
      } else if (event.type === "error" && pending && (event as any).reqId === pending.reqId) {
        const p = pending;
        pending = null;
        p.reject(new Error((event as any).message));
      } else {
        unsolicited.push(event);
      }
    }
    idx = buffer.indexOf("\n");
  }
});

await new Promise<void>((resolve, reject) => {
  sock.once("connect", resolve);
  sock.once("error", reject);
});

function request(cmd: Command, type?: string, convId?: string): Promise<Event> {
  if (pending) throw new Error("concurrent request not supported");
  const reqId = (cmd as any).reqId ?? makeReqId(cmd.type);
  (cmd as any).reqId = reqId;
  return new Promise((resolve, reject) => {
    pending = { reqId, resolve, reject, type, convId };
    sock.write(JSON.stringify(cmd) + "\n");
    setTimeout(() => {
      if (pending?.reqId === reqId) {
        pending = null;
        reject(new Error(`timeout waiting for ${type ?? reqId}`));
      }
    }, 10_000);
  });
}

// Bootstrap enough sidebar state to mimic a real TUI with conversations loaded.
const pingReq = makeReqId("ping");
sock.write(JSON.stringify({ type: "ping", reqId: pingReq }) + "\n");
const deadline = Date.now() + 10_000;
while (!conversationsList && Date.now() < deadline) await sleep(10);
if (!conversationsList) throw new Error("did not receive conversations_list during bootstrap");

const results: any[] = [];
for (const target of targets) {
  for (let run = 1; run <= runs; run++) {
    const state = createInitialState();
    state.cols = cols;
    state.rows = rows;
    handleEvent(conversationsList, state, daemonStub);
    state.panelFocus = "sidebar";
    state.sidebar.selectedItem = { type: "conversation", id: target.id };
    state.sidebar.selectedId = target.id;
    state.sidebar.selectedIndex = state.sidebar.conversations.findIndex(c => c.id === target.id);
    invalidateHistoryRenderCache(state);

    const reqId = makeReqId("load_conversation");
    const t0 = performance.now();
    sock.write(JSON.stringify({ type: "load_conversation", reqId, convId: target.id }) + "\n");

    // This mirrors the immediate local render after the sidebar submit key/mouse action,
    // before the daemon response paints the new chat history.
    const localRenderStart = performance.now();
    render(state);
    const localRenderMs = performance.now() - localRenderStart;

    const event = await new Promise<Event>((resolve, reject) => {
      pending = { reqId, type: "conversation_loaded", convId: target.id, resolve, reject };
      setTimeout(() => {
        if (pending?.reqId === reqId) {
          pending = null;
          reject(new Error(`timeout loading ${target.id}`));
        }
      }, 10_000);
    }) as Extract<Event, { type: "conversation_loaded" }>;
    const tEvent = performance.now();

    const handleStart = performance.now();
    invalidateHistoryRenderCache(state);
    handleEvent(event, state, daemonStub);
    const handleMs = performance.now() - handleStart;

    await sleep(scheduledDelayMs);
    const renderStart = performance.now();
    render(state);
    const renderMs = performance.now() - renderStart;
    const end = performance.now();

    results.push({
      id: target.id,
      title: target.title,
      run,
      cols,
      rows,
      messages: state.messages.length,
      historyLines: state.historyLines.length,
      entries: event.entries.length,
      localRenderMs,
      daemonToEventMs: tEvent - t0,
      handleMs,
      scheduledDelayMs,
      firstHistoryRenderMs: renderMs,
      totalToFirstHistoryRenderMs: end - t0,
    });
  }
}

sock.end();
(process.stdout.write as any) = originalWrite;

function median(xs: number[]) { const s=[...xs].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }
function p95(xs: number[]) { const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.ceil(s.length*0.95)-1)]; }
const grouped = new Map<string, any[]>();
for (const r of results) grouped.set(r.id, [...(grouped.get(r.id) ?? []), r]);
const summary = [...grouped.entries()].map(([id, rows]) => ({
  id,
  title: rows[0].title,
  runs: rows.length,
  messages: rows[0].messages,
  entries: rows[0].entries,
  historyLines: rows[0].historyLines,
  medianTotalMs: median(rows.map(r=>r.totalToFirstHistoryRenderMs)),
  p95TotalMs: p95(rows.map(r=>r.totalToFirstHistoryRenderMs)),
  medianDaemonToEventMs: median(rows.map(r=>r.daemonToEventMs)),
  medianHandleMs: median(rows.map(r=>r.handleMs)),
  medianFirstHistoryRenderMs: median(rows.map(r=>r.firstHistoryRenderMs)),
  medianLocalRenderMs: median(rows.map(r=>r.localRenderMs)),
}));
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), cols, rows, runs, scheduledDelayMs, summary, results }, null, 2));
