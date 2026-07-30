import { unlinkSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFromDisk } from "../../daemon/src/conversations";
import { createHandler } from "../../daemon/src/handler";
import { DaemonServer, type ConnectedClient } from "../../daemon/src/server";
import { handleEvent } from "../../tui/src/events";
import type { Command, Event } from "../../tui/src/protocol";
import { render } from "../../tui/src/render";
import { createInitialState } from "../../tui/src/state";

const targetId = process.env.CONV_ID ?? "1785427358263-rzconc";
const direction = process.env.DIRECTION === "up" ? "up" : "down";
const socketPath = join(tmpdir(), `exocortex-move-profile-${process.pid}.sock`);
const cols = Number(process.env.COLS ?? "120");
const rows = Number(process.env.ROWS ?? "40");

let handler: ((client: ConnectedClient, command: Command) => void | Promise<void>) | null = null;
const server = new DaemonServer(socketPath, (client, command) => handler?.(client, command));
handler = createHandler(server);
const loadStartedAt = performance.now();
const loadStats = loadFromDisk();
const loadMs = performance.now() - loadStartedAt;
await server.start();

const socket = connect(socketPath);
await new Promise<void>((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("error", reject);
});

let buffer = "";
const eventQueue: Event[] = [];
let wake: (() => void) | null = null;
socket.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) eventQueue.push(JSON.parse(line) as Event);
  }
  wake?.();
  wake = null;
});

async function nextEvent(type: Event["type"]): Promise<Event> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const index = eventQueue.findIndex(event => event.type === type);
    if (index !== -1) return eventQueue.splice(index, 1)[0]!;
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, 50);
    });
  }
  throw new Error(`Timed out waiting for ${type}`);
}

socket.write(`${JSON.stringify({ type: "list_conversations", reqId: "bootstrap" })}\n`);
const initial = await nextEvent("conversations_list") as Extract<Event, { type: "conversations_list" }>;
const state = createInitialState();
state.cols = cols;
state.rows = rows;
state.sidebar.open = true;
state.panelFocus = "sidebar";
handleEvent(initial, state, {});
state.sidebar.selectedItem = { type: "conversation", id: targetId };
state.sidebar.selectedId = targetId;
state.sidebar.selectedIndex = state.sidebar.conversations.findIndex(conversation => conversation.id === targetId);

const startedAt = performance.now();
socket.write(`${JSON.stringify({
  type: "move_sidebar_item",
  item: { type: "conversation", id: targetId },
  direction,
} satisfies Command)}\n`);
const moved = await nextEvent("conversation_moved") as Extract<Event, { type: "conversation_moved" }>;
const roundTripToParsedEventMs = performance.now() - startedAt;

const handleStartedAt = performance.now();
handleEvent(moved, state, {});
const tuiHandleMs = performance.now() - handleStartedAt;
const originalWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
(process.stdout.write as unknown as (chunk: unknown) => boolean) = () => true;
const renderStartedAt = performance.now();
render(state);
const tuiRenderMs = performance.now() - renderStartedAt;
(process.stdout.write as typeof process.stdout.write) = originalWrite;

socket.write(`${JSON.stringify({
  type: "move_sidebar_item",
  item: { type: "conversation", id: targetId },
  direction: direction === "up" ? "down" : "up",
} satisfies Command)}\n`);
await nextEvent("conversation_moved");

socket.end();
await server.stop();
try { unlinkSync(socketPath); } catch { /* already removed by server */ }

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  targetId,
  direction,
  conversations: initial.conversations.length,
  folders: initial.folders?.length ?? 0,
  sidebarPayloadMiB: Buffer.byteLength(JSON.stringify(moved)) / 1024 / 1024,
  loadMs,
  loadStats,
  roundTripToParsedEventMs,
  tuiHandleMs,
  tuiRenderMs,
  totalToRenderedMs: roundTripToParsedEventMs + tuiHandleMs + tuiRenderMs,
}, null, 2));
