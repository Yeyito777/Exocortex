#!/usr/bin/env bun
/** Read/mutate only the explicitly selected worktree daemon; no model calls. */
import assert from "node:assert/strict";
import net from "node:net";
import { socketPath, worktreeName } from "../../shared/src/paths";
import type { Command } from "../../shared/src/protocol";

assert(worktreeName(), "Run this smoke test from a worktree, never main.");
const socket = net.connect(socketPath());
await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
let buffer = "";
let serial = 0;
const pending = new Map<string, { resolve: (event: any) => void; reject: (error: Error) => void }>();
socket.on("data", chunk => {
  buffer += String(chunk);
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const event = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const waiter = pending.get(event.reqId);
    if (waiter) { pending.delete(event.reqId); waiter.resolve(event); }
  }
});
socket.on("error", error => { for (const waiter of pending.values()) waiter.reject(error); });
function request(command: Command): Promise<any> {
  const reqId = `simple-exo-smoke-${++serial}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(reqId); reject(new Error(`IPC timeout: ${command.type}`)); }, 5000);
    pending.set(reqId, {
      resolve: event => { clearTimeout(timeout); resolve(event); },
      reject: error => { clearTimeout(timeout); reject(error); },
    });
    socket.write(JSON.stringify({ ...command, reqId }) + "\n");
  });
}
const ids: string[] = [];
let folderId: string | undefined;
try {
  assert.equal((await request({ type: "ping" })).type, "pong");
  const name = `simple-exo-smoke-${Date.now()}`;
  assert.equal((await request({ type: "create_folder", name })).type, "ack");
  const sidebar = await request({ type: "list_conversations" });
  folderId = sidebar.folders.find((folder: any) => folder.name === name)?.id;
  assert(folderId);
  for (const subagent of [false, true]) {
    const created = await request({ type: "new_conversation", provider: "openai",
      model: "gpt-6.1-sol", folderId, subagent, title: `Smoke ${subagent ? "child" : "parent"}` });
    assert.equal(created.type, "conversation_created");
    ids.push(created.convId);
    const prompt = await request({ type: "get_system_prompt", convId: created.convId });
    assert.equal(prompt.type, "system_prompt");
    for (const text of ["Default: sol fast", "docs/daemon-ipc.md", "## exec_command", "## apply_patch", "# External tools"]) {
      assert(prompt.systemPrompt.includes(text), `Missing ${text} in ${subagent ? "child" : "parent"} prompt`);
    }
    assert(!prompt.systemPrompt.includes("Use exo tasks"));
    const loaded = await request({ type: "load_conversation", convId: created.convId });
    assert.equal(loaded.type, "conversation_loaded");
    assert(!Object.hasOwn(loaded, "toolPolicySnapshot"));
  }
  const retired = await request({ type: "set_tool_policy", convId: ids[0], mutation: { action: "reset" } });
  assert.equal(retired.type, "error");
  assert.equal(retired.message, "Tool selection is retired.");
  const tasks = await request({ type: "list_tasks", convId: ids[0] });
  assert.equal(tasks.type, "tasks_list");
  assert.deepEqual(tasks.tasks, []);
  const badStop = await request({ type: "stop_task", convId: ids[0], taskId: "1234" });
  assert.equal(badStop.type, "error");
  const finalList = await request({ type: "list_conversations" });
  assert(ids.every(id => finalList.conversations.some((conv: any) => conv.id === id)));
  console.log("PASS: worktree JSONL IPC, conversation/folder creation and inspection, full child tools/hints, retired selection.");
} finally {
  // Delete commands broadcast rather than replying; a following list is the
  // same-connection ordering barrier and verifies cleanup.
  for (const convId of ids) socket.write(JSON.stringify({ type: "delete_conversation", convId }) + "\n");
  if (folderId) socket.write(JSON.stringify({ type: "delete_folder", folderId, mode: "unwrap" }) + "\n");
  try {
    const sidebar = await request({ type: "list_conversations" });
    assert(!sidebar.conversations.some((conv: any) => ids.includes(conv.id)));
    assert(!sidebar.folders.some((folder: any) => folder.id === folderId));
  } finally { socket.destroy(); }
}
