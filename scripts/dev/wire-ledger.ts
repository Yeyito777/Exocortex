#!/usr/bin/env bun
/**
 * Passive byte ledger for the daemon protocol: what one client receives, per
 * event type, raw and as an SSH -C (zlib stream, flushed per event) would carry it.
 *
 *   bun scripts/dev/wire-ledger.ts [--socket PATH] [--seconds N] [--bootstrap]
 *     [--legacy] [--subscribe CONV_ID] [--jsonl OUT]
 *
 * Read-only by default: it declares the TUI's capabilities and lists the
 * sidebar, then only listens. --bootstrap sends the TUI's ping (provider usage
 * refresh included). --subscribe receives that conversation's stream, but a
 * subscribed client keeps it from being marked unread when a turn ends, so use
 * it only on conversations nobody needs that signal for.
 */
import { connect } from "node:net";
import { appendFileSync } from "node:fs";
import { constants, createDeflate } from "node:zlib";
import { socketPath } from "../../shared/src/paths";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const socket = option("--socket") ?? socketPath();
const seconds = Number(option("--seconds") ?? 60);
const subscribe = option("--subscribe");
const jsonl = option("--jsonl");
const capabilities = flag("--legacy") ? [] : [
  "targeted-unwind", "sidebar-reorder-delta", "sidebar-state-patch", "history-block-pagination",
  "token-stats-on-demand", "sidebar-digest-sync",
];

const deflate = createDeflate({ level: 6 });
let compressed = 0;
deflate.on("data", (chunk: Buffer) => { compressed += chunk.length; });
const totals = new Map<string, { count: number; raw: number; wire: number }>();
let queue = Promise.resolve();
const startedAt = Date.now();

function record(line: Buffer): void {
  queue = queue.then(() => new Promise<void>(done => {
    const type = /"type":"([a-z_]+)"/.exec(line.subarray(0, 200).toString("utf8"))?.[1] ?? "?";
    const before = compressed;
    deflate.write(line);
    deflate.flush(constants.Z_SYNC_FLUSH, () => {
      const wire = compressed - before;
      const total = totals.get(type) ?? { count: 0, raw: 0, wire: 0 };
      total.count++; total.raw += line.length; total.wire += wire;
      totals.set(type, total);
      if (jsonl) appendFileSync(jsonl, `${JSON.stringify({ t: Date.now() - startedAt, type, raw: line.length, wire })}\n`);
      done();
    });
  }));
}

const client = connect(socket);
let pending = Buffer.alloc(0);
client.on("connect", () => {
  const send = (command: object) => client.write(`${JSON.stringify(command)}\n`);
  send({ type: "client_capabilities", capabilities });
  send(flag("--bootstrap") ? { type: "ping" } : { type: "list_conversations" });
  if (subscribe) send({ type: "subscribe", convId: subscribe });
});
client.on("data", (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  let newline: number;
  while ((newline = pending.indexOf(0x0a)) !== -1) {
    record(pending.subarray(0, newline + 1));
    pending = pending.subarray(newline + 1);
  }
});
client.on("error", error => { console.error(error.message); process.exit(1); });

setTimeout(async () => {
  client.destroy();
  await queue;
  const rows = [...totals].sort((a, b) => b[1].wire - a[1].wire);
  const sum = rows.reduce((acc, [, t]) => ({ count: acc.count + t.count, raw: acc.raw + t.raw, wire: acc.wire + t.wire }), { count: 0, raw: 0, wire: 0 });
  console.log(`${seconds}s on ${socket}${flag("--legacy") ? " (legacy client)" : ""}`);
  console.log(`${"event".padEnd(32)}${"count".padStart(7)}${"raw bytes".padStart(12)}${"zlib bytes".padStart(12)}`);
  for (const [type, t] of [...rows, ["TOTAL", sum] as const]) {
    console.log(`${type.padEnd(32)}${String(t.count).padStart(7)}${String(t.raw).padStart(12)}${String(t.wire).padStart(12)}`);
  }
  process.exit(0);
}, seconds * 1000);
