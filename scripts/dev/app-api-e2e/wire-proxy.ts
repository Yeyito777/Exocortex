// Logging reverse proxy (HTTP + WebSocket) for verifying what the daemon and
// Claude Code really send to a provider (app API e2e only; run.sh points the
// test daemon's provider base URLs here).
// Usage: bun wire-proxy.ts <port> <logfile> <upstream-origin>
import { appendFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";

const port = Number(process.argv[2]);
const logFile = process.argv[3]!;
const upstream = (process.argv[4] ?? "https://api.anthropic.com").replace(/\/+$/, "");

function record(path: string, raw: string): void {
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const body = (json.type === "response.create" && json.response && typeof json.response === "object" ? json.response : json) as Record<string, unknown>;
    if (!("system" in body) && !("instructions" in body) && !("tools" in body)) return;
    appendFileSync(logFile, JSON.stringify({
      at: Date.now(),
      path,
      system: body.system ?? body.instructions ?? null,
      tools: Array.isArray(body.tools) ? body.tools.map((tool: { name?: string; type?: string }) => tool.name ?? tool.type) : [],
      input: JSON.stringify(body.messages ?? body.input ?? null).slice(0, 6000),
    }) + "\n");
  } catch { /* not JSON */ }
}

interface Socket { upstream: WebSocket; queue: (string | Buffer)[]; path: string }

Bun.serve<Socket, never>({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (process.env.WIRE_VERBOSE) console.log(`${req.method} ${url.pathname} upgrade=${req.headers.get("upgrade")} encoding=${req.headers.get("content-encoding")}`);
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => {
        if (!/^(host|upgrade|connection|sec-websocket-(key|version|extensions|accept))$/i.test(key)) headers[key] = value;
      });
      const target = upstream.replace(/^http/, "ws") + url.pathname + url.search;
      const socket = new WebSocket(target, { headers } as unknown as string[]);
      const data: Socket = { upstream: socket, queue: [], path: url.pathname };
      return server.upgrade(req, { data }) ? undefined : new Response("upgrade failed", { status: 500 });
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    if (body) record(url.pathname, new TextDecoder().decode(body));
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("accept-encoding");
    const res = await fetch(upstream + url.pathname + url.search, { method: req.method, headers, body, redirect: "manual" });
    const out = new Headers(res.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(res.body, { status: res.status, headers: out });
  },
  websocket: {
    open(ws: ServerWebSocket<Socket>) {
      const { upstream: socket } = ws.data;
      socket.onopen = () => { for (const message of ws.data.queue.splice(0)) socket.send(message); };
      socket.onmessage = event => ws.send(event.data as string);
      socket.onclose = event => ws.close(event.code === 1005 ? 1000 : event.code, event.reason);
      socket.onerror = () => ws.close(1011, "upstream error");
    },
    message(ws: ServerWebSocket<Socket>, message) {
      if (typeof message === "string") record(ws.data.path, message);
      if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(message);
      else ws.data.queue.push(message);
    },
    close(ws: ServerWebSocket<Socket>) {
      try { ws.data.upstream.close(); } catch { /* gone */ }
    },
  },
});
console.log(`wire-proxy on ${port} -> ${upstream}`);
