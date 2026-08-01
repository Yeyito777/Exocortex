#!/usr/bin/env bun
import net from "node:net";
import { writeFileSync } from "node:fs";

const [socketPath, convId, minimumRaw, reportPath] = process.argv.slice(2);
if (!socketPath || !convId || !minimumRaw || !reportPath) {
  throw new Error("usage: daemon-ipc-storage-smoke.ts SOCKET CONVERSATION_ID MINIMUM_COUNT REPORT.json");
}
const minimumCount = Number(minimumRaw);
if (!Number.isSafeInteger(minimumCount) || minimumCount < 1) throw new Error("MINIMUM_COUNT must be positive");

const socket = net.connect(socketPath);
let buffer = "";
let settled = false;
const state: any = { ping: false, list: null, loaded: null, older: null, tools: null };
const timer = setTimeout(() => finish(new Error(`Timed out waiting for storage IPC: ${JSON.stringify({ ping: state.ping, list: Boolean(state.list), loaded: Boolean(state.loaded), older: Boolean(state.older), tools: Boolean(state.tools) })}`)), 20_000);

function send(command: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(command)}\n`);
}
function finish(error?: Error): void {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  socket.end();
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }
  const report = {
    verifiedAt: Date.now(),
    daemonPing: "ok",
    conversationCount: state.list.conversations.length,
    folderCount: state.list.folders?.length ?? 0,
    loadedId: state.loaded.convId,
    provider: state.loaded.provider,
    model: state.loaded.model,
    recentEntryCount: state.loaded.entries.length,
    hasOlderHistory: state.loaded.hasOlderHistory === true,
    olderEntryCount: state.older?.entries.length ?? 0,
    olderCursorProgressed: state.older ? state.older.historyStartIndex < state.loaded.historyStartIndex : null,
    deferredToolOutputCount: state.tools.outputs.length,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
function maybeFinish(): void {
  if (!state.ping || !state.list || !state.loaded || !state.tools) return;
  if (state.loaded.hasOlderHistory && !state.older) return;
  if (state.list.conversations.length < minimumCount) return finish(new Error(`Expected at least ${minimumCount} conversations, got ${state.list.conversations.length}`));
  if (state.loaded.hasOlderHistory && !(state.older.historyStartIndex < state.loaded.historyStartIndex)) return finish(new Error("Older history cursor did not progress"));
  finish();
}

socket.on("connect", () => {
  send({ type: "ping", reqId: "storage-ping" });
  send({ type: "list_conversations", reqId: "storage-list" });
  send({ type: "load_conversation", reqId: "storage-load", convId, turns: 5 });
  send({ type: "load_tool_outputs", reqId: "storage-tools", convId });
});
socket.on("data", (chunk) => {
  buffer += String(chunk);
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === "error" && String(event.reqId ?? "").startsWith("storage-")) return finish(new Error(event.message));
    if (event.type === "pong" && event.reqId === "storage-ping") state.ping = true;
    if (event.type === "conversations_list" && event.reqId === "storage-list") state.list = event;
    if (event.type === "conversation_loaded" && event.reqId === "storage-load") {
      state.loaded = event;
      if (event.hasOlderHistory) send({
        type: "load_conversation_history",
        reqId: "storage-older",
        convId,
        requestSource: "viewport",
        beforeEntryIndex: event.historyStartIndex,
        turns: 5,
      });
    }
    if (event.type === "conversation_history_loaded" && event.reqId === "storage-older") state.older = event;
    if (event.type === "tool_outputs_loaded" && event.reqId === "storage-tools") state.tools = event;
    maybeFinish();
  }
});
socket.on("error", (error) => finish(error));
