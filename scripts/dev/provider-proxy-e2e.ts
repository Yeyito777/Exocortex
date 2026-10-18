#!/usr/bin/env bun
/**
 * End-to-end test for /proxy (docs/provider-proxy.md), with no real accounts.
 *
 * Starts two isolated daemons from this checkout, a "client" and a "remote",
 * joined by a fake `ssh` on the client's PATH that runs the remote's
 * `exocortexd proxy`. A mock upstream stands in for api.anthropic.com and
 * chatgpt.com (the remote's allowlist points at it in test mode). The client
 * runs the real Claude Code CLI without any login; the remote holds fake
 * credentials the mock checks for.
 *
 * Optional: OLD_EXOCORTEX_ROOT=<checkout without /proxy> also starts a daemon
 * from that checkout as an outdated remote ("oldhost").
 *
 * Usage: bun scripts/dev/provider-proxy-e2e.ts [--keep]
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";

const ROOT = resolve(import.meta.dir, "../..");
const KEEP = process.argv.includes("--keep");
const OLD_ROOT = process.env.OLD_EXOCORTEX_ROOT?.trim() || null;
const work = mkdtempSync(join(tmpdir(), "exo-pp-e2e-"));
const REMOTE_ANTHROPIC_TOKEN = "remote-anthropic-token";
const REMOTE_OPENAI_TOKEN = "remote-openai-token";
const children: Bun.Subprocess[] = [];
const log = (message: string) => console.log(`  ${message}`);

// ── Mock upstream ────────────────────────────────────────────────────

interface Seen { method: string; path: string; authorization: string | null; accountId: string | null; body: string }
const seen: Seen[] = [];
let holdNextAnthropic: (() => void) | null = null;
let anthropicHeld = false;

function sse(events: Array<[string, unknown]>): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function anthropicStream(content: Array<Record<string, unknown>>, stopReason: string): string {
  const events: Array<[string, unknown]> = [["message_start", {
    type: "message_start",
    message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } },
  }]];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return sse(events);
}

/** The remote_bash result, once Claude Code sends it back (its placement varies by CLI version). */
function lastToolResultText(messages: Array<{ role: string; content: unknown }>): string | null {
  for (const message of [...messages].reverse()) {
    if (message.role === "assistant") return null;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.type !== "tool_result") continue;
      const content = part.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map(item => (item as { text?: string }).text ?? "").join("");
    }
  }
  return null;
}

function lastUserText(messages: Array<{ role: string; content: unknown }>): string {
  const last = messages.filter(message => message.role === "user").at(-1);
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return (last.content as Array<Record<string, unknown>>).map(part => typeof part.text === "string" ? part.text : "").join("\n");
}

async function anthropicMessages(request: Request): Promise<Response> {
  const body = await request.json() as { stream?: boolean; messages: Array<{ role: string; content: unknown }> };
  const headers = {
    "content-type": "text/event-stream",
    "anthropic-ratelimit-unified-5h-utilization": "0.37",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3600),
    "anthropic-ratelimit-unified-7d-utilization": "0.12",
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor(Date.now() / 1000) + 86400),
    "anthropic-ratelimit-unified-status": "allowed",
  };
  if (body.stream === false) {
    return Response.json({ id: "msg_plain", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "Title" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  }
  const toolResult = lastToolResultText(body.messages);
  const userText = lastUserText(body.messages);
  if (toolResult !== null) {
    return new Response(anthropicStream([{ type: "text", text: `remote said: ${toolResult.trim()}` }], "end_turn"), { headers });
  }
  if (userText.includes("RUN_REMOTE")) {
    return new Response(anthropicStream([{ type: "tool_use", id: "toolu_remote_1", name: "mcp__exocortex__remote_bash", input: { command: "echo side=$EXO_E2E_SIDE" } }], "tool_use"), { headers });
  }
  if (userText.includes("HOLD")) {
    // A stream that never finishes, to test link loss mid-turn.
    anthropicHeld = true;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(anthropicStream([{ type: "text", text: "partial" }], "end_turn").split("event: message_delta")[0]));
        holdNextAnthropic = () => { try { controller.close(); } catch { /* closed */ } };
      },
    });
    return new Response(stream, { headers });
  }
  return new Response(anthropicStream([{ type: "text", text: "pong from the mock" }], "end_turn"), { headers });
}

function openaiEvents(input: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const id = `resp_${Date.now()}`;
  const output = input.find(item => item.type === "function_call_output");
  const userText = input.filter(item => item.role === "user").map(item => JSON.stringify(item.content)).join("\n");
  let item: Record<string, unknown>;
  if (output) {
    item = { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: `remote said: ${String(output.output).trim()}` }] };
  } else if (userText.includes("RUN_REMOTE")) {
    item = { type: "function_call", id: "fc_1", call_id: "call_remote_1", name: "remote_bash", arguments: JSON.stringify({ command: "echo side=$EXO_E2E_SIDE" }) };
  } else {
    item = { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "pong from the mock" }] };
  }
  return [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, usage: { input_tokens: 10, output_tokens: 3 }, output: [item] } },
  ];
}

const usageHeaders = {
  "x-codex-primary-used-percent": "42",
  "x-codex-primary-window-minutes": "300",
  "x-codex-secondary-used-percent": "7",
  "x-codex-secondary-window-minutes": "10080",
};

const mock = Bun.serve<{ auth: string | null }>({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url);
    const record = (body = "") => seen.push({
      method: request.method, path: url.pathname, body,
      authorization: request.headers.get("authorization"), accountId: request.headers.get("chatgpt-account-id"),
    });
    if (url.pathname === "/backend-api/codex/responses" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      record();
      if (request.headers.get("authorization") !== `Bearer ${REMOTE_OPENAI_TOKEN}`) return new Response("bad token", { status: 401 });
      return server.upgrade(request, { headers: usageHeaders, data: { auth: request.headers.get("authorization") } })
        ? undefined : new Response("upgrade failed", { status: 400 });
    }
    const text = request.method === "POST" ? await request.text() : "";
    record(text);
    if (url.pathname === "/v1/messages") {
      if (request.headers.get("authorization") !== `Bearer ${REMOTE_ANTHROPIC_TOKEN}`) {
        return Response.json({ type: "error", error: { type: "authentication_error", message: "mock: wrong token" } }, { status: 401 });
      }
      return anthropicMessages(new Request(request.url, { method: "POST", body: text, headers: request.headers }));
    }
    if (url.pathname === "/backend-api/codex/responses") {
      if (request.headers.get("authorization") !== `Bearer ${REMOTE_OPENAI_TOKEN}`) return new Response("bad token", { status: 401 });
      const body = JSON.parse(text) as { input: Array<Record<string, unknown>> };
      const events = openaiEvents(body.input ?? []);
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream", ...usageHeaders } });
    }
    if (url.pathname === "/backend-api/codex/models") return Response.json({ models: [] });
    if (url.pathname === "/backend-api/transcribe") {
      if (request.headers.get("authorization") !== `Bearer ${REMOTE_OPENAI_TOKEN}`) return new Response("bad token", { status: 401 });
      if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) return new Response("not multipart", { status: 400 });
      return Response.json({ text: "hello from the mock transcriber" });
    }
    return new Response("not mocked", { status: 404 });
  },
  websocket: {
    message(socket: ServerWebSocket<{ auth: string | null }>, message) {
      const request = JSON.parse(String(message)) as { type: string; input?: Array<Record<string, unknown>> };
      if (request.type !== "response.create") return;
      for (const event of openaiEvents(request.input ?? [])) socket.send(JSON.stringify(event));
    },
  },
});
const MOCK = `http://127.0.0.1:${mock.port}`;

// ── Instances ──────────────────────────────────────────────────────

const dirs = {
  bin: join(work, "bin"),
  remote: join(work, "remote-config"),
  client: join(work, "client-config"),
  old: join(work, "old-config"),
  remoteClaude: join(work, "remote-claude"),
  clientClaude: join(work, "client-claude"),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
const sshLog = join(work, "ssh.log");
/** While this file exists, the fake ssh fails like a Mac whose Wi-Fi dropped. */
const outageFlag = join(work, "network-down");

writeFileSync(join(dirs.bin, "ssh"), `#!/usr/bin/env bash
# Fake ssh: drop options, map the alias to a local daemon, run its proxy.
args=("$@"); i=0; alias=""
while [[ $i -lt \${#args[@]} ]]; do
  a="\${args[$i]}"
  case "$a" in -o) i=$((i+2));; -*) i=$((i+1));; *) alias="$a"; i=$((i+1)); break;; esac
done
echo "$alias \${args[*]:$i}" >> ${JSON.stringify(sshLog)}
if [[ -e ${JSON.stringify(outageFlag)} ]]; then echo "ssh: Could not resolve hostname yeyito.dev: nodename nor servname provided, or not known" >&2; exit 255; fi
case "$alias" in
  fakehost) cd ${JSON.stringify(join(ROOT, "daemon"))} && EXOCORTEX_CONFIG_DIR=${JSON.stringify(dirs.remote)} exec bun run src/main.ts proxy ;;
  oldhost) ${OLD_ROOT ? `cd ${JSON.stringify(join(OLD_ROOT, "daemon"))} && EXOCORTEX_CONFIG_DIR=${JSON.stringify(dirs.old)} exec bun run src/main.ts proxy` : "echo 'no old checkout' >&2; exit 255"} ;;
  *) echo "ssh: Could not resolve hostname $alias: Name or service not known" >&2; exit 255 ;;
esac
`);
writeFileSync(join(dirs.bin, "fake-claude"), `#!/usr/bin/env bash
case "$*" in
  "--version") echo "2.1.295 (Claude Code)" ;;
  "auth status --json") echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"remote@example.com","orgId":"org-remote","subscriptionType":"max"}' ;;
  *) echo "fake claude: $*" >&2; exit 1 ;;
esac
`);
chmodSync(join(dirs.bin, "ssh"), 0o755);
chmodSync(join(dirs.bin, "fake-claude"), 0o755);

const day = Date.now() + 24 * 3600_000;
writeFileSync(join(dirs.remoteClaude, ".credentials.json"), JSON.stringify({
  claudeAiOauth: { accessToken: REMOTE_ANTHROPIC_TOKEN, refreshToken: "never-used", expiresAt: day, scopes: ["user:inference"], subscriptionType: "max" },
}));
mkdirSync(join(dirs.remote, "secrets"), { recursive: true });
writeFileSync(join(dirs.remote, "secrets", "credentials.json"), JSON.stringify({
  version: 2,
  providers: {
    openai: {
      tokens: { accessToken: REMOTE_OPENAI_TOKEN, refreshToken: null, expiresAt: day, scopes: [], subscriptionType: "pro", rateLimitTier: null },
      profile: { accountUuid: "acct-remote", email: "remote@example.com", displayName: null, organizationUuid: null, organizationName: null, organizationType: null, organizationRole: null, workspaceRole: null },
      updatedAt: new Date().toISOString(), source: "oauth", authMode: null, accountId: "acct-remote", idToken: null,
    },
    anthropic: {
      tokens: { accessToken: "", refreshToken: null, expiresAt: Number.MAX_SAFE_INTEGER, scopes: ["claude-code"], subscriptionType: "max", rateLimitTier: null },
      profile: { accountUuid: "org-remote", email: "remote@example.com", displayName: null, organizationUuid: "org-remote", organizationName: null, organizationType: "max", organizationRole: null, workspaceRole: null },
      updatedAt: new Date().toISOString(), source: "claude-code", cliVersion: "2.1.295",
    },
  },
}), { mode: 0o600 });

/** A path as an instance with this config dir resolves it (worktrees namespace runtime paths). */
function instancePath(configDir: string, fn: "socketPath" | "runtimeDir", root = ROOT): string {
  const result = Bun.spawnSync(["bun", "-e", `import { ${fn} } from "./shared/src/paths"; process.stdout.write(${fn}())`], {
    cwd: root, env: { ...process.env, EXOCORTEX_CONFIG_DIR: configDir, EXOCORTEX_TEST: "1" },
  });
  return result.stdout.toString();
}

function socketFor(configDir: string, root = ROOT): string {
  return instancePath(configDir, "socketPath", root);
}

let lastChild: Bun.Subprocess | null = null;
async function startDaemon(name: string, configDir: string, env: Record<string, string>, root = ROOT): Promise<string> {
  const socket = socketFor(configDir, root);
  const logFile = Bun.file(join(work, `${name}.log`));
  const child = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: join(root, "daemon"),
    env: { ...process.env, EXOCORTEX_CONFIG_DIR: configDir, EXOCORTEX_TEST: "1", EXOCORTEX_CLAUDE_RELAY: "0", ...env },
    stdout: logFile, stderr: logFile,
  });
  children.push(child);
  lastChild = child;
  for (let i = 0; i < 150 && !existsSync(socket); i++) await Bun.sleep(100);
  assert(existsSync(socket), `${name} daemon did not start (see ${join(work, `${name}.log`)})`);
  await Bun.sleep(300);
  return socket;
}

// ── IPC ──────────────────────────────────────────────────────────────

class Ipc {
  private buffer = "";
  private serial = 0;
  readonly events: Array<Record<string, any>> = [];
  private waiters: Array<{ match: (event: Record<string, any>) => boolean; resolve: (event: Record<string, any>) => void }> = [];
  private constructor(private readonly socket: net.Socket) {
    socket.on("data", chunk => {
      this.buffer += String(chunk);
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const event = JSON.parse(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
        this.events.push(event);
        for (const waiter of [...this.waiters]) {
          if (waiter.match(event)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            waiter.resolve(event);
          }
        }
      }
    });
  }
  static async connect(path: string): Promise<Ipc> {
    const socket = net.connect(path);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return new Ipc(socket);
  }
  send(command: Record<string, unknown>): void { this.socket.write(`${JSON.stringify(command)}\n`); }
  wait(match: (event: Record<string, any>) => boolean, timeoutMs = 60_000, label = "event"): Promise<Record<string, any>> {
    const existing = this.events.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      this.waiters.push({ match, resolve: event => { clearTimeout(timer); resolve(event); } });
    });
  }
  async request(command: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, any>> {
    const reqId = `e2e-${++this.serial}`;
    const reply = this.wait(event => event.reqId === reqId && event.type !== "ack", timeoutMs, `${String(command.type)} reply`);
    this.send({ ...command, reqId });
    return reply;
  }
  close(): void { this.socket.destroy(); }
}

async function turn(ipc: Ipc, provider: string, model: string, text: string, timeoutMs = 120_000): Promise<{ convId: string; outcome: Record<string, any> }> {
  const created = await ipc.request({ type: "new_conversation", provider, model, title: `e2e ${provider}` });
  assert.equal(created.type, "conversation_created", JSON.stringify(created));
  const convId = created.convId as string;
  ipc.send({ type: "subscribe", convId });
  const since = ipc.events.length;
  ipc.send({ type: "send_message", convId, text, startedAt: Date.now() });
  const outcome = await ipc.wait(event => ipc.events.indexOf(event) >= since && event.convId === convId
    && (event.type === "message_complete" || event.type === "streaming_stopped" || (event.type === "error" && !event.reqId)), timeoutMs, `${provider} turn`);
  return { convId, outcome };
}

function blocksText(blocks: Array<Record<string, any>>): string {
  return blocks.map(block => block.text ?? block.output ?? "").join("\n");
}

async function historyText(ipc: Ipc, convId: string): Promise<string> {
  const loaded = await ipc.request({ type: "load_conversation", convId });
  return JSON.stringify(loaded);
}

/** Drop the link: kill the remote ends of the fake ssh. */
function killRemoteProxies(): void {
  const killed = Bun.spawnSync(["pkill", "-f", `EXOCORTEX_CONFIG_DIR=${dirs.remote}`]);
  // pkill -f matches command lines, not env: kill the remote proxies by their bridge command instead.
  if (killed.exitCode !== 0) Bun.spawnSync(["bash", "-c", `for pid in $(pgrep -f 'src/main.ts proxy'); do if tr '\\0' '\\n' < /proc/$pid/environ 2>/dev/null | grep -qx 'EXOCORTEX_CONFIG_DIR=${dirs.remote}'; then kill $pid; fi; done`]);
}

// ── Run ──────────────────────────────────────────────────────────────

let failed = false;
try {
  log(`work dir ${work}; mock upstream ${MOCK}`);
  const remoteSocket = await startDaemon("remote", dirs.remote, {
    EXOCORTEX_PROVIDER_PROXY_TEST_ORIGINS: JSON.stringify({ anthropic: MOCK, openai: MOCK }),
    OPENAI_CHATGPT_BASE_URL: MOCK,
    CLAUDE_CONFIG_DIR: dirs.remoteClaude,
    CLAUDE_CODE_BIN: join(dirs.bin, "fake-claude"),
    EXO_E2E_SIDE: "remote",
  });
  if (OLD_ROOT) await startDaemon("old", dirs.old, {}, OLD_ROOT);
  const clientEnv = {
    PATH: `${dirs.bin}:${process.env.PATH}`,
    CLAUDE_CONFIG_DIR: dirs.clientClaude,
    EXO_E2E_SIDE: "client",
  };
  const clientSocket = await startDaemon("client", dirs.client, clientEnv);
  let clientChild = lastChild!;
  let ipc = await Ipc.connect(clientSocket);
  assert.equal((await ipc.request({ type: "ping" })).type, "pong");
  const boot = await ipc.wait(event => event.type === "tools_available", 10_000, "bootstrap");
  assert.deepEqual(boot.providerProxies, [], "a daemon without proxies reports an empty list");
  assert.equal(boot.authByProvider.openai, false, "the client has no OpenAI login of its own");

  // Validation errors.
  const unreachable = await ipc.request({ type: "provider_proxy", action: "set", provider: "anthropic", alias: "deadhost" });
  assert.equal(unreachable.error, true);
  assert.match(unreachable.message, /Could not reach the Exocortex daemon on deadhost over SSH.*Could not resolve hostname/s);
  assert.deepEqual(unreachable.proxies, []);
  log(`✓ unreachable alias: ${unreachable.message.split("\n")[0]}`);
  const badProvider = await ipc.request({ type: "provider_proxy", action: "set", provider: "deepseek", alias: "fakehost" });
  assert.match(badProvider.message, /Only openai and anthropic/);
  const badAlias = await ipc.request({ type: "provider_proxy", action: "set", provider: "openai", alias: "-oProxyCommand=x" });
  assert.match(badAlias.message, /SSH alias may contain only/);
  log("✓ provider and alias validation");
  if (OLD_ROOT) {
    const outdated = await ipc.request({ type: "provider_proxy", action: "set", provider: "openai", alias: "oldhost" });
    assert.equal(outdated.error, true);
    assert.match(outdated.message, /does not support \/proxy; update Exocortex there/);
    log(`✓ outdated remote: ${outdated.message}`);
  }

  // Anthropic through the remote's (fake) Claude login, with the real Claude Code CLI locally.
  const setAnthropic = await ipc.request({ type: "provider_proxy", action: "set", provider: "anthropic", alias: "fakehost" });
  assert.ok(!setAnthropic.error, setAnthropic.message);
  assert.equal(setAnthropic.proxies[0].state, "connected");
  assert.equal(setAnthropic.proxies[0].remoteAccount, "remote@example.com");
  log(`✓ /proxy anthropic fakehost: ${setAnthropic.message}`);
  const config = JSON.parse(readFileSync(join(dirs.client, "config.json"), "utf8"));
  assert.deepEqual(config.providers.anthropic.proxy, { ssh: "fakehost" }, "the setting persists in config.json");

  const anthropic = await turn(ipc, "anthropic", "claude-haiku-5-5", "hello");
  assert.equal(anthropic.outcome.type, "message_complete", JSON.stringify(anthropic.outcome));
  assert.match(blocksText(anthropic.outcome.blocks), /pong from the mock/);
  const anthropicRequests = seen.filter(request => request.path === "/v1/messages");
  assert.ok(anthropicRequests.length > 0);
  assert.ok(anthropicRequests.every(request => request.authorization === `Bearer ${REMOTE_ANTHROPIC_TOKEN}`), "upstream saw only the remote's token");
  log(`✓ anthropic turn through the proxy (${anthropicRequests.length} upstream request(s), remote token only)`);
  const anthropicUsage = await ipc.wait(event => event.type === "usage_update" && event.provider === "anthropic" && event.usage?.fiveHour, 20_000, "anthropic usage");
  assert.equal(Math.round(anthropicUsage.usage.fiveHour.utilization), 37);
  log("✓ anthropic usage bars show the remote account (37%)");

  const anthropicTool = await turn(ipc, "anthropic", "claude-haiku-5-5", "RUN_REMOTE please");
  assert.equal(anthropicTool.outcome.type, "message_complete", JSON.stringify(anthropicTool.outcome));
  assert.match(blocksText(anthropicTool.outcome.blocks), /remote said: side=remote/);
  assert.match(await historyText(ipc, anthropicTool.convId), /remote_bash/);
  log("✓ Claude route: mcp__exocortex__remote_bash ran on the remote (side=remote)");

  // OpenAI over the Responses websocket, through the same link.
  const setOpenAI = await ipc.request({ type: "provider_proxy", action: "set", provider: "openai", alias: "fakehost" });
  assert.ok(!setOpenAI.error, setOpenAI.message);
  const openai = await turn(ipc, "openai", "gpt-6-astra", "RUN_REMOTE please");
  assert.equal(openai.outcome.type, "message_complete", JSON.stringify(openai.outcome));
  assert.match(blocksText(openai.outcome.blocks), /remote said: side=remote/);
  const wsRequests = seen.filter(request => request.path === "/backend-api/codex/responses");
  assert.ok(wsRequests.length > 0);
  assert.ok(wsRequests.every(request => request.authorization === `Bearer ${REMOTE_OPENAI_TOKEN}` && request.accountId === "acct-remote"));
  log(`✓ openai turn with remote_bash through the proxy (${wsRequests.length} upstream request(s), remote token + account id)`);
  const openaiUsage = await ipc.wait(event => event.type === "usage_update" && event.provider === "openai" && event.usage?.fiveHour, 20_000, "openai usage");
  assert.equal(Math.round(openaiUsage.usage.fiveHour.utilization), 42);
  log("✓ openai usage bars show the remote account (42%)");
  const transcribed = await ipc.request({ type: "transcribe_audio", audioBase64: Buffer.from("RIFF0000WAVEfake").toString("base64"), mimeType: "audio/wav" });
  assert.equal(transcribed.text, "hello from the mock transcriber", JSON.stringify(transcribed));
  log("✓ hold-to-talk transcription goes through the proxy");

  // Link loss mid-turn fails the turn instead of hanging, and the link comes back.
  const held = turn(ipc, "anthropic", "claude-haiku-5-5", "HOLD this", 180_000);
  for (let i = 0; i < 300 && !anthropicHeld; i++) await Bun.sleep(100);
  assert.ok(anthropicHeld, "the held request reached the mock");
  killRemoteProxies();
  const startedWaiting = Date.now();
  const heldResult = await held;
  holdNextAnthropic?.();
  const settledIn = Math.round((Date.now() - startedWaiting) / 1000);
  // Like any dropped connection: Claude Code either retries (over the
  // reconnected link) or the turn fails. Either way it must not hang.
  assert.ok(settledIn < 90, `the turn settled ${settledIn}s after the link dropped`);
  const heldRequests = seen.filter(request => request.path === "/v1/messages" && request.body.includes("HOLD")).length;
  const retried = heldResult.outcome.type === "message_complete";
  if (retried) assert.ok(heldRequests >= 2, "a completed turn after a dropped link means Claude Code retried");
  log(`✓ link loss mid-turn: ${retried ? `Claude Code retried over the reconnected link (${heldRequests} attempts)` : `the turn failed (${heldResult.outcome.type})`} after ${settledIn}s; no hang`);
  const recovered = await turn(ipc, "anthropic", "claude-haiku-5-5", "hello again");
  assert.equal(recovered.outcome.type, "message_complete", JSON.stringify(recovered.outcome));
  log("✓ the link reconnected and the next turn worked");

  // A network blip (DNS fails, ssh exits 255) shorter than the forwarder's
  // hold: the turn only sees latency.
  writeFileSync(outageFlag, "");
  killRemoteProxies();
  const blipStarted = Date.now();
  const blip = turn(ipc, "anthropic", "claude-haiku-5-5", "hello through a blip", 180_000);
  await Bun.sleep(6_000);
  rmSync(outageFlag);
  const blipResult = await blip;
  assert.equal(blipResult.outcome.type, "message_complete", JSON.stringify(blipResult.outcome));
  assert.ok(!ipc.events.some(event => event.convId === blipResult.convId && event.type === "connection_wait_status"), "a short blip shows no wait");
  log(`✓ a ${Math.round((Date.now() - blipStarted) / 1000)}s network blip is held by the forwarder; the turn just completes`);

  // A longer outage: past the hold, the turn waits visibly, then resumes the same turn.
  writeFileSync(outageFlag, "");
  killRemoteProxies();
  const outageStarted = Date.now();
  const outage = turn(ipc, "anthropic", "claude-haiku-5-5", "hello through an outage", 600_000);
  const waiting = await ipc.wait(event => event.type === "connection_wait_status" && event.active === true, 150_000, "the /proxy wait");
  const waitShownAfter = Math.round((Date.now() - outageStarted) / 1000);
  assert.equal(waiting.label, "Waiting for network / fakehost…");
  // Claude Code did not retry the 503 itself (each retry would be held again).
  assert.ok(waitShownAfter < 90, `the wait showed after ${waitShownAfter}s`);
  await Bun.sleep(8_000);
  rmSync(outageFlag);
  const outageResult = await outage;
  assert.equal(outageResult.outcome.type, "message_complete", JSON.stringify(outageResult.outcome));
  assert.ok(ipc.events.some(event => event.convId === outageResult.convId && event.type === "connection_wait_status" && event.active === false));
  const outageHistory = await historyText(ipc, outageResult.convId);
  assert.equal(outageHistory.split("hello through an outage").length - 1, 1, "the user's message is stored once");
  assert.doesNotMatch(outageHistory, /API Error|link down/, "no error reached the transcript");
  log(`✓ a longer outage shows "${waiting.label}" after ${waitShownAfter}s, then the same turn resumes (${Math.round((Date.now() - outageStarted) / 1000)}s total)`);

  // The setting survives a daemon restart, and the forwarder keeps its port.
  const forwarderState = join(instancePath(dirs.client, "runtimeDir"), "provider-proxy.json");
  const portBefore = JSON.parse(readFileSync(forwarderState, "utf8")).port;
  ipc.close();
  clientChild.kill("SIGTERM");
  await clientChild.exited;
  await startDaemon("client-restarted", dirs.client, clientEnv);
  clientChild = lastChild!;
  ipc = await Ipc.connect(clientSocket);
  assert.equal((await ipc.request({ type: "ping" })).type, "pong");
  const rebooted = await ipc.wait(event => event.type === "tools_available", 10_000, "bootstrap after restart");
  assert.deepEqual(rebooted.providerProxies.map((proxy: { provider: string; alias: string }) => `${proxy.provider}:${proxy.alias}`).sort(), ["anthropic:fakehost", "openai:fakehost"]);
  const afterRestart = await turn(ipc, "anthropic", "claude-haiku-5-5", "hello after restart");
  assert.equal(afterRestart.outcome.type, "message_complete", JSON.stringify(afterRestart.outcome));
  const portAfter = JSON.parse(readFileSync(forwarderState, "utf8")).port;
  assert.equal(portAfter, portBefore);
  log(`✓ proxies persist across a daemon restart (forwarder port ${portAfter} kept) and work at once`);

  // Off: back to the local (absent) login; remote_bash leaves the tool list.
  const off = await ipc.request({ type: "provider_proxy", action: "off", provider: "openai" });
  assert.match(off.message, /no longer goes through fakehost/);
  const status = await ipc.request({ type: "provider_proxy", action: "status" });
  assert.deepEqual(status.proxies.map((proxy: { provider: string }) => proxy.provider), ["anthropic"]);
  const direct = await turn(ipc, "openai", "gpt-6-astra", "hello", 60_000);
  assert.notEqual(direct.outcome.type, "message_complete", "openai without a local login fails once the proxy is off");
  log("✓ /proxy openai off restores the direct route (no local login → the turn fails)");
  const offAnthropic = await ipc.request({ type: "provider_proxy", action: "off", provider: "anthropic" });
  assert.ok(!offAnthropic.error);
  const sshCalls = readFileSync(sshLog, "utf8").trim().split("\n");
  assert.ok(sshCalls.every(line => line.endsWith("exocortexd proxy")), "ssh always runs exocortexd proxy");
  log(`✓ ssh invocations: ${sshCalls.length}, all \`exocortexd proxy\``);
  ipc.close();
  void remoteSocket;
  console.log("PASS: provider-proxy e2e");
} catch (error) {
  failed = true;
  console.error("FAIL:", error instanceof Error ? error.stack ?? error.message : error);
  console.error(`  logs in ${work}`);
} finally {
  for (const child of children) child.kill();
  await Promise.all(children.map(child => child.exited));
  mock.stop(true);
  if (!KEEP && !failed) rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
