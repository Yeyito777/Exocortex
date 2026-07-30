import { statSync } from "node:fs";
import { join } from "node:path";
import { conversationsDir } from "../../shared/src/paths";
import {
  listSidebarState,
  loadFromDisk,
  moveSidebarItem,
} from "../../daemon/src/conversations";
import { handleEvent } from "../../tui/src/events";
import type { Event } from "../../tui/src/protocol";
import { render } from "../../tui/src/render";
import { createInitialState } from "../../tui/src/state";

const targetId = process.env.CONV_ID ?? "1785427358263-rzconc";
const direction = process.env.DIRECTION === "up" ? "up" : "down";
const cols = Number(process.env.COLS ?? "120");
const rows = Number(process.env.ROWS ?? "40");

function timed<T>(run: () => T): { value: T; durationMs: number } {
  const startedAt = performance.now();
  const value = run();
  return { value, durationMs: performance.now() - startedAt };
}

function memoryMiB(): Record<string, number> {
  return Object.fromEntries(
    Object.entries(process.memoryUsage()).map(([key, value]) => [key, value / 1024 / 1024]),
  );
}

const load = timed(() => loadFromDisk());
const sidebarBefore = timed(() => listSidebarState());
const beforeEvent: Event = { type: "conversation_moved", ...sidebarBefore.value };
const beforeJson = timed(() => JSON.stringify(beforeEvent));
const targetBefore = sidebarBefore.value.conversations.find((conversation) => conversation.id === targetId);
if (!targetBefore) throw new Error(`Conversation ${targetId} was not loaded`);

const peers = sidebarBefore.value.conversations
  .filter((conversation) => (conversation.folderId ?? null) === (targetBefore.folderId ?? null)
    && conversation.pinned === targetBefore.pinned)
  .sort((a, b) => a.sortOrder - b.sortOrder);
const targetIndex = peers.findIndex((conversation) => conversation.id === targetId);
const adjacentIndex = direction === "up" ? targetIndex - 1 : targetIndex + 1;
const adjacent = peers[adjacentIndex];
if (!adjacent) throw new Error(`Conversation ${targetId} cannot move ${direction}`);

const beforeMemory = memoryMiB();
const coldMove = timed(() => moveSidebarItem({ type: "conversation", id: targetId }, direction));
const afterColdMoveMemory = memoryMiB();
const sidebarAfter = timed(() => listSidebarState());
const afterEvent: Event = { type: "conversation_moved", ...sidebarAfter.value };
const afterJson = timed(() => JSON.stringify(afterEvent));

const state = createInitialState();
state.cols = cols;
state.rows = rows;
state.sidebar.open = true;
state.panelFocus = "sidebar";
handleEvent({ type: "conversations_list", ...sidebarBefore.value }, state, {});
state.sidebar.selectedItem = { type: "conversation", id: targetId };
state.sidebar.selectedId = targetId;
state.sidebar.selectedIndex = state.sidebar.conversations.findIndex((conversation) => conversation.id === targetId);

const originalWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
(process.stdout.write as unknown as (chunk: unknown) => boolean) = () => true;
const tuiHandle = timed(() => handleEvent(afterEvent, state, {}));
const tuiRender = timed(() => render(state));
(process.stdout.write as typeof process.stdout.write) = originalWrite;

const warmMoveBack = timed(() => moveSidebarItem(
  { type: "conversation", id: targetId },
  direction === "up" ? "down" : "up",
));

const fileSize = (id: string): number => statSync(join(conversationsDir(), `${id}.json`)).size;
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  target: {
    id: targetId,
    title: targetBefore.title,
    fileMiB: fileSize(targetId) / 1024 / 1024,
    messageCount: targetBefore.messageCount,
    peerIndex: targetIndex,
    peerCount: peers.length,
  },
  adjacent: {
    id: adjacent.id,
    title: adjacent.title,
    fileMiB: fileSize(adjacent.id) / 1024 / 1024,
    messageCount: adjacent.messageCount,
  },
  fixture: {
    conversations: sidebarBefore.value.conversations.length,
    folders: sidebarBefore.value.folders.length,
  },
  load: { measuredMs: load.durationMs, ...load.value },
  timingsMs: {
    listSidebarBefore: sidebarBefore.durationMs,
    stringifySidebarBefore: beforeJson.durationMs,
    coldMove: coldMove.durationMs,
    listSidebarAfter: sidebarAfter.durationMs,
    stringifySidebarAfter: afterJson.durationMs,
    tuiHandleMoved: tuiHandle.durationMs,
    tuiRenderAfterMoved: tuiRender.durationMs,
    warmMoveBack: warmMoveBack.durationMs,
  },
  sidebarPayloadMiB: Buffer.byteLength(afterJson.value) / 1024 / 1024,
  memoryMiB: { beforeMove: beforeMemory, afterColdMove: afterColdMoveMemory },
  moved: { cold: coldMove.value, warmBack: warmMoveBack.value },
}, null, 2));
