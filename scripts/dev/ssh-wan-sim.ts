#!/usr/bin/env bun
/**
 * Stand-in for `ssh ALIAS exocortexd proxy` that runs this checkout's proxy
 * locally behind a simulated WAN link, so /ssh behaviour can be measured
 * against a worktree daemon without a second machine.
 *
 * Install as `ssh` on PATH for the TUI (or a scripted DaemonClient):
 *   printf '#!/bin/sh\nexec bun %s "$@"\n' "$PWD/scripts/dev/ssh-wan-sim.ts" > /tmp/wan/ssh
 *   chmod +x /tmp/wan/ssh; PATH=/tmp/wan:$PATH bun run tui/src/main.ts --ssh anyhost
 *
 * Environment:
 *   WAN_ONE_WAY_MS   one-way delay (default 50, i.e. 100 ms RTT)
 *   WAN_BYTES_PER_SEC link rate after compression (default 2.5 MB/s = 20 Mbit/s)
 *   WAN_LOSS         per-1460-byte-segment loss probability (default 0)
 *   WAN_RTO_MS       stall per lost segment; later data waits behind it (default 300)
 *   WAN_LEDGER       JSONL file: one row per forwarded write (dir, event type, raw, wire bytes, delay)
 *   WAN_STRIP_CAPS   comma-separated client capabilities to remove, emulating an older TUI
 *   WAN_PROXY_ENTRY  the daemon's proxy entry (default src/proxy-main.ts; "src/main.ts proxy" before Oct 2026)
 *   WAN_HANDSHAKE_RTTS round trips OpenSSH spends before the remote command runs
 *                    (TCP, key exchange, auth, channel; about 6 without ControlMaster).
 *                    Default 0: the proxy starts at once
 *
 * Bytes are compressed like SSH -C (one zlib stream per direction, flushed per
 * write); the link time uses those compressed sizes plus framing.
 */
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { constants, createDeflate } from "node:zlib";

const env = process.env;
const oneWayMs = Number(env.WAN_ONE_WAY_MS ?? 50);
const bytesPerSec = Number(env.WAN_BYTES_PER_SEC ?? 2_500_000);
const loss = Number(env.WAN_LOSS ?? 0);
const rtoMs = Number(env.WAN_RTO_MS ?? 300);
const ledger = env.WAN_LEDGER;
const stripCaps = (env.WAN_STRIP_CAPS ?? "").split(",").filter(Boolean);
const repo = resolve(import.meta.dir, "../..");
const handshakeMs = Number(env.WAN_HANDSHAKE_RTTS ?? 0) * 2 * oneWayMs;
const startedAt = Date.now();

// The remote command starts once the handshake is done; input written before
// then waits in the up link (see its linkFreeAt).
const proxyCommand = ["bun", "run", ...(env.WAN_PROXY_ENTRY ?? "src/proxy-main.ts").split(" ")];
const proxy = handshakeMs > 0
  ? spawn("bash", ["-c", `sleep ${handshakeMs / 1000}; exec "$@"`, "proxy", ...proxyCommand], { cwd: `${repo}/daemon`, stdio: ["pipe", "pipe", "inherit"] })
  : spawn(proxyCommand[0]!, proxyCommand.slice(1), { cwd: `${repo}/daemon`, stdio: ["pipe", "pipe", "inherit"] });

const eventType = (data: Buffer) => /"type":"([a-z_]+)"/.exec(data.subarray(0, 200).toString("utf8"))?.[1] ?? "?";

function link(dir: "down" | "up", deliver: (data: Buffer) => void): (data: Buffer) => void {
  const deflate = createDeflate({ level: 6 });
  let compressed = 0;
  deflate.on("data", (chunk: Buffer) => { compressed += chunk.length; });
  let linkFreeAt = dir === "up" ? startedAt + handshakeMs : 0;
  let lastDelivery = 0;
  let queue = Promise.resolve();
  return data => {
    queue = queue.then(() => new Promise<void>(done => {
      const before = compressed;
      deflate.write(data);
      deflate.flush(constants.Z_SYNC_FLUSH, () => {
        const wire = compressed - before + 48; // SSH packet + TCP/IP framing
        const now = Date.now();
        const start = Math.max(now, linkFreeAt);
        linkFreeAt = start + wire / bytesPerSec * 1000;
        let stall = 0;
        for (let segment = 0; segment < Math.ceil(wire / 1460); segment++) if (Math.random() < loss) stall += rtoMs;
        // TCP delivers in order: nothing overtakes a stalled earlier write.
        const at = Math.max(lastDelivery, linkFreeAt + oneWayMs + stall);
        lastDelivery = at;
        if (ledger) appendFileSync(ledger, `${JSON.stringify({ t: now - startedAt, pid: process.pid, dir, type: eventType(data), raw: data.length, wire, delay: Math.round(at - now), stall })}\n`);
        setTimeout(() => deliver(data), at - now);
        done();
      });
    }));
  };
}

const down = link("down", data => process.stdout.write(data));
const up = link("up", data => proxy.stdin.write(data));

// Forward the daemon stream one JSON line at a time so each write is one event.
let pending = Buffer.alloc(0);
proxy.stdout.on("data", (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  let newline: number;
  while ((newline = pending.indexOf(0x0a)) !== -1) {
    down(pending.subarray(0, newline + 1));
    pending = pending.subarray(newline + 1);
  }
});
process.stdin.on("data", (chunk: Buffer) => {
  if (stripCaps.length === 0) return up(chunk);
  let text = chunk.toString("utf8");
  for (const cap of stripCaps) text = text.replaceAll(`,"${cap}"`, "").replaceAll(`"${cap}",`, "").replaceAll(`"${cap}"`, "");
  up(Buffer.from(text));
});
process.stdin.on("end", () => setTimeout(() => proxy.stdin.end(), oneWayMs));
proxy.on("exit", code => setTimeout(() => process.exit(code ?? 0), oneWayMs + 50));
process.on("SIGTERM", () => { proxy.kill(); process.exit(0); });
