#!/usr/bin/env bun
/**
 * Stand-in for `exocortexd proxy` that bridges stdio to a running daemon but
 * forwards only read-only commands, so a measured TUI can watch a real daemon's
 * live conversations (streams, tasks, the whole sidebar) without being able to
 * change anything there: no sends, queueing, aborts, renames, moves, prewarms.
 * It also strips `clientHost` from client_capabilities, so the daemon never
 * routes client_bash to the measured TUI or announces it in conversations, and
 * drops any client_exec_* event that reaches it anyway.
 *
 *   TAP_SOCKET=/path/to/exocortexd.sock [TAP_RECORD=down.jsonl] [TAP_LOG=tap.log] bun scripts/dev/readonly-daemon-tap.ts
 *
 * With scripts/dev/ssh-wan-sim.ts: WAN_PROXY_ENTRY=/abs/path/readonly-daemon-tap.ts.
 * Over real SSH: tui-stall-profile.ts --remote-command 'TAP_SOCKET=… bun …/readonly-daemon-tap.ts'.
 * TAP_RECORD gets one {t, line} row per downstream line; TAP_LOG every forwarded
 * or dropped command. Keep the allowlist read-only: anything added here reaches
 * the owner's real daemon.
 */
import { appendFileSync } from "node:fs";
import { connect } from "node:net";

const socketPath = process.env.TAP_SOCKET;
if (!socketPath) {
  console.error("readonly-daemon-tap: set TAP_SOCKET to the daemon socket");
  process.exit(2);
}
const record = process.env.TAP_RECORD;
const logFile = process.env.TAP_LOG;
const log = (line: string) => { if (logFile) appendFileSync(logFile, line + "\n"); };

const READ_ONLY_COMMANDS = new Set([
  "client_capabilities", "ping", "list_conversations", "load_conversation", "load_conversation_history",
  "load_tool_outputs", "load_display_blocks", "get_image", "accounts", "list_tasks", "subscribe", "unsubscribe", "load_instructions",
  "load_folder_instructions", "load_tool_instructions", "get_tool_policy", "get_token_stats",
]);

const startedAt = Date.now();
const socket = connect(socketPath);

let up = "";
process.stdin.on("data", (chunk: Buffer) => {
  up += chunk.toString("utf8");
  let newline: number;
  while ((newline = up.indexOf("\n")) >= 0) {
    const line = up.slice(0, newline);
    up = up.slice(newline + 1);
    if (!line.trim()) continue;
    let command: { type?: string; clientHost?: unknown };
    try { command = JSON.parse(line); } catch { log("drop unparsable"); continue; }
    if (!command.type || !READ_ONLY_COMMANDS.has(command.type)) { log(`drop ${command.type}`); continue; }
    if (command.type === "client_capabilities") delete command.clientHost;
    log(`up ${command.type} ${line.length}`);
    socket.write(JSON.stringify(command) + "\n");
  }
});

let down = "";
socket.on("data", (chunk: Buffer) => {
  down += chunk.toString("utf8");
  let out = "";
  let newline: number;
  while ((newline = down.indexOf("\n")) >= 0) {
    const line = down.slice(0, newline);
    down = down.slice(newline + 1);
    if (line.includes('"client_exec_') && /^client_exec_/.test(JSON.parse(line).type ?? "")) { log("drop client_exec event"); continue; }
    if (record) appendFileSync(record, JSON.stringify({ t: Date.now() - startedAt, line }) + "\n");
    out += line + "\n";
  }
  if (out) process.stdout.write(out);
});
socket.on("error", error => { console.error(`readonly-daemon-tap: ${error.message}`); process.exit(1); });
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => { socket.end(); process.exit(0); });
