#!/usr/bin/env bun
/**
 * End-to-end test for client_bash and remote_bash over a /proxy link
 * (docs/provider-proxy.md), with no real accounts and no second machine.
 *
 * Two isolated daemons from this checkout: "mac" (the user's laptop) proxies
 * Anthropic to "whale" through a fake `ssh` that runs whale's
 * `exocortexd proxy`. Each daemon's commands print which side they ran on
 * (EXO_E2E_SIDE). A mock upstream plays the model: whale's own conversations
 * use OpenAI with whale's (fake) login, the mac's use Anthropic through the
 * proxy with the real Claude Code CLI.
 *
 * Covers: whale's client_bash runs on the mac over the link with no TUI, for
 * a conversation and a subagent; the mac's remote_bash runs on whale, for a
 * conversation and a subagent; a long command stays alive on heartbeats; a
 * frozen mac daemon fails fast; with the link down a TUI connected over /ssh
 * takes over, and a frozen TUI fails fast; with neither, the call fails at
 * once; the relinked daemon is preferred over the TUI again.
 *
 * Usage: bun scripts/dev/client-exec-e2e.ts [--keep]
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import { hostname, homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";

const ROOT = resolve(import.meta.dir, "../..");
const KEEP = process.argv.includes("--keep");
const work = mkdtempSync(join(tmpdir(), "exo-client-exec-e2e-"));
const WHALE_ANTHROPIC_TOKEN = "whale-anthropic-token";
const WHALE_OPENAI_TOKEN = "whale-openai-token";
const children: Bun.Subprocess[] = [];
const log = (message: string) => console.log(`  ${message}`);

// ── Mock upstream ────────────────────────────────────────────────────
// "RUN_CLIENT:: <command>" (OpenAI) calls client_bash and "RUN_REMOTE:: <command>"
// (Anthropic) calls remote_bash, with "TIMEOUT:: <s>" as timeout_seconds; the
// next turn echoes the tool result as "tool said: …".

function commandIn(text: string, marker: string): { command: string; timeout?: number } | null {
  const match = text.match(new RegExp(`${marker}:: ([^\\n"]*?)(?: TIMEOUT:: (\\d+))?(?:"|\\n|$)`));
  return match ? { command: match[1].trim(), ...(match[2] ? { timeout: Number(match[2]) } : {}) } : null;
}

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

let toolSerial = 0;
async function anthropicMessages(body: { stream?: boolean; messages: Array<{ role: string; content: unknown }> }): Promise<Response> {
  const headers = { "content-type": "text/event-stream" };
  if (body.stream === false) {
    return Response.json({ id: "msg_plain", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "Title" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
  }
  const toolResult = lastToolResultText(body.messages);
  if (toolResult !== null) return new Response(anthropicStream([{ type: "text", text: `tool said: ${toolResult.trim()}` }], "end_turn"), { headers });
  const run = commandIn(lastUserText(body.messages), "RUN_REMOTE");
  if (run) {
    const input = { command: run.command, ...(run.timeout ? { timeout_seconds: run.timeout } : {}) };
    return new Response(anthropicStream([{ type: "tool_use", id: `toolu_e2e_${++toolSerial}`, name: "mcp__exocortex__remote_bash", input }], "tool_use"), { headers });
  }
  return new Response(anthropicStream([{ type: "text", text: "pong from the mock" }], "end_turn"), { headers });
}

function openaiEvents(input: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const id = `resp_${Date.now()}`;
  const lastUser = [...input].reverse().findIndex(item => item.role === "user");
  const sinceUser = lastUser < 0 ? input : input.slice(input.length - 1 - lastUser);
  const output = sinceUser.find(item => item.type === "function_call_output");
  const userText = sinceUser.filter(item => item.role === "user").map(item => JSON.stringify(item.content)).join("\n");
  let item: Record<string, unknown>;
  const run = commandIn(userText, "RUN_CLIENT");
  if (output) {
    item = { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: `tool said: ${String(output.output).trim()}` }] };
  } else if (run) {
    const args = { command: run.command.replace(/\\"/g, "\""), ...(run.timeout ? { timeout_seconds: run.timeout } : {}) };
    item = { type: "function_call", id: `fc_${++toolSerial}`, call_id: `call_e2e_${toolSerial}`, name: "client_bash", arguments: JSON.stringify(args) };
  } else {
    item = { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "pong from the mock" }] };
  }
  return [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, usage: { input_tokens: 10, output_tokens: 3 }, output: [item] } },
  ];
}

const mock = Bun.serve<{ auth: string | null }>({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/backend-api/codex/responses" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (request.headers.get("authorization") !== `Bearer ${WHALE_OPENAI_TOKEN}`) return new Response("bad token", { status: 401 });
      return server.upgrade(request, { data: { auth: request.headers.get("authorization") } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    const text = request.method === "POST" ? await request.text() : "";
    if (url.pathname === "/v1/messages") {
      if (request.headers.get("authorization") !== `Bearer ${WHALE_ANTHROPIC_TOKEN}`) {
        return Response.json({ type: "error", error: { type: "authentication_error", message: "mock: wrong token" } }, { status: 401 });
      }
      return anthropicMessages(JSON.parse(text));
    }
    if (url.pathname === "/backend-api/codex/responses") {
      if (request.headers.get("authorization") !== `Bearer ${WHALE_OPENAI_TOKEN}`) return new Response("bad token", { status: 401 });
      const body = JSON.parse(text) as { input: Array<Record<string, unknown>> };
      const events = openaiEvents(body.input ?? []);
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/backend-api/codex/models") return Response.json({ models: [] });
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
  whale: join(work, "whale-config"),
  mac: join(work, "mac-config"),
  whaleClaude: join(work, "whale-claude"),
  macClaude: join(work, "mac-claude"),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

writeFileSync(join(dirs.bin, "ssh"), `#!/usr/bin/env bash
# Fake ssh: drop options, map the alias to whale's daemon, run its proxy.
args=("$@"); i=0; alias=""
while [[ $i -lt \${#args[@]} ]]; do
  a="\${args[$i]}"
  case "$a" in -o) i=$((i+2));; -*) i=$((i+1));; *) alias="$a"; i=$((i+1)); break;; esac
done
case "$alias" in
  fakewhale) cd ${JSON.stringify(join(ROOT, "daemon"))} && EXOCORTEX_CONFIG_DIR=${JSON.stringify(dirs.whale)} exec bun run src/main.ts proxy ;;
  *) echo "ssh: Could not resolve hostname $alias: Name or service not known" >&2; exit 255 ;;
esac
`);
writeFileSync(join(dirs.bin, "fake-claude"), `#!/usr/bin/env bash
case "$*" in
  "--version") echo "2.1.295 (Claude Code)" ;;
  "auth status --json") echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"whale@example.com","orgId":"org-whale","subscriptionType":"max"}' ;;
  *) echo "fake claude: $*" >&2; exit 1 ;;
esac
`);
chmodSync(join(dirs.bin, "ssh"), 0o755);
chmodSync(join(dirs.bin, "fake-claude"), 0o755);

const day = Date.now() + 24 * 3600_000;
writeFileSync(join(dirs.whaleClaude, ".credentials.json"), JSON.stringify({
  claudeAiOauth: { accessToken: WHALE_ANTHROPIC_TOKEN, refreshToken: "never-used", expiresAt: day, scopes: ["user:inference"], subscriptionType: "max" },
}));
mkdirSync(join(dirs.whale, "secrets"), { recursive: true });
writeFileSync(join(dirs.whale, "secrets", "credentials.json"), JSON.stringify({
  version: 2,
  providers: {
    openai: {
      tokens: { accessToken: WHALE_OPENAI_TOKEN, refreshToken: null, expiresAt: day, scopes: [], subscriptionType: "pro", rateLimitTier: null },
      profile: { accountUuid: "acct-whale", email: "whale@example.com", displayName: null, organizationUuid: null, organizationName: null, organizationType: null, organizationRole: null, workspaceRole: null },
      updatedAt: new Date().toISOString(), source: "oauth", authMode: null, accountId: "acct-whale", idToken: null,
    },
    anthropic: {
      tokens: { accessToken: "", refreshToken: null, expiresAt: Number.MAX_SAFE_INTEGER, scopes: ["claude-code"], subscriptionType: "max", rateLimitTier: null },
      profile: { accountUuid: "org-whale", email: "whale@example.com", displayName: null, organizationUuid: "org-whale", organizationName: null, organizationType: "max", organizationRole: null, workspaceRole: null },
      updatedAt: new Date().toISOString(), source: "claude-code", cliVersion: "2.1.295",
    },
  },
}), { mode: 0o600 });

function socketFor(configDir: string): string {
  const result = Bun.spawnSync(["bun", "-e", `import { socketPath } from "./shared/src/paths"; process.stdout.write(socketPath())`], {
    cwd: ROOT, env: { ...process.env, EXOCORTEX_CONFIG_DIR: configDir, EXOCORTEX_TEST: "1" },
  });
  return result.stdout.toString();
}

async function startDaemon(name: string, configDir: string, env: Record<string, string>): Promise<{ socket: string; child: Bun.Subprocess }> {
  const socket = socketFor(configDir);
  const logFile = Bun.file(join(work, `${name}.log`));
  const child = Bun.spawn(["bun", "run", "src/main.ts"], {
    cwd: join(ROOT, "daemon"),
    env: { ...process.env, EXOCORTEX_CONFIG_DIR: configDir, EXOCORTEX_TEST: "1", EXOCORTEX_CLAUDE_RELAY: "0", ...env },
    stdout: logFile, stderr: logFile,
  });
  children.push(child);
  for (let i = 0; i < 150 && !existsSync(socket); i++) await Bun.sleep(100);
  assert(existsSync(socket), `${name} daemon did not start (see ${join(work, `${name}.log`)})`);
  await Bun.sleep(300);
  return { socket, child };
}

// ── IPC ──────────────────────────────────────────────────────────────

class Ipc {
  private buffer = "";
  private serial = 0;
  readonly events: Array<Record<string, any>> = [];
  private waiters: Array<{ match: (event: Record<string, any>) => boolean; resolve: (event: Record<string, any>) => void }> = [];
  /** Called for every event (the fake TUI answers client_exec_request here). */
  onEvent: ((event: Record<string, any>) => void) | null = null;
  private constructor(private readonly socket: net.Socket) {
    socket.on("data", chunk => {
      this.buffer += String(chunk);
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const event = JSON.parse(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
        this.events.push(event);
        this.onEvent?.(event);
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

interface TurnResult { convId: string; text: string; seconds: number }

/** One turn in a new conversation (a subagent's with `subagent`); the final text holds "tool said: …". */
async function turn(ipc: Ipc, provider: string, model: string, text: string, options: { subagent?: boolean; timeoutMs?: number } = {}): Promise<TurnResult> {
  const created = await ipc.request({ type: "new_conversation", provider, model, title: `e2e ${provider}`, ...(options.subagent ? { subagent: true } : {}) });
  assert.equal(created.type, "conversation_created", JSON.stringify(created));
  const convId = created.convId as string;
  ipc.send({ type: "subscribe", convId });
  const since = ipc.events.length;
  const started = Date.now();
  ipc.send({ type: "send_message", convId, text, startedAt: Date.now() });
  const outcome = await ipc.wait(event => ipc.events.indexOf(event) >= since && event.convId === convId
    && (event.type === "message_complete" || event.type === "streaming_stopped" || (event.type === "error" && !event.reqId)), options.timeoutMs ?? 120_000, `${provider} turn`);
  assert.equal(outcome.type, "message_complete", JSON.stringify(outcome));
  const final = (outcome.blocks as Array<Record<string, any>>).map(block => block.text ?? "").join("\n");
  return { convId, text: final, seconds: (Date.now() - started) / 1000 };
}

/** A TUI connected to whale over /ssh, as far as whale can tell: it announces the machine and runs commands. */
async function fakeTui(socket: string, behaviour: { frozen: boolean }): Promise<{ ipc: Ipc; ran: string[] }> {
  const ipc = await Ipc.connect(socket);
  const ran: string[] = [];
  ipc.onEvent = event => {
    if (event.type !== "client_exec_request" || behaviour.frozen) return;
    ran.push(event.command);
    ipc.send({ type: "client_exec_alive", execIds: [event.execId] });
    const result = Bun.spawnSync(["bash", "-c", event.command], { env: { ...process.env, EXO_E2E_SIDE: "mac-tui" } });
    ipc.send({ type: "client_exec_result", execId: event.execId, output: result.stdout.toString() + result.stderr.toString(), byteTruncated: false, exitCode: result.exitCode, signal: null, timedOut: false });
  };
  let user = "";
  try { user = userInfo().username; } catch { /* none */ }
  ipc.send({ type: "client_capabilities", capabilities: ["client-exec-alive"], clientHost: { hostname: hostname(), user, platform: process.platform, home: homedir() } });
  assert.equal((await ipc.request({ type: "ping" })).type, "pong");
  return { ipc, ran };
}

// ── Run ──────────────────────────────────────────────────────────────

let failed = false;
try {
  log(`work dir ${work}; mock upstream ${MOCK}`);
  const whale = await startDaemon("whale", dirs.whale, {
    EXOCORTEX_PROVIDER_PROXY_TEST_ORIGINS: JSON.stringify({ anthropic: MOCK, openai: MOCK }),
    OPENAI_CHATGPT_BASE_URL: MOCK,
    CLAUDE_CONFIG_DIR: dirs.whaleClaude,
    CLAUDE_CODE_BIN: join(dirs.bin, "fake-claude"),
    EXO_E2E_SIDE: "whale",
  });
  const mac = await startDaemon("mac", dirs.mac, {
    PATH: `${dirs.bin}:${process.env.PATH}`,
    CLAUDE_CONFIG_DIR: dirs.macClaude,
    EXO_E2E_SIDE: "mac",
  });
  const whaleIpc = await Ipc.connect(whale.socket);
  const macIpc = await Ipc.connect(mac.socket);
  assert.equal((await whaleIpc.request({ type: "ping" })).type, "pong");
  assert.equal((await macIpc.request({ type: "ping" })).type, "pong");

  // Nothing linked yet: whale's client_bash fails at once.
  const none = await turn(whaleIpc, "openai", "gpt-6-astra", "RUN_CLIENT:: echo side=$EXO_E2E_SIDE");
  assert.match(none.text, /The user's machine is not connected/);
  assert.ok(none.seconds < 10, `took ${none.seconds}s`);
  log(`✓ nothing connected: client_bash fails at once (${none.seconds.toFixed(1)}s turn)`);

  const linked = await macIpc.request({ type: "provider_proxy", action: "set", provider: "anthropic", alias: "fakewhale" });
  assert.ok(!linked.error, linked.message);
  assert.equal(linked.proxies[0].state, "connected");
  log("✓ mac: /proxy anthropic fakewhale (no TUI anywhere)");

  // whale → mac over the link, no TUI.
  const parent = await turn(whaleIpc, "openai", "gpt-6-astra", "RUN_CLIENT:: echo side=$EXO_E2E_SIDE");
  assert.match(parent.text, /tool said: side=mac/);
  log(`✓ whale conversation: client_bash ran on the mac's daemon over the link (${parent.seconds.toFixed(1)}s)`);
  const sub = await turn(whaleIpc, "openai", "gpt-6-astra", "RUN_CLIENT:: echo side=$EXO_E2E_SIDE", { subagent: true });
  assert.match(sub.text, /tool said: side=mac/);
  log("✓ whale subagent: client_bash ran on the mac too");

  // mac → whale with remote_bash, conversation and subagent.
  const remote = await turn(macIpc, "anthropic", "claude-haiku-5-5", "RUN_REMOTE:: echo side=$EXO_E2E_SIDE");
  assert.match(remote.text, /tool said: side=whale/);
  log(`✓ mac conversation: remote_bash ran on whale (${remote.seconds.toFixed(1)}s)`);
  const remoteSub = await turn(macIpc, "anthropic", "claude-haiku-5-5", "RUN_REMOTE:: echo side=$EXO_E2E_SIDE", { subagent: true });
  assert.match(remoteSub.text, /tool said: side=whale/);
  log("✓ mac subagent: remote_bash ran on whale too");

  // Long commands outlive the 15 s acknowledgement window on heartbeats.
  const [longClient, longRemote] = await Promise.all([
    turn(whaleIpc, "openai", "gpt-6-astra", "RUN_CLIENT:: sleep 25; echo long-done side=$EXO_E2E_SIDE TIMEOUT:: 120", { timeoutMs: 180_000 }),
    turn(macIpc, "anthropic", "claude-haiku-5-5", "RUN_REMOTE:: sleep 25; echo long-done side=$EXO_E2E_SIDE TIMEOUT:: 120", { timeoutMs: 180_000 }),
  ]);
  assert.match(longClient.text, /tool said: long-done side=mac/);
  assert.match(longRemote.text, /tool said: long-done side=whale/);
  log(`✓ 25 s commands both ways stay alive on heartbeats (${longClient.seconds.toFixed(0)}s / ${longRemote.seconds.toFixed(0)}s)`);

  // A frozen mac daemon (its link still open): whale's call fails in ~15 s, not after its 600 s timeout.
  mac.child.kill("SIGSTOP");
  const frozen = await turn(whaleIpc, "openai", "gpt-6-astra", "RUN_CLIENT:: echo side=$EXO_E2E_SIDE");
  mac.child.kill("SIGCONT");
  assert.match(frozen.text, /its Exocortex daemon's \/proxy link\) did not respond within 15s/);
  assert.ok(frozen.seconds < 30, `took ${frozen.seconds}s`);
  log(`✓ frozen mac daemon: client_bash fails after ${frozen.seconds.toFixed(0)}s (${frozen.text.replace(/^.*tool said: /s, "").slice(0, 90)}…)`);
  const thawed = await turn(whaleIpc, "openai", "gpt-6-astra", "RUN_CLIENT:: echo side=$EXO_E2E_SIDE");
  assert.match(thawed.text, /tool said: side=mac/);
  log("✓ thawed: the link answers again");

  // A TUI over /ssh as well: the daemon link is still preferred.
  const tuiState = { frozen: false };
  const tui = await fakeTui(whale.socket, tuiState);
  const both = await turn(whaleIpc, "openai", "gpt-6-astra", "RUN_CLIENT:: echo side=$EXO_E2E_SIDE");
  assert.match(both.text, /tool said: side=mac\b/);
  assert.equal(tui.ran.length, 0);
  log("✓ link and TUI both connected: the daemon link is used");

  // Link down: the TUI takes over.
  const off = await macIpc.request({ type: "provider_proxy", action: "off", provider: "anthropic" });
  assert.ok(!off.error, off.message);
  await Bun.sleep(500);
  const viaTui = await turn(whaleIpc, "openai", "gpt-6-astra", "RUN_CLIENT:: echo side=$EXO_E2E_SIDE");
  assert.match(viaTui.text, /tool said: side=mac-tui/);
  log("✓ link down: client_bash falls back to the TUI");

  // A frozen TUI fails fast too.
  tuiState.frozen = true;
  const frozenTui = await turn(whaleIpc, "openai", "gpt-6-astra", "RUN_CLIENT:: echo side=$EXO_E2E_SIDE");
  assert.match(frozenTui.text, /its TUI over \/ssh\) did not respond within 15s/);
  assert.ok(frozenTui.seconds < 30, `took ${frozenTui.seconds}s`);
  log(`✓ frozen TUI: client_bash fails after ${frozenTui.seconds.toFixed(0)}s`);
  tuiState.frozen = false;

  // TUI closed and link down: fails at once.
  tui.ipc.close();
  await Bun.sleep(300);
  const nothing = await turn(whaleIpc, "openai", "gpt-6-astra", "RUN_CLIENT:: echo side=$EXO_E2E_SIDE");
  assert.match(nothing.text, /The user's machine is not connected/);
  assert.ok(nothing.seconds < 10, `took ${nothing.seconds}s`);
  log(`✓ TUI closed and link down: fails at once (${nothing.seconds.toFixed(1)}s turn)`);

  // Relinked: back on the daemon.
  const relinked = await macIpc.request({ type: "provider_proxy", action: "set", provider: "anthropic", alias: "fakewhale" });
  assert.ok(!relinked.error, relinked.message);
  const back = await turn(whaleIpc, "openai", "gpt-6-astra", "RUN_CLIENT:: echo side=$EXO_E2E_SIDE");
  assert.match(back.text, /tool said: side=mac\b/);
  log("✓ relinked: client_bash runs over the link again");

  whaleIpc.close();
  macIpc.close();
  console.log("PASS: client-exec e2e");
} catch (error) {
  failed = true;
  console.error("FAIL:", error instanceof Error ? error.stack ?? error.message : error);
  console.error(`  logs in ${work}`);
} finally {
  for (const child of children) {
    try { child.kill("SIGCONT"); } catch { /* gone */ }
    child.kill();
  }
  await Promise.all(children.map(child => child.exited));
  mock.stop(true);
  if (!KEEP && !failed) rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
